import { Context, Service, HTTP } from 'koishi'
import { Config } from './index'
import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'

export interface SearchResult {
  id: string
  name: string
  artist: string
  album: string
  duration: number
  fee: number // 0=免费 1=VIP 4=购买专辑 8=限免
}

export interface SongUrl {
  id: string
  url: string
  br: number
  size: number
  md5: string
  type: string
}

export class NcmService extends Service {
  private cookieStore: Record<string, string> = {}
  private http: HTTP
  
  constructor(ctx: Context, public config: Config) {
    super(ctx, 'ncm', true)
    this.http = ctx.http.extend({
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://music.163.com',
      }
    })
    this.loadCookies()
  }

  // 加载cookie配置
  private loadCookies() {
    if (!this.config.cookie) return
    
    try {
      // 支持JSON格式或字符串格式
      if (this.config.cookie.trim().startsWith('[') || this.config.cookie.trim().startsWith('{')) {
        const cookies = JSON.parse(this.config.cookie)
        if (Array.isArray(cookies)) {
          cookies.forEach(c => {
            this.cookieStore[c.name] = c.value
          })
        } else {
          Object.assign(this.cookieStore, cookies)
        }
      } else {
        // 简单的key=value格式
        this.config.cookie.split(';').forEach(pair => {
          const [key, value] = pair.trim().split('=')
          if (key && value) this.cookieStore[key] = value
        })
      }
    } catch (e) {
      this.ctx.logger('ncm').warn('Cookie解析失败:', e)
    }
  }

  // 获取Cookie字符串
  private getCookieString(): string {
    return Object.entries(this.cookieStore).map(([k, v]) => `${k}=${v}`).join('; ')
  }

  private unwrapJsonResponse<T>(response: any): T {
    const data = response && typeof response === 'object' && 'data' in response ? response.data : response
    if (typeof data === 'string') {
      try {
        return JSON.parse(data) as T
      } catch {
        // fallthrough
      }
    }
    return data as T
  }

  // WEAPI加密
  private weapi(params: any): string {
    const text = JSON.stringify(params)
    const secKey = Array.from({ length: 16 }, () => 
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]
    ).join('')
    
    const encText = this.aesEncrypt(this.aesEncrypt(text, '0CoJUm6Qyw8W8jud'), secKey)
    const encSecKey = this.rsaEncrypt(secKey)
    
    return `params=${encodeURIComponent(encText)}&encSecKey=${encodeURIComponent(encSecKey)}`
  }

  private aesEncrypt(text: string, key: string): string {
    const cipher = crypto.createCipheriv('aes-128-cbc', key, '0102030405060708')
    return cipher.update(text, 'utf8', 'base64') + cipher.final('base64')
  }

  private rsaEncrypt(text: string): string {
    const reversed = text.split('').reverse().join('')
    const hex = Buffer.from(reversed).toString('hex')
    const bi = BigInt('0x' + hex)
    const modulus = BigInt('0x00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7')
    const exponent = BigInt('0x010001')
    const encrypted = this.powMod(bi, exponent, modulus)
    return encrypted.toString(16).padStart(256, '0')
  }

  private powMod(base: bigint, exp: bigint, mod: bigint): bigint {
    let result = BigInt(1)
    base = base % mod
    while (exp > 0) {
      if (exp % BigInt(2) === BigInt(1)) {
        result = (result * base) % mod
      }
      exp = exp / BigInt(2)
      base = (base * base) % mod
    }
    return result
  }

  // 搜索音乐
  async searchMusic(keyword: string, limit: number = 30, offset: number = 0): Promise<SearchResult[]> {
    const params = {
      s: keyword,
      type: 1,
      limit,
      offset
    }

    try {
      const cookie = this.getCookieString()
      const body = this.weapi(params)
      
      const raw = await this.http.post('https://music.163.com/weapi/cloudsearch/get/web', body, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(cookie ? { 'Cookie': cookie } : {})
        }
      })

      const response = this.unwrapJsonResponse<any>(raw)

      this.ctx.logger('ncm').debug('搜索响应:', JSON.stringify(response).substring(0, 500))

      if (!response || typeof response !== 'object') {
        const preview = typeof response === 'string' ? response.slice(0, 200) : String(response)
        throw new Error(`搜索失败: 响应格式异常 (${typeof response}) ${preview}`)
      }

      if (response.code !== 200) {
        throw new Error(`搜索失败: ${response.message || response.msg || 'code=' + response.code}`)
      }

      const songs = response.result?.songs || []
      return songs.map((song: any) => ({
        id: String(song.id),
        name: song.name,
        artist: song.ar?.map((a: any) => a.name).join('/') || '未知艺术家',
        album: song.al?.name || '未知专辑',
        duration: song.dt,
        fee: song.fee || 0
      }))
    } catch (error) {
      this.ctx.logger('ncm').error('搜索失败:', error)
      throw error
    }
  }

  // 获取歌曲播放URL
  async getSongUrl(id: string, br: number = 320000): Promise<SongUrl | null> {
    const params = {
      ids: `[${id}]`,
      br,
      csrf_token: this.cookieStore['__csrf'] || ''
    }

    try {
      const cookie = this.getCookieString()
      const body = this.weapi(params)
      
      const raw = await this.http.post('https://music.163.com/weapi/song/enhance/player/url', body, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(cookie ? { 'Cookie': cookie } : {})
        }
      })

      const response = this.unwrapJsonResponse<any>(raw)

      this.ctx.logger('ncm').debug('获取URL响应:', JSON.stringify(response).substring(0, 500))

      if (!response || typeof response !== 'object') {
        const preview = typeof response === 'string' ? response.slice(0, 200) : String(response)
        throw new Error(`获取URL失败: 响应格式异常 (${typeof response}) ${preview}`)
      }

      if (response.code !== 200) {
        throw new Error(`获取URL失败: ${response.message || response.msg || 'code=' + response.code}`)
      }

      const data = response.data?.[0]
      if (!data || !data.url) {
        return null
      }

      return {
        id: String(data.id),
        url: data.url,
        br: data.br,
        size: data.size,
        md5: data.md5,
        type: data.type
      }
    } catch (error) {
      this.ctx.logger('ncm').error('获取URL失败:', error)
      throw error
    }
  }

  // 下载歌曲
  async downloadSong(url: string, savePath: string): Promise<void> {
    try {
      const response = await this.http.get(url, { 
        responseType: 'arraybuffer',
        timeout: 60000 
      })
      
      await fs.mkdir(path.dirname(savePath), { recursive: true })
      await fs.writeFile(savePath, Buffer.from(response))
    } catch (error) {
      this.ctx.logger('ncm').error('下载失败:', error)
      throw error
    }
  }

  // 格式化时长
  formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${minutes}:${secs.toString().padStart(2, '0')}`
  }

  // 获取VIP标识
  getFeeTag(fee: number): string {
    switch (fee) {
      case 1: return '[VIP]'
      case 4: return '[购买]'
      case 8: return '[限免]'
      default: return ''
    }
  }
}
