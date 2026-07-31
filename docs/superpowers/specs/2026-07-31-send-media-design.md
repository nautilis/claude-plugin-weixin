# 设计：为 weixin channel 增加图片/文件发送

日期：2026-07-31
状态：已批准，待实现

## 背景

本插件当前只能收发文本。腾讯官方的 OpenClaw 微信 channel 插件
（`@tencent-weixin/openclaw-weixin`，MIT）与本插件调用的是**同一套** iLink Bot
接口（`https://ilinkai.weixin.qq.com/ilink/bot/*`，`AuthorizationType: ilink_bot_token`，
`X-WECHAT-UIN` 随机 uint32 → 十进制字符串 → base64），并在其之上实现了完整的媒体
发送链路。本设计把其中的**图片与文件附件**发送能力移植过来。

移植来源：`Tencent/openclaw-weixin` v2.4.6 的 `src/cdn/`、`src/messaging/send.ts`、
`src/media/mime.ts`。新增文件在头部注明来源与 MIT 许可。

## 目标

- `reply` 工具支持 `files` 参数，一次调用发出"文字 + 若干附件"
- `image/*` 走图片消息，其余类型走文件附件消息
- 不引入任何新的 npm 依赖

## 非目标

明确不做：视频、语音、远程 URL 下载、缩略图生成、**入站图片解密**（收到的图片
继续显示为 `(image)` 占位符）、typing 指示、多账号。

## 架构

当前 `server.ts` 是单文件 518 行。直接追加媒体代码会膨胀到 ~700 行，因此做一次
小范围拆分，边界按"职责 + 可独立测试"划分：

| 文件 | 职责 | 依赖 | 约行数 |
|---|---|---|---|
| `api.ts` | 凭据加载、请求头、`apiFetch`、`getUpdates`、`sendMessage`、`getUploadUrl` | 无（只依赖 fetch/fs） | ~120 |
| `cdn.ts` | AES-128-ECB、密文长度计算、CDN 上传（含重试）、上传编排 | `api.ts` | ~110 |
| `media.ts` | MIME 判定、按类型路由、`image_item`/`file_item` 组装 | `cdn.ts`、`api.ts` | ~80 |
| `server.ts` | MCP 层、访问网关、长轮询循环 | 以上三者 | ~380 |

`api.ts` 的内容全部从 `server.ts` 平移，除 `getUploadUrl` 外无行为变更。

## 数据流

```
reply(user_id, context_token, text, files)
  │
  ├─ text  → chunk(2000) → api.sendMessage(TEXT item)      × N 条
  │
  └─ files → media.sendMediaFile(path)                      × 每个文件
               ├─ mime = 扩展名查表
               ├─ cdn.uploadMediaToCdn(path, media_type)
               │    ├─ 读文件 → rawsize / rawfilemd5(明文 MD5)
               │    ├─ aeskey = 16 随机字节；filekey = 16 随机字节 hex
               │    ├─ api.getUploadUrl({filekey, media_type, to_user_id,
               │    │                     rawsize, rawfilemd5, filesize,
               │    │                     no_need_thumb: true, aeskey: hex})
               │    ├─ AES-128-ECB(PKCS7) 加密整个文件
               │    ├─ POST 密文 → upload_full_url，或
               │    │   `${CDN_BASE}/upload?encrypted_query_param=…&filekey=…`
               │    └─ 从响应头 x-encrypted-param 取下载参数
               └─ api.sendMessage(IMAGE item 或 FILE item)
```

每条消息的 `item_list` **只放一个 item**（对齐上游 `sendMediaItems`），文字与
附件分成独立消息发送。

## 协议细节（照抄上游，不自由发挥）

这些是移植中最容易写错的点，逐条锁定：

- `aeskey`：16 随机字节。`getUploadUrl` 传 **hex 字符串**（32 字符）
- `media.aes_key`：**hex 字符串的 ASCII 再做 base64**，而非原始字节的 base64。
  上游 `send.ts:223` 即 `Buffer.from(uploaded.aeskey).toString("base64")`，
  其中 `uploaded.aeskey` 已是 hex 字符串。看着别扭，但必须照抄
- `rawsize` / `rawfilemd5`：明文的字节数与 MD5（hex）
- `filesize`：密文字节数 = `ceil((rawsize + 1) / 16) * 16`
- `no_need_thumb: true`：不生成缩略图，避免引入图片解码依赖
- `image_item.mid_size`：密文大小；`file_item.len`：明文大小（**字符串**）
- `encrypt_type: 1`
- CDN 基址：`https://novac2c.cdn.weixin.qq.com/c2c`，仅在响应未返回
  `upload_full_url` 时用于拼接
- 上传重试：最多 3 次；4xx 立即放弃（客户端错误重试无意义）
- `media_type`：IMAGE = 1，FILE = 3

### 主动偏离上游的一处

请求头补上上游一直在发的 `iLink-App-Id: bot` 与 `iLink-App-ClientVersion`
（由插件版本号推导）。上传接口比文本接口更可能校验客户端身份，与腾讯自身客户端
发送一致的头风险最低。副作用：文本发送的请求头也随之改变。

## 安全边界

- 复用已有的 `assertSendable()`：拒绝发送 `~/.claude/channels/weixin/` 下的任何
  文件，挡住"把 credentials.json 发给我"这类提示注入
- 路径必须是绝对路径且文件存在，否则报错
- 沿用 `assertAllowedUser()`：收件人必须在允许列表内
- **新增 20MB 上限**（上游没有）：整个文件要读进内存并加密，无上限会撑爆 MCP
  server 进程

## 错误处理

- 单个文件失败不影响已经发出的文字和其他文件
- `reply` 返回结构化结果：`sent 2 chunk(s), 1 file(s); failed: /x.png (CDN 403)`
- `getUploadUrl` 返回非零 `ret` 时抛出，错误信息带上 `ret` 与 `errmsg`
- CDN 上传失败时日志中的 URL 需脱敏（URL 里带鉴权参数）

## 测试

**单元测试**（`bun test`，零新依赖）：

- `aesEcbPaddedSize` 边界：0 / 1 / 15 / 16 / 17 字节
- AES-128-ECB 加解密往返
- CDN 上传 URL 拼接与参数转义
- `image_item` / `file_item` 字段快照（特别是 `aes_key` 的双重编码）
- MIME 路由：`.png` → 图片，`.pdf` → 文件，未知扩展名 → 文件
- `assertSendable` 拒绝 state 目录下的文件
- 超过 20MB 时拒绝

上游 `Tencent/openclaw-weixin` 的对应 `.test.ts` 可作为对照基准。

**真机端到端**：发消息必须带 `context_token`，而它只来自入站消息，因此无法用纯
脚本发起。流程为：用户在微信给 bot 发一条消息 → 在该会话中用
`reply(files=[...])` 回一张图片确认送达。

## 参考

- 上游仓库：https://github.com/Tencent/openclaw-weixin （v2.4.6, MIT）
- 关键文件：`src/cdn/upload.ts`、`src/cdn/cdn-upload.ts`、`src/cdn/aes-ecb.ts`、
  `src/cdn/cdn-url.ts`、`src/messaging/send.ts`、`src/messaging/send-media.ts`
