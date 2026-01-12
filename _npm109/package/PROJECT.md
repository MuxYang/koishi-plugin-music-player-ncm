# 项目结构说明

## 已创建的文件

### 核心代码文件
```
src/
├── index.ts           # 主入口文件，包含插件配置、命令注册和核心逻辑
├── service.ts         # 网易云音乐API服务封装（WEAPI加密、搜索、获取直链）
├── database.ts        # 数据库模型定义（歌曲缓存记录）
└── locales/
    ├── zh-CN.ts       # 中文本地化（TS格式）
    └── zh-CN.yml      # 中文本地化（YAML格式）
```

### 配置文件
- `package.json` - NPM包配置
- `tsconfig.json` - TypeScript编译配置
- `.gitignore` - Git忽略文件配置

### 文档文件
- `README.md` - 用户文档（功能说明、安装指南、配置说明、Cookie获取方法）
- `LICENSE` - MIT开源许可证

## 功能实现清单

### ✅ 已实现的核心功能

1. **搜索与播放**
   - ✅ 网易云音乐搜索功能
   - ✅ 多结果交互式选择
   - ✅ 单一结果直接获取
   - ✅ 搜索超时机制（可配置）
   - ✅ 退出搜索功能（回复0）

2. **缓存机制**
   - ✅ 本地文件缓存
   - ✅ 数据库元信息存储
   - ✅ LRU缓存清理策略
   - ✅ 缓存容量限制（可配置）
   - ✅ 智能缓存验证（文件存在性检查）

3. **频率限制**
   - ✅ 全局频率限制
   - ✅ 单会话频率限制
   - ✅ 可配置调用间隔
   - ✅ 静默超限处理

4. **VIP支持**
   - ✅ Cookie配置支持
   - ✅ JSON格式Cookie解析
   - ✅ 字符串格式Cookie解析
   - ✅ VIP歌曲直链获取
   - ✅ WEAPI加密实现

5. **用户体验**
   - ✅ i18n国际化支持
   - ✅ 详细的错误提示
   - ✅ 进度反馈（下载中提示）
   - ✅ 搜索结果合并发送选项
   - ✅ 命令别名支持

6. **技术特性**
   - ✅ TypeScript类型安全
   - ✅ 完整的错误处理
   - ✅ 数据库集成
   - ✅ Koishi标准插件结构
   - ✅ 代码结构清晰，易维护

## 配置项说明

所有配置项均可在Koishi控制台中直接修改：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| cookie | - | 网易云Cookie |
| bitrate | 320000 | 音频码率 |
| searchTimeout | 30 | 搜索超时（秒） |
| searchPageSize | 5 | 每页结果数 |
| mergeSearchResults | false | 合并发送列表 |
| rateLimitEnabled | true | 启用频率限制 |
| rateLimitInterval | 2 | 调用间隔（秒） |
| rateLimitGlobal | true | 全局限制 |
| cacheMaxSize | 1024 | 缓存容量（MB） |
| cachePath | data/ncm-cache | 缓存路径 |

## 技术实现细节

### 1. WEAPI加密
- AES-128-CBC加密
- RSA公钥加密
- 完全兼容网易云官方API

### 2. 数据库设计
```typescript
interface MusicCache {
  id: string              // 歌曲ID（主键）
  name: string           // 歌曲名称
  artist: string         // 艺术家
  url: string            // 直链URL
  cached: boolean        // 是否已缓存
  cachePath: string      // 缓存路径
  fileSize: number       // 文件大小
  cacheTime: number      // 缓存时间戳
  bitrate: number        // 比特率
}
```

### 3. 搜索会话管理
- 基于会话键（platform:channel:user）
- 自动超时清理
- 消息撤回机制

### 4. 缓存管理
- 滚动覆盖最旧缓存
- 文件存在性验证
- 数据库状态同步

## 使用示例

```bash
# 搜索并获取音乐
ncmget 晴天

# 使用别名
网易云 七里香

# 多结果时
> 找到多首歌曲，请回复数字选择（回复0退出）：
> 1. 晴天 - 周杰伦 [04:29]
> 2. 晴天 - 孙燕姿 [04:23]
> ...
# 用户回复: 1

# 下载并发送
> 正在下载歌曲，请稍候...
> [音频文件: 周杰伦 - 晴天.mp3]
```

## 注意事项

1. **Cookie安全**：Cookie包含敏感信息，请妥善保管
2. **版权合规**：仅供个人学习使用，请勿用于商业用途
3. **网络要求**：需要能够访问网易云音乐API
4. **缓存管理**：定期清理缓存以节省磁盘空间

## 下一步开发建议

可选的增强功能：
- [ ] 歌单批量下载
- [ ] 歌词显示支持
- [ ] 播放历史记录
- [ ] 收藏夹功能
- [ ] 更多音质选项
- [ ] 专辑封面展示
