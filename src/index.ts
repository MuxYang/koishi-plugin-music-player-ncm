import { Context, Schema, Logger, Session, h } from 'koishi'
import { NcmService } from './service'
import { MusicCache } from './database'
import zhCN from './locales/zh-CN'
import * as fs from 'fs/promises'
import * as path from 'path'
import { pathToFileURL } from 'url'

export const name = 'music-player-ncm'
export const inject = ['database', 'http', 'i18n']
// 仅用于声明本插件会提供 ncm 服务（若运行环境/加载器读取该导出）
export const service = 'ncm'

export interface Config {
  cookie: string
  bitrate: number
  searchTimeout: number
  searchPageSize: number
  mergeSearchResults: boolean
  sendFormat: 'file' | 'audio'
  rateLimitEnabled: boolean
  rateLimitInterval: number
  rateLimitGlobal: boolean
  cacheMaxSize: number
  cachePath: string
}

export const Config: Schema<Config> = Schema.object({
  cookie: Schema.string().role('textarea').description('网易云音乐Cookie（JSON格式或字符串格式）'),
  bitrate: Schema.number().default(320000).description('音频码率（单位：bps）'),
  searchTimeout: Schema.number().default(30).description('搜索超时时间（秒）'),
  searchPageSize: Schema.number().default(5).min(1).max(20).description('搜索结果每页显示数量'),
  mergeSearchResults: Schema.boolean().default(false).description('合并发送搜索结果列表'),
  sendFormat: Schema.union([
    Schema.const('file').description('文件（h.file，发送为文件消息）'),
    Schema.const('audio').description('语音/音频（h.audio，发送为语音/音频消息）'),
  ]).role('radio').default('file').description('歌曲发送格式'),
  rateLimitEnabled: Schema.boolean().default(true).description('启用频率限制'),
  rateLimitInterval: Schema.number().default(2).description('调用间隔（秒）'),
  rateLimitGlobal: Schema.boolean().default(true).description('全局频率限制（关闭则为单会话限制）'),
  cacheMaxSize: Schema.number().default(1024).description('缓存最大容量（MB）'),
  cachePath: Schema.string().default('data/ncm-cache').description('缓存文件夹路径'),
})

export const logger = new Logger('music-player-ncm')

declare module 'koishi' {
  interface Context {
    ncm: NcmService
  }
}

interface SearchSession {
  results: any[]
  timeout: NodeJS.Timeout
  sendFormat?: 'file' | 'audio'
}

export function apply(ctx: Context, config: Config) {
  // 本地化
  ctx.i18n.define('zh-CN', zhCN)
  ctx.i18n.define('zh', zhCN)

  // 显式初始化服务实例。
  // 说明：不同 Koishi 运行环境/打包方式下，直接依赖 ctx.ncm 可能触发“未注册属性”告警。
  // 这里统一使用实例变量 ncm，确保功能稳定。
  const ncm = new NcmService(ctx, config)

  // 数据库模型
  ctx.model.extend('ncm_cache', {
    id: 'string',
    name: 'string',
    artist: 'string',
    url: 'string',
    cached: 'boolean',
    cachePath: 'string',
    fileSize: 'unsigned',
    cacheTime: 'unsigned',
    bitrate: 'unsigned',
  }, {
    primary: 'id',
  })

  // 搜索会话管理
  const searchSessions = new Map<string, SearchSession>()
  
  // 频率限制记录
  const rateLimitMap = new Map<string, number>()

  // 检查频率限制
  function checkRateLimit(session: Session): boolean {
    if (!config.rateLimitEnabled) return true
    
    const key = config.rateLimitGlobal ? 'global' : `${session.platform}:${session.channelId || session.userId}`
    const now = Date.now()
    const lastCall = rateLimitMap.get(key) || 0
    
    if (now - lastCall < config.rateLimitInterval * 1000) {
      return false
    }
    
    rateLimitMap.set(key, now)
    return true
  }

  // 获取会话键
  function getSessionKey(session: Session): string {
    return `${session.platform}:${session.channelId || session.userId}:${session.userId}`
  }

  // 清理搜索会话
  function clearSearchSession(sessionKey: string) {
    const session = searchSessions.get(sessionKey)
    if (session) {
      clearTimeout(session.timeout)
      searchSessions.delete(sessionKey)
    }
  }

  // 计算缓存总大小
  async function getCacheTotalSize(): Promise<number> {
    try {
      const caches = await ctx.database.get('ncm_cache', { cached: true })
      return caches.reduce((sum, c) => sum + (c.fileSize || 0), 0)
    } catch {
      return 0
    }
  }

  // 清理旧缓存
  async function cleanOldCache(requiredSpace: number) {
    const maxBytes = config.cacheMaxSize * 1024 * 1024
    const currentSize = await getCacheTotalSize()
    
    if (currentSize + requiredSpace <= maxBytes) return
    
    // 按缓存时间排序，删除最旧的
    const caches = await ctx.database.get('ncm_cache', { cached: true })
    caches.sort((a, b) => (a.cacheTime || 0) - (b.cacheTime || 0))
    
    let freedSpace = 0
    for (const cache of caches) {
      if (currentSize - freedSpace + requiredSpace <= maxBytes) break
      
      try {
        if (cache.cachePath) {
          await fs.unlink(cache.cachePath)
        }
        await ctx.database.set('ncm_cache', { id: cache.id }, { 
          cached: false, 
          cachePath: null,
          fileSize: 0
        })
        freedSpace += cache.fileSize || 0
      } catch (e) {
        logger.warn(`清理缓存失败: ${cache.id}`, e)
      }
    }
  }

  // 注册命令
  ctx.command('ncmget <keyword:text>', '获取网易云音乐')
    .alias('网易云')
    .option('audio', '-a 以语音/音频格式发送（h.audio）')
    .option('file', '-f 以文件格式发送（h.file）')
    .action(async ({ session, options }, keyword) => {
      if (!session || !keyword) return session?.text('commands.ncmget.messages.no-keyword')
      
      // 检查服务是否可用
      if (!ncm) {
        logger.error('NCM服务未就绪')
        return session.text('commands.ncmget.messages.search-error')
      }
      
      // 频率限制检查
      if (!checkRateLimit(session)) {
        return // 静默返回
      }

      const sessionKey = getSessionKey(session)

      // 强制发送格式（仅本次点歌有效；用于“ncmget xxx -a/-f”以及后续回复数字选择）
      const forcedSendFormat: Config['sendFormat'] | undefined = (() => {
        if (!options) return
        if ((options as any).audio) return 'audio'
        if ((options as any).file) return 'file'
      })()
      
      try {
        // 搜索音乐
        const results = await ncm.searchMusic(keyword, config.searchPageSize)
        
        if (!results || results.length === 0) {
          return session.text('commands.ncmget.messages.no-results')
        }

        // 只有一个结果，直接获取
        if (results.length === 1) {
          await handleSongRequest(session, results[0], forcedSendFormat)
          return
        }

        // 多个结果，进入搜索模式
        const resultText = results.map((song, idx) =>
          `${idx + 1}. ${song.name} - ${song.artist} ${ncm.getFeeTag(song.fee)} [${ncm.formatDuration(song.duration)}]`
        ).join('\n')

        // 这里统一发送纯文本，避免不同适配器对 message/forward 的兼容差异
        const searchText = config.mergeSearchResults
          ? session.text('commands.ncmget.messages.search-results', [resultText])
          : `${session.text('commands.ncmget.messages.search-prompt')}\n${resultText}`

        // 注意：这里不要 return session.send(...)，否则适配器返回的 messageId 可能会被当作文本再次发出
        await session.send(searchText)

        // 保存搜索会话
        const timeout = setTimeout(() => {
          clearSearchSession(sessionKey)
        }, config.searchTimeout * 1000)

        searchSessions.set(sessionKey, {
          results,
          timeout,
          sendFormat: forcedSendFormat,
        })

      } catch (error) {
        logger.error('搜索失败:', error)
        return session.text('commands.ncmget.messages.search-error')
      }
    })

  // 监听用户选择
  ctx.middleware(async (session, next) => {
    const sessionKey = getSessionKey(session)
    const searchSession = searchSessions.get(sessionKey)
    
    if (!searchSession) return next()

    const input = session.stripped?.content?.trim() ?? session.content?.trim()
    if (!input || !/^\d+$/.test(input)) return next()

    const index = parseInt(input) - 1

    // 退出搜索
    if (index === -1) {
      clearSearchSession(sessionKey)
      await session.send(session.text('commands.ncmget.messages.search-cancelled'))
      return
    }

    // 选择歌曲
    if (index >= 0 && index < searchSession.results.length) {
      clearSearchSession(sessionKey)
      
      await handleSongRequest(session, searchSession.results[index], searchSession.sendFormat)
      return
    }

    return next()
  })

  // 处理歌曲请求
  async function handleSongRequest(session: Session, song: any, sendFormatOverride?: Config['sendFormat']) {
    try {
      // 查询数据库缓存
      let cache = await ctx.database.get('ncm_cache', { id: song.id })
      let cacheEntry: MusicCache | undefined = cache[0]

      // 检查本地文件是否存在
      if (cacheEntry?.cached && cacheEntry.cachePath) {
        try {
          await fs.access(cacheEntry.cachePath)
          // 文件存在，直接发送
          await sendCachedSong(session, cacheEntry, sendFormatOverride)
          return
        } catch {
          // 文件不存在，更新数据库
          await ctx.database.set('ncm_cache', { id: song.id }, { 
            cached: false, 
            cachePath: null 
          })
          cacheEntry = undefined
        }
      }

      // 获取歌曲URL
      const urlInfo = await ncm.getSongUrl(song.id, config.bitrate)
      
      if (!urlInfo || !urlInfo.url) {
        await session.send(session.text('commands.ncmget.messages.song-unavailable'))
        return
      }

      // 下载歌曲
      const filename = `${song.artist} - ${song.name}.mp3`
        .replace(/[<>:"/\\|?*]/g, '_') // 移除非法字符
      const savePath = path.join(config.cachePath, `${song.id}.mp3`)

      // 下载提示无需向上 return，避免把 messageId 当作文本发出
      await session.send(session.text('commands.ncmget.messages.downloading'))

      // 检查并清理缓存空间
      await cleanOldCache(urlInfo.size)

      await ncm.downloadSong(urlInfo.url, savePath)

      // 更新或创建缓存记录
      const cacheData: Partial<MusicCache> = {
        id: song.id,
        name: song.name,
        artist: song.artist,
        url: urlInfo.url,
        cached: true,
        cachePath: savePath,
        fileSize: urlInfo.size,
        cacheTime: Date.now(),
        bitrate: urlInfo.br,
      }

      if (cacheEntry) {
        await ctx.database.set('ncm_cache', { id: song.id }, cacheData)
      } else {
        await ctx.database.create('ncm_cache', cacheData as MusicCache)
      }

      // 发送歌曲
      await sendCachedSong(session, cacheData as MusicCache, sendFormatOverride)
      return

    } catch (error) {
      logger.error('获取歌曲失败:', error)
      await session.send(session.text('commands.ncmget.messages.download-error'))
      return
    }
  }

  // 发送缓存的歌曲
  async function sendCachedSong(session: Session, cache: MusicCache, sendFormatOverride?: Config['sendFormat']) {
    try {
      if (!cache.cachePath) {
        throw new Error('缓存路径不存在')
      }

      const filename = `${cache.artist} - ${cache.name}.mp3`
      const fileUrl = pathToFileURL(cache.cachePath).href

      // OneBot 场景下，file:// 路径可能位于 Koishi 容器而非 OneBot 容器，导致发送失败。
      // 因此在检测到 onebot 会话时，优先使用 base64:// 直传内容，保证文件/语音都能发出。
      const hasOneBot = !!(session as any).onebot
      const src = hasOneBot
        ? `base64://${(await fs.readFile(cache.cachePath)).toString('base64')}`
        : fileUrl

      const format = sendFormatOverride ?? config.sendFormat

      if (format === 'audio') {
        await session.send(h.audio(src, { title: filename }))
        return
      }

      await session.send(h.file(src, { title: filename }))
      return
    } catch (error) {
      logger.error('发送歌曲失败:', error)
      await session.send(session.text('commands.ncmget.messages.send-error'))
      return
    }
  }
}
