import { Context, Schema, Logger, Session, h } from 'koishi'
import { NcmService } from './service'
import { MusicCache } from './database'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'
import * as fs from 'fs/promises'
import * as path from 'path'
import { pathToFileURL } from 'url'

export const name = 'music-player-ncm'
export const inject = {
  required: ['database', 'http', 'i18n'],
  optional: ['ffmpeg'],
}

interface FFmpegBuilder {
  input(path: string): FFmpegBuilder
  inputOption(...option: string[]): FFmpegBuilder
  outputOption(...option: string[]): FFmpegBuilder
  run(type: 'file', path: string): Promise<void>
  run(type: 'buffer'): Promise<Buffer>
}

interface FFmpegService {
  builder(): FFmpegBuilder
}

declare module 'koishi' {
  interface Context {
    ncm: NcmService
    ffmpeg: FFmpegService
  }
}

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
  cookie: Schema.string().role('secret').description('网易云音乐 Cookie'),
  bitrate: Schema.number().default(320000).description('音频码率 (bps)'),
  searchTimeout: Schema.number().default(30).description('搜索超时时间 (秒)'),
  searchPageSize: Schema.number().default(5).min(1).max(20).description('搜索结果数量'),
  mergeSearchResults: Schema.boolean().default(false).description('合并发送搜索结果'),
  sendFormat: Schema.union([
    Schema.const('file').description('文件'),
    Schema.const('audio').description('语音/音频'),
  ]).role('radio').default('file').description('发送格式'),
  rateLimitEnabled: Schema.boolean().default(true).description('启用频率限制'),
  rateLimitInterval: Schema.number().default(2).description('调用间隔 (秒)'),
  rateLimitGlobal: Schema.boolean().default(true).description('全局频率限制'),
  cacheMaxSize: Schema.number().default(1024).description('缓存容量上限 (MB)'),
  cachePath: Schema.string().default('data/ncm-cache').description('缓存路径'),
})

export const logger = new Logger('music-player-ncm')

interface SearchSession {
  results: any[]
  timeout: NodeJS.Timeout
  sendFormat?: 'file' | 'audio'
  compress?: boolean
}

const KNOWN_FLAGS = new Set(['a', 'f', 'z'])

/** 自定义参数预处理：支持中英文引号，未知参数并入歌名 */
function parseArgs(raw: string): {
  keyword: string
  options: { audio?: boolean; file?: boolean; compress?: boolean }
} {
  const options: { audio?: boolean; file?: boolean; compress?: boolean } = {}
  const parts: string[] = []
  let i = 0
  const quoteMap: Record<string, string> = {
    '"': '"', "'": "'", '\u201c': '\u201d', '\u2018': '\u2019',
  }

  while (i < raw.length) {
    if (/\s/.test(raw[i])) { i++; continue }

    // 引号包裹
    if (raw[i] in quoteMap) {
      const close = quoteMap[raw[i]]
      const start = i + 1
      const end = raw.indexOf(close, start)
      if (end !== -1) {
        parts.push(raw.slice(start, end))
        i = end + 1
        continue
      }
    }

    // 短选项（支持组合，如 -af）
    if (raw[i] === '-' && i + 1 < raw.length && /[a-zA-Z]/.test(raw[i + 1])) {
      let j = i + 1
      while (j < raw.length && /[a-zA-Z]/.test(raw[j])) j++
      if (j >= raw.length || /\s/.test(raw[j])) {
        const chars = raw.slice(i + 1, j)
        if ([...chars].every(c => KNOWN_FLAGS.has(c))) {
          for (const c of chars) {
            if (c === 'a') options.audio = true
            if (c === 'f') options.file = true
            if (c === 'z') options.compress = true
          }
          i = j
          continue
        }
        // 未知选项整体当作歌名
        parts.push(raw.slice(i, j))
        i = j
        continue
      }
    }

    // 普通 token
    let j = i
    while (j < raw.length && !/\s/.test(raw[j])) j++
    parts.push(raw.slice(i, j))
    i = j
  }

  return { keyword: parts.join(' '), options }
}

function sanitizeFilename(name: string): string {
  if (!name) return 'file'
  name = name.normalize('NFKD')
  name = name.replace(/[\\/:*?"<>|]/g, '-')
  name = name.replace(/[\x00-\x1f\x7f]/g, '')
  name = name.replace(/\s+/g, ' ').trim()
  if (name.length > 120) name = name.slice(0, 120).trim()
  return name || 'file'
}

export function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh-CN', zhCN)
  ctx.i18n.define('zh', zhCN)
  ctx.i18n.define('en-US', enUS)
  ctx.i18n.define('en', enUS)

  const ncm = new NcmService(ctx, config)

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
  }, { primary: 'id' })

  const searchSessions = new Map<string, SearchSession>()
  const rateLimitMap = new Map<string, number>()
  const downloadLocks = new Set<string>()

  const rateLimitCleanupInterval = setInterval(() => {
    const now = Date.now()
    const expiry = config.rateLimitInterval * 1000 * 10
    for (const [key, time] of rateLimitMap) {
      if (now - time > expiry) rateLimitMap.delete(key)
    }
  }, 5 * 60 * 1000)

  ctx.on('dispose', () => {
    clearInterval(rateLimitCleanupInterval)
    for (const [, session] of searchSessions) {
      clearTimeout(session.timeout)
    }
    searchSessions.clear()
  })

  function checkRateLimit(session: Session): boolean {
    if (!config.rateLimitEnabled) return true
    const key = config.rateLimitGlobal ? 'global' : `${session.platform}:${session.channelId || session.userId}`
    const now = Date.now()
    const lastCall = rateLimitMap.get(key) || 0
    if (now - lastCall < config.rateLimitInterval * 1000) return false
    rateLimitMap.set(key, now)
    return true
  }

  function getSessionKey(session: Session): string {
    return `${session.platform}:${session.channelId || session.userId}:${session.userId}`
  }

  function clearSearchSession(sessionKey: string) {
    const session = searchSessions.get(sessionKey)
    if (session) {
      clearTimeout(session.timeout)
      searchSessions.delete(sessionKey)
    }
  }

  async function getCacheTotalSize(): Promise<number> {
    try {
      const caches = await ctx.database.get('ncm_cache', { cached: true })
      return caches.reduce((sum, c) => sum + (c.fileSize || 0), 0)
    } catch {
      return 0
    }
  }

  async function cleanOldCache(requiredSpace: number) {
    const maxBytes = config.cacheMaxSize * 1024 * 1024
    const currentSize = await getCacheTotalSize()
    if (currentSize + requiredSpace <= maxBytes) return

    const caches = await ctx.database.get('ncm_cache', { cached: true })
    caches.sort((a, b) => (a.cacheTime || 0) - (b.cacheTime || 0))

    let freedSpace = 0
    for (const cache of caches) {
      if (currentSize - freedSpace + requiredSpace <= maxBytes) break
      try {
        if (cache.cachePath) await fs.unlink(cache.cachePath)
        await ctx.database.set('ncm_cache', { id: cache.id }, {
          cached: false, cachePath: null, fileSize: 0,
        })
        freedSpace += cache.fileSize || 0
      } catch (e) {
        logger.warn(`清理缓存失败: ${cache.id}`, e)
      }
    }
  }

  async function compressAudio(inputPath: string, outputPath: string): Promise<void> {
    await ctx.ffmpeg.builder()
      .input(inputPath)
      .outputOption('-b:a', '8k', '-ar', '8000', '-ac', '1', '-af', 'volume=30dB')
      .run('file', outputPath)
  }

  // --- 命令注册 ---

  ctx.command('ncmget <keyword:text>', '获取网易云音乐')
    .alias('网易云')
    .option('audio', '-a 以语音格式发送')
    .option('file', '-f 以文件格式发送')
    .option('compress', '-z 压缩音频并以语音发送')
    .action(async ({ session, options }, keyword) => {
      if (!session || !keyword) return session?.text('commands.ncmget.messages.no-keyword')
      if (!ncm) {
        logger.error('NCM 服务未就绪')
        return session.text('commands.ncmget.messages.search-error')
      }
      if (!checkRateLimit(session)) return

      const parsed = parseArgs(keyword)
      keyword = parsed.keyword
      if (!keyword) return session.text('commands.ncmget.messages.no-keyword')

      // 合并 parseArgs 解析出的选项
      if (parsed.options.audio) (options as any).audio = true
      if (parsed.options.file) (options as any).file = true
      if (parsed.options.compress) (options as any).compress = true

      const compress = !!(options as any).compress
      if (compress && !ctx.ffmpeg) {
        return session.text('commands.ncmget.messages.ffmpeg-missing')
      }

      const sessionKey = getSessionKey(session)
      const forcedSendFormat: Config['sendFormat'] | undefined = (() => {
        if (compress) return 'audio'
        if ((options as any).audio) return 'audio'
        if ((options as any).file) return 'file'
      })()

      try {
        const results = await ncm.searchMusic(keyword, config.searchPageSize)
        if (!results || results.length === 0) {
          return session.text('commands.ncmget.messages.no-results')
        }

        if (results.length === 1) {
          await handleSongRequest(session, results[0], forcedSendFormat, compress)
          return
        }

        const resultText = results.map((song, idx) =>
          `${idx + 1}. ${song.name} - ${song.artist} ${ncm.getFeeTag(song.fee)} [${ncm.formatDuration(song.duration)}]`
        ).join('\n')

        const searchText = config.mergeSearchResults
          ? session.text('commands.ncmget.messages.search-results', [resultText])
          : `${session.text('commands.ncmget.messages.search-prompt')}\n${resultText}`

        await session.send(searchText)

        const timeout = setTimeout(() => clearSearchSession(sessionKey), config.searchTimeout * 1000)
        searchSessions.set(sessionKey, { results, timeout, sendFormat: forcedSendFormat, compress })
      } catch (error) {
        logger.error('搜索失败:', error)
        return session.text('commands.ncmget.messages.search-error')
      }
    })

  // --- 用户选歌中间件 ---

  ctx.middleware(async (session, next) => {
    const sessionKey = getSessionKey(session)
    const searchSession = searchSessions.get(sessionKey)
    if (!searchSession) return next()

    const input = session.stripped?.content?.trim() ?? session.content?.trim()
    if (!input || !/^\d+$/.test(input)) return next()

    const index = parseInt(input) - 1

    if (index === -1) {
      clearSearchSession(sessionKey)
      await session.send(session.text('commands.ncmget.messages.search-cancelled'))
      return
    }

    if (index >= 0 && index < searchSession.results.length) {
      clearSearchSession(sessionKey)
      await handleSongRequest(session, searchSession.results[index], searchSession.sendFormat, searchSession.compress)
      return
    }

    return next()
  })

  // --- 歌曲处理 ---

  async function handleSongRequest(session: Session, song: any, sendFormatOverride?: Config['sendFormat'], compress?: boolean) {
    try {
      const cache = await ctx.database.get('ncm_cache', { id: song.id })
      let cacheEntry: MusicCache | undefined = cache[0]

      if (cacheEntry?.cached && cacheEntry.cachePath) {
        try {
          await fs.access(cacheEntry.cachePath)
          await sendCachedSong(session, cacheEntry, sendFormatOverride, compress)
          return
        } catch {
          await ctx.database.set('ncm_cache', { id: song.id }, { cached: false, cachePath: null })
          cacheEntry = undefined
        }
      }

      const urlInfo = await ncm.getSongUrl(song.id, config.bitrate)
      if (!urlInfo?.url) {
        await session.send(session.text('commands.ncmget.messages.song-unavailable'))
        return
      }

      const sanitizedId = String(song.id).replace(/[^a-zA-Z0-9-]/g, '')
      if (!sanitizedId) {
        logger.error('非法歌曲ID:', song.id)
        await session.send(session.text('commands.ncmget.messages.download-error'))
        return
      }

      if (downloadLocks.has(sanitizedId)) {
        await session.send(session.text('commands.ncmget.messages.downloading'))
        return
      }

      const savePath = path.resolve(config.cachePath, `${sanitizedId}.mp3`)
      if (!savePath.startsWith(path.resolve(config.cachePath))) {
        logger.error('路径安全检查失败:', savePath)
        await session.send(session.text('commands.ncmget.messages.download-error'))
        return
      }

      await session.send(session.text('commands.ncmget.messages.downloading'))
      downloadLocks.add(sanitizedId)

      try {
        await cleanOldCache(urlInfo.size)
        await ncm.downloadSong(urlInfo.url, savePath)

        const cacheData: Partial<MusicCache> = {
          id: song.id, name: song.name, artist: song.artist,
          url: urlInfo.url, cached: true, cachePath: savePath,
          fileSize: urlInfo.size, cacheTime: Date.now(), bitrate: urlInfo.br,
        }

        if (cacheEntry) {
          await ctx.database.set('ncm_cache', { id: song.id }, cacheData)
        } else {
          await ctx.database.create('ncm_cache', cacheData as MusicCache)
        }

        await sendCachedSong(session, cacheData as MusicCache, sendFormatOverride, compress)
      } catch (error) {
        logger.error('获取歌曲失败:', error)
        await session.send(session.text('commands.ncmget.messages.download-error'))
      } finally {
        downloadLocks.delete(sanitizedId)
      }
    } catch (error) {
      logger.error('处理歌曲请求异常:', error)
      await session.send(session.text('commands.ncmget.messages.download-error'))
    }
  }

  async function sendCachedSong(session: Session, cache: MusicCache, sendFormatOverride?: Config['sendFormat'], compress?: boolean) {
    try {
      if (!cache.cachePath) throw new Error('缓存路径不存在')

      const filename = `${sanitizeFilename(`${cache.artist} - ${cache.name}`)}.mp3`
      let filePath = cache.cachePath
      let compressedPath: string | undefined

      if (compress && ctx.ffmpeg) {
        try {
          await session.send(session.text('commands.ncmget.messages.compressing'))
          compressedPath = path.resolve(
            path.dirname(cache.cachePath),
            `${path.basename(cache.cachePath, '.mp3')}_compressed.mp3`,
          )
          await compressAudio(cache.cachePath, compressedPath)
          filePath = compressedPath
        } catch (error) {
          logger.warn('音频压缩失败:', error)
          await session.send(session.text('commands.ncmget.messages.compress-error'))
          compressedPath = undefined
        }
      }

      const fileUrl = pathToFileURL(filePath).href
      // OneBot 适配器中 file:// 可能不可达，使用 base64 直传
      const hasOneBot = !!(session as any).onebot
      const src = hasOneBot
        ? `base64://${(await fs.readFile(filePath)).toString('base64')}`
        : fileUrl

      const format = compress ? 'audio' : (sendFormatOverride ?? config.sendFormat)

      try {
        if (format === 'audio') {
          await session.send(h.audio(src, { title: filename }))
        } else {
          await session.send(h.file(src, { title: filename }))
        }
      } finally {
        if (compressedPath) {
          fs.unlink(compressedPath).catch(() => { })
        }
      }
    } catch (error) {
      logger.error('发送歌曲失败:', error)
      await session.send(session.text('commands.ncmget.messages.send-error'))
    }
  }
}
