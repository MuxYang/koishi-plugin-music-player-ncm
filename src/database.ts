export interface MusicCache {
  id: string // 歌曲ID
  name: string // 歌曲名称
  artist: string // 艺术家
  url: string // 直链URL
  cached: boolean // 是否已缓存到本地
  cachePath?: string // 缓存文件路径
  fileSize?: number // 文件大小（字节）
  cacheTime?: number // 缓存时间戳
  bitrate: number // 比特率
}

declare module 'koishi' {
  interface Tables {
    ncm_cache: MusicCache
  }
}
