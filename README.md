# koishi-plugin-music-player-ncm

网易云音乐播放器插件，支持在聊天中搜索、下载并发送网易云音乐。

## 安装

```bash
npm install koishi-plugin-music-player-ncm
```

## 指令

### ncmget `<歌名>`

别名：`网易云`

搜索并发送网易云音乐。

**参数：**

| 参数 | 说明 |
|------|------|
| `-a` | 以语音格式发送 |
| `-f` | 以文件格式发送 |
| `-z` | 压缩音频并以语音发送（需要 ffmpeg 服务） |

**使用示例：**
```
ncmget 晴天
网易云 周杰伦 七里香
ncmget -z 稻香
ncmget "歌名 带空格"
ncmget “中文引号也可以”
```

- `-z` 参数会将音频压缩至极低码率并提升 5dB 音量（产生削波），强制以语音格式发送
- 支持中英文引号包裹歌名（如歌名中包含空格）
- 未识别的参数（如 `-x`）会被当作歌名的一部分

**搜索流程：**
1. 输入歌名后，如有多个结果会显示列表
2. 回复数字选择歌曲
3. 回复 `0` 退出搜索
4. 超时未选择自动取消（默认 30 秒）

## 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `cookie` | string | - | 网易云音乐 Cookie |
| `bitrate` | number | 320000 | 音频码率 (bps) |
| `searchTimeout` | number | 30 | 搜索超时时间 (秒) |
| `searchPageSize` | number | 5 | 搜索结果数量 (1-20) |
| `mergeSearchResults` | boolean | false | 合并发送搜索结果 |
| `sendFormat` | radio | file | 发送格式 (file / audio) |
| `rateLimitEnabled` | boolean | true | 启用频率限制 |
| `rateLimitInterval` | number | 2 | 调用间隔 (秒) |
| `rateLimitGlobal` | boolean | true | 全局频率限制 |
| `cacheMaxSize` | number | 1024 | 缓存容量上限 (MB) |
| `cachePath` | string | data/ncm-cache | 缓存路径 |

## 服务依赖

- **database** (必需)
- **http** (必需)
- **i18n** (必需)
- **ffmpeg** (可选) - 使用 `-z` 压缩功能时需要

## Cookie 获取方法

配置 Cookie 后可获取 VIP 歌曲。

### 使用 Cookie Editor 插件

1. 安装 [Cookie-Editor](https://cookie-editor.com/)
2. 访问 [music.163.com](https://music.163.com) 并登录
3. 点击插件图标，导出为 JSON 格式
4. 粘贴到插件的 `cookie` 配置项中

### 手动获取

1. 访问 [music.163.com](https://music.163.com) 并登录
2. 按 `F12` 打开开发者工具
3. 在 Application > Cookies 中找到 `MUSIC_U` 并复制值
4. 配置项中填入：`MUSIC_U=你的值`

**Cookie 格式示例：**

JSON 格式：
```json
[
  {"name": "MUSIC_U", "value": "your_music_u_value"},
  {"name": "__csrf", "value": "your_csrf_value"}
]
```

字符串格式：
```
MUSIC_U=your_value; __csrf=your_value
```

> Cookie 包含账号敏感信息，请勿泄露。Cookie 有效期有限，失效后需重新获取。

## 缓存机制

插件自动缓存已下载的歌曲，再次请求时从本地读取：

- 默认容量 1GB，按 LRU 策略滚动覆盖
- 默认位置 `data/ncm-cache/`（可配置）
- 数据库自动维护歌曲元信息

## 许可证

MIT License

## 免责声明

本插件仅供学习和个人使用。使用时请遵守网易云音乐的相关条款和版权法律法规。开发者不对因使用本插件产生的任何问题负责。
