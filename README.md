# claude-channel-weixin

给 [Claude Code](https://claude.com/claude-code) 用的微信通道插件 —— 在微信里收发消息，由终端里的 Claude 来回复。

底层走微信 iLink Bot API 的 HTTP 长轮询，全部在本地运行，不需要公网地址，也不需要配 webhook。

> 本项目 fork 自 [m1heng/claude-plugin-weixin](https://github.com/m1heng/claude-plugin-weixin)，
> 增加了图片/文件收发、正在输入状态和引用消息还原。CDN 加解密链路与消息体格式
> 移植自同样对接 iLink Bot API 的
> [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）。

## 功能

| 功能 | 说明 |
|---|---|
| 收发文本 | 微信消息转发给 Claude，回复原路发回。长文本自动按段落切分，每条 2000 字符 |
| 接收图片和文件 | 自动下载、解密并落到本地 inbox，Claude 直接读文件 |
| 发送图片和文件 | `reply` 带上绝对路径即可，图片发成照片，其它发成文件附件 |
| 引用消息还原 | 对方引用旧消息时，Claude 能看到被引用的内容，而不只是一句「这个怎么改」 |
| 正在输入 | 消息进来到回复发出之间，对方看到「正在输入」，慢回复也不显得掉线 |
| 访问控制 | 配对码 / 白名单 / 关闭三种策略，只有放行的人能触达你的会话 |
| 原始报文抓取 | 可选：把入站原始 JSON 落盘，排查协议问题用 |

## 环境要求

- [Claude Code](https://claude.com/claude-code) v2.1.80+
- [Bun](https://bun.sh) 运行时

## 安装

```bash
# 添加 marketplace（一次性）—— 本仓库自己就是 marketplace
claude plugin marketplace add nautilis/claude-plugin-weixin

# 安装插件
claude plugin install weixin@nautilis-plugins
```

## 配置

### 扫码登录

在 Claude Code 里执行：

```
/weixin:configure login
```

会拉取一个二维码，用微信扫码并在手机上确认，凭据自动保存到本地。

### 带通道启动

```bash
claude --dangerously-load-development-channels plugin:weixin@nautilis-plugins
```

> channels 目前处于[研究预览阶段](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview)，
> 非官方插件必须加 `--dangerously-load-development-channels` 才能加载。

### 配对你的微信号

1. 在微信里给 bot 发一条消息，它会回一个配对码
2. 在 Claude Code 里执行 `/weixin:access pair <配对码>` 放行

## Skills

| Skill | 说明 |
|---|---|
| `/weixin:configure` | 扫码登录、查看通道状态 |
| `/weixin:access` | 管理配对、白名单、私聊策略、投递参数 |

## 工作原理

插件会起一个本地 MCP server，长轮询 iLink Bot API 拉新消息。放行名单内的消息被转发进
Claude Code 会话，Claude 通过同一个 API 回复。全程本地，不需要公网 URL。

### 发送图片和文件

`reply` 接受一个可选的 `files` 数组，元素是本地绝对路径：

- `image/*`（png、jpg、gif、webp、bmp）→ 作为照片发送
- 其它类型（pdf、zip、txt、mp4 …）→ 作为文件附件发送
- 单个文件上限 100MB

文件先用 AES-128-ECB 加密并上传到微信 CDN，再发消息。文本和每个附件各自是一条独立消息。

CDN 链路移植自 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）。

> 整个文件会读进内存加密，单个附件的内存峰值约为文件大小的 3 倍；大文件是否能发成功还取决于微信服务端自身的限制。

### 接收图片和文件

入站的照片和文件附件会被下载、解密并写入 `~/.claude/channels/weixin/inbox/`。通道通知里带
`image_path`（第一张照片）和 `attachments`（全部附件的 JSON），Claude 从那里读文件。
超过 100MB 的附件会被跳过，超过 7 天的文件在 server 启动时清理。语音和视频消息目前不下载。

路径只出现在通知的 metadata 里，绝不出现在消息正文中 —— 正文是发送方可以伪造的。

### 正在输入

从消息通过访问校验那一刻起，到回复发出为止，对方一直看到「正在输入」。状态每 5 秒刷新一次，
如果一直没有回复，3 分钟后自动消失。

在 `~/.claude/channels/weixin/access.json` 里设 `"typing": false` 可以关掉。这里的失败都是静默的，
输入状态永远不会阻塞消息投递或回复。

### 引用消息

对方引用一条旧消息时，Claude 看到的正文开头会多一行 `[引用: 内容]`，所以一句光秃秃的
「这个怎么改」也带着它指向的东西。

微信并不会把被引用的文本发过来 —— `ref_msg.message_item` 是 `type: 0`，只带一个 `msg_id`。
内容因此是从本地流水里还原的：插件把自己见过的双向消息记在
`~/.claude/channels/weixin/messages.jsonl`，保留 7 天。比流水更早的消息会渲染成
`[引用: 一条更早的消息（无法还原）]`。

消息 id 是 int64，必须从原始响应体里正则取出：`JSON.parse` 会把它四舍五入，
而一个被舍入过的 id 永远匹配不上任何引用。

### 抓原始报文

需要确认协议细节时，`touch ~/.claude/channels/weixin/debug-raw`，入站原始报文就会写到
`~/.claude/channels/weixin/raw/`。删掉这个标记文件即停止。默认关闭。

### 和 Telegram / 飞书通道的关键差异

微信回复时必须带上 `context_token`。这个 token 来自入站消息，会自动放进通道通知的
metadata 里，Claude 调 reply 工具时原样传回。

## 配置项

都在 `~/.claude/channels/weixin/access.json`，可以手改，也可以用 `/weixin:access` 改：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `dmPolicy` | `pairing` | 私聊策略：`pairing`（配对码）/ `allowlist`（仅白名单）/ `disabled`（全部拒绝） |
| `allowFrom` | `[]` | 放行的微信用户 id 列表 |
| `ackText` | 无 | 预留字段，当前版本读取但不使用（不会自动回执） |
| `textChunkLimit` | `2000` | 每条消息最大字符数，只能调小，上限锁死在 2000 |
| `typing` | `true` | 是否发送「正在输入」状态 |

## 本地文件

全部位于 `~/.claude/channels/weixin/`：

| 路径 | 内容 |
|---|---|
| `credentials.json` | 扫码登录得到的凭据 |
| `access.json` | 访问控制与投递配置，含待处理的配对码 |
| `inbox/` | 收到的图片和文件，保留 7 天 |
| `messages.jsonl` | 用于还原引用的消息流水，保留 7 天 |
| `raw/` | 原始报文（仅在开启抓取时） |

## License

MIT —— 与其派生自的 [m1heng/claude-plugin-weixin](https://github.com/m1heng/claude-plugin-weixin)
以及 CDN、消息代码所移植自的 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 一致。
