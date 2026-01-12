# koishi-plugin-music-player-ncm

网易云音乐播放器插件，支持在聊天中搜索、下载并发送网易云音乐文件。

## 主要功能

    搜索网易云音乐并发送到聊天

## 安装

```bash
npm install koishi-plugin-music-player-ncm
# 或
yarn add koishi-plugin-music-player-ncm
```

## 指令

### ncmget `<歌名>`

别名：`网易云`

获取并发送指定的网易云音乐文件。

**使用示例：**
```
ncmget 晴天
网易云 周杰伦 七里香
```

**搜索流程：**
1. 输入歌名后，如果有多个结果，会显示搜索列表
2. 回复数字（如 `1`、`2`）选择对应歌曲
3. 回复 `0` 退出搜索
4. 超时未选择将自动取消（默认30秒）

该命令支持Koishi的所有过滤器和命令别名功能。

## 配置项

### 基础设置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `cookie` | string | - | 网易云音乐Cookie（支持VIP歌曲） |
| `bitrate` | number | 320000 | 音频码率（bps） |
| `cachePath` | string | data/ncm-cache | 缓存文件夹路径 |
| `cacheMaxSize` | number | 1024 | 缓存最大容量（MB） |

### 搜索设置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `searchTimeout` | number | 30 | 搜索超时时间（秒） |
| `searchPageSize` | number | 5 | 每页显示结果数量（1-20） |
| `mergeSearchResults` | boolean | false | 合并发送搜索结果 |

### 频率限制

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `rateLimitEnabled` | boolean | true | 启用频率限制 |
| `rateLimitInterval` | number | 2 | 调用间隔（秒） |
| `rateLimitGlobal` | boolean | true | 全局限制（false为单会话限制） |

## Cookie获取方法

要获取VIP权限的歌曲，需要配置网易云音乐的Cookie：

### 方法1：使用Cookie Editor插件（推荐）

1. 安装浏览器插件 [Cookie-Editor](https://cookie-editor.com/)
2. 在浏览器中访问 [music.163.com](https://music.163.com) 并登录你的VIP账号
3. 点击Cookie-Editor插件图标
4. 点击"导出" → 选择"JSON格式"
5. 复制导出的JSON内容
6. 在Koishi控制台中，将JSON粘贴到本插件的 `cookie` 配置项中

### 方法2：手动获取（简单格式）

1. 在浏览器中访问 [music.163.com](https://music.163.com) 并登录
2. 按 `F12` 打开开发者工具
3. 切换到"应用程序/Application"或"存储/Storage"标签
4. 左侧选择"Cookies" → "https://music.163.com"
5. 找到关键Cookie（如 `MUSIC_U`）并复制其值
6. 在配置项中填入格式：`MUSIC_U=你的cookie值`

### Cookie格式示例

**JSON格式：**
```json
[
  {"name": "MUSIC_U", "value": "your_music_u_value"},
  {"name": "__csrf", "value": "your_csrf_value"}
]
```

**字符串格式：**
```
MUSIC_U=your_value; __csrf=your_value
```

>  **注意事项：**
> - Cookie包含账号敏感信息，请勿泄露
> - Cookie有效期有限，失效后需重新获取
> - 本插件仅用于个人学习和合理使用，请勿用于商业用途
> - 使用本插件获取音乐时，请遵守网易云音乐的使用条款

## 缓存机制

插件会自动缓存已下载的歌曲文件，再次请求时直接从本地读取：

- 默认缓存容量：1GB
- 缓存策略：LRU（最近最少使用）滚动覆盖
- 缓存位置：`data/ncm-cache/`（可配置）
- 数据库记录：自动维护歌曲元信息

## 频率限制说明

### 全局限制（默认）
所有用户和群组共享调用频率限制，适合防止服务器负载过高。

### 单会话限制
每个群组或用户独立计算调用频率，互不影响。

**超出限制时：** 命令静默不响应（不会提示错误信息）

## 技术说明

本插件通过网易云音乐官方API获取歌曲信息和播放链接：

- 使用WEAPI加密方式请求
- 支持320kbps高品质音频
- 自动处理VIP权限验证
- 完整的错误处理机制

## 许可证

MIT License

## 免责声明

本插件仅供学习和个人使用，请勿用于商业用途。使用本插件时，请遵守网易云音乐的相关条款和版权法律法规。开发者不对因使用本插件产生的任何问题负责。
