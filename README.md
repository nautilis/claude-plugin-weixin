# claude-channel-weixin

WeChat (微信) channel plugin for [Claude Code](https://claude.com/claude-code) — receive and reply to WeChat messages directly in your terminal.

Uses the WeChat iLink Bot API with HTTP long-poll. No public webhook needed.

> A fork of [m1heng/claude-plugin-weixin](https://github.com/m1heng/claude-plugin-weixin),
> adding image/file/video transfer, a typing indicator and quoted-message
> resolution. The CDN pipeline and wire format are ported from
> [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) (MIT),
> which speaks the same iLink Bot API.

## Prerequisites

- [Claude Code](https://claude.com/claude-code) v2.1.80+
- [Bun](https://bun.sh) runtime

## Install

```bash
# Add the marketplace (one-time) — this repo is its own marketplace
claude plugin marketplace add nautilis/claude-plugin-weixin

# Install the plugin
claude plugin install weixin@nautilis-plugins
```

## Configure

### Login with QR code

In Claude Code, run:

```
/weixin:configure login
```

This will fetch a QR code from the WeChat iLink Bot API. Scan it with WeChat and confirm on your phone. Credentials are saved automatically.

### Start with channels

```bash
claude --dangerously-load-development-channels plugin:weixin@nautilis-plugins
```

> The `--dangerously-load-development-channels` flag is required during the [channels research preview](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview) for non-official plugins.

### Pair your WeChat account

1. Send a message to the bot on WeChat — it replies with a pairing code
2. In Claude Code, run `/weixin:access pair <code>` to approve

## Skills

| Skill | Description |
|---|---|
| `/weixin:configure` | QR code login, check channel status |
| `/weixin:access` | Manage pairing, allowlists, DM policy |

## How it works

The plugin runs a local MCP server that long-polls the WeChat iLink Bot API for new messages. No public URL or webhook needed — everything runs locally. Messages from allowed senders are forwarded to your Claude Code session; Claude replies back through the same API.

### Sending images and files

`reply` takes an optional `files` array of absolute local paths:

- `image/*` (png, jpg, gif, webp, bmp) → sent as a photo
- everything else (pdf, zip, txt, …) → sent as a file attachment
- 100MB per file

Files are encrypted with AES-128-ECB and uploaded to the WeChat CDN before the
message is sent. Text and each attachment go out as separate messages.

The CDN pipeline is ported from [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) (MIT).

### Receiving images and files

Inbound photos and file attachments are downloaded, decrypted and written to
`~/.claude/channels/weixin/inbox/`. The channel notification carries
`image_path` (first photo) and `attachments` (JSON for all of them); Claude
reads the file from there. Attachments over 100MB are skipped, and files older
than 7 days are pruned when the server starts.

Paths appear in notification metadata only — never in message content, which a
sender could forge.

### Typing indicator

The sender sees "typing" from the moment their message passes the access gate
until the reply is sent. The state is refreshed every 5 seconds and clears
itself after 3 minutes if no reply arrives.

Set `"typing": false` in `~/.claude/channels/weixin/access.json` to disable it.
Failures are silent — the indicator never blocks message delivery or replies.

### Quoted messages

When the sender quotes an earlier message, the body Claude sees opens with a
`[引用: 内容]` line, so a bare "这个怎么改" still carries what it refers to.

WeChat does not send the quoted text — `ref_msg.message_item` arrives as
`type: 0` carrying only a `msg_id`. The content is therefore resolved from a
local ledger of messages this plugin has seen, in both directions, kept in
`~/.claude/channels/weixin/messages.jsonl` for 7 days. Anything older than the
ledger renders as `[引用: 一条更早的消息（无法还原）]`.

Message ids are int64 and are read out of the raw response body: `JSON.parse`
rounds them, and a rounded id never matches a quote.

### Capturing raw payloads

When the wire format is in question, `touch ~/.claude/channels/weixin/debug-raw`
and inbound payloads are written to `~/.claude/channels/weixin/raw/`. Delete the
marker to stop. Off by default.

### Key difference from Telegram/Feishu

WeChat requires a `context_token` to be passed back when replying. This token comes from the inbound message and is automatically included in the channel notification metadata. Claude passes it back through the reply tool.

## License

MIT — as is [m1heng/claude-plugin-weixin](https://github.com/m1heng/claude-plugin-weixin),
which this is derived from, and [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin),
from which the CDN and messaging code is ported.
