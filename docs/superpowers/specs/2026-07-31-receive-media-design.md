# 设计：接收微信图片与文件附件

日期：2026-07-31
状态：已批准，待实现

## 背景

发送侧（图片/文件）已在 `2026-07-31-send-media-design.md` 中实现并上线。入站方向仍
只渲染 `(image)` / `(file: name)` 占位符——附件内容拿不到，Claude 无法看懂用户发来的图。

微信的媒体存在 CDN 上，密文形式，消息里只带 `encrypt_query_param` 与 `aes_key`。本设计
把下载与解密链路补齐，移植自 `Tencent/openclaw-weixin` v2.4.6（MIT）的
`src/cdn/pic-decrypt.ts` 与 `src/media/media-download.ts`。

meta 字段与 inbox 目录约定参照官方 telegram channel 插件（`claude-plugins-official/telegram` 0.0.6）。

## 目标

- 入站图片与文件附件下载并解密到本地，路径通过 channel 通知的 meta 交给 Claude
- 附件失败不影响文字消息投递
- 不引入任何新的 npm 依赖

## 非目标

视频、语音（入站语音已自带转写文本，`voice_item.text` 现在就能读到）、按需下载
（微信没有 Telegram 那样长期有效的 file_id，CDN 参数只存在于那条入站消息里）。

## 文件结构

| 文件 | 改动 | 约行数 |
|---|---|---|
| `cdn.ts` | 加下载侧原语：`decryptAesEcb`、`buildCdnDownloadUrl`、`parseAesKey`、`downloadAndDecrypt` | +70 |
| `media.ts` | 加 `extractMediaRefs(msg)`：从 `item_list` 抽出媒体引用（纯函数） | +50 |
| `inbox.ts` | 新增：落盘、文件名生成、大小上限、7 天清理 | ~90 |
| `server.ts` | `handleInbound` 接线，meta 加附件字段 | +25 |

## 数据流

```
入站 msg
  └─ media.extractMediaRefs(msg) → MediaRef[]
       { kind: 'image' | 'file', encryptedParam, fullUrl?, aesKey, declaredSize, name? }
          │
          ├─ declaredSize > MAX_INBOUND_BYTES → 跳过，收集为 attachment_error
          │
          └─ cdn.downloadAndDecrypt(ref) → Buffer
               └─ inbox.saveInboundMedia(buf, ref) → /abs/path
                    → meta.image_path / meta.attachments
```

## 协议细节（照抄上游）

**`aes_key` 两种编码并存**（上游 `pic-decrypt.ts` 的 `parseAesKey`）：

- base64 解出 **16 字节** → 直接就是 AES key（图片走这条）
- base64 解出 **32 字节且全为 hex 字符** → 再按 hex 解一次得到 16 字节（文件/语音）
- 其余长度视为非法，抛错

判别依据是解码后的长度，不能按 item 类型想当然。

**key 的优先级**：`image_item.aeskey`（顶层，hex 字符串）优先于 `image_item.media.aes_key`
（base64），见上游 `media-download.ts:47`。

**下载 URL**：优先用消息里的 `media.full_url`；缺失时拼
`${CDN_BASE_URL}/download?encrypted_query_param=<urlencoded>`。`CDN_BASE_URL` 与上传共用
（`https://novac2c.cdn.weixin.qq.com/c2c`）。

**大小预判**：`image_item.hd_size` / `mid_size` 是密文字节数，下载前据此跳过超限附件。
`file_item.len` 是明文字节数（字符串）。

## meta 字段

- `image_path` —— 第一张图的绝对路径。与官方 telegram 插件同名，最常见场景零摩擦
- `attachments` —— JSON 字符串，数组元素 `{ kind, path, name, size }`，含全部成功保存的附件
- `attachment_error` —— 有附件失败或超限时的说明；成功时不出现

**路径只进 meta，绝不进正文。** 正文里的 `[image attached — read: PATH]` 这类标注可被任何
已配对的发送者打字伪造（官方 telegram 插件对此有明确注释）。正文继续沿用现有的
`(image)` / `(file: name)` 占位符。

## 安全边界

- **inbox 从 `assertNotChannelState` 豁免**：`~/.claude/channels/weixin/inbox/` 下的文件允许
  作为附件发出，否则无法把收到的图转发回去。官方 telegram 插件即如此（拒绝 state 目录、
  放行 `state/inbox`）。这是本设计唯一一处主动放松的边界；`credentials.json`、`access.json`
  仍然被挡住。
- **文件名不采用发送者提供的 `file_name`**：一律生成 `<时间戳>-<8位随机>.<扩展名>`，扩展名
  由 kind 与原始文件名的后缀推导并做白名单校验。原始文件名转义后仅作为 meta 字段。
  发送者控制的字符串不得进入文件系统路径。
- **单附件上限 20MB**（`MAX_INBOUND_BYTES`），与发送侧一致。下载前按声明大小预判，下载后
  再按实际字节数复核（声明值不可信）。
- inbox 目录权限 0700，与其余 channel 状态一致。

## 清理

MCP server 启动时扫一遍 inbox，删除 mtime 超过 **7 天**的文件。有界且不会在用户还想看的
时候删掉刚收到的图。清理失败只记日志，不影响启动。

## 错误处理

- 任一附件失败（下载、解密、超限、写盘）**不影响消息投递**：消息照常送达，meta 带
  `attachment_error`
- 解密失败通常意味着 key 编码判别错误，错误信息需带上解码后的字节长度
- 下载 URL 带鉴权参数，日志中一律经 `redactUrl` 脱敏

## 测试

**单元测试**（`bun test`）：

- `parseAesKey`：16 字节 base64、32 字节 hex base64、非法长度三种情况
- `buildCdnDownloadUrl` 参数转义
- `extractMediaRefs`：抽取 image/file item、忽略 text item、优先取顶层 `aeskey`、
  读出 `full_url`
- 文件名生成：发送者提供的 `../` 与路径分隔符不得出现在结果路径中
- `pruneInbox`：删除 8 天前的、保留 1 天前的
- 超过 `MAX_INBOUND_BYTES` 的声明大小被跳过且不发起下载
- `assertNotChannelState`：放行 inbox 下的文件，仍拦截 `credentials.json`

**真机端到端**：用户在微信发一张图 → Claude Read 该路径并**描述图中内容**。
能拿到路径不等于解密正确，必须验证到内容层面。

## 参考

- 上游：`Tencent/openclaw-weixin` v2.4.6（MIT）——
  `src/cdn/pic-decrypt.ts`、`src/media/media-download.ts`、`src/cdn/cdn-url.ts`
- meta 与 inbox 约定：`claude-plugins-official/telegram` 0.0.6 `server.ts:53,141,961-980`
