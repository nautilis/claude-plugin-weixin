# 设计：微信「正在输入」状态

日期：2026-07-31
状态：已批准，待实现

## 背景

微信 iLink Bot 接口提供 `ilink/bot/sendtyping`，可以让对方看到「对方正在输入」。
本设计把它移植过来，来源 `Tencent/openclaw-weixin` v2.4.6（MIT）的
`src/api/api.ts`、`src/api/config-cache.ts`、`src/messaging/process-message.ts`。

**结构性差异**：上游的 OpenClaw 自己拥有 agent 循环，能精确知道「开始生成 / 生成结束」。
本插件的 MCP server 看不到这些，它只能观察到两个事件：入站消息投递、`reply` 被调用。
因此输入状态的窗口只能按这两个事件近似。

## 目标

- 入站消息通过访问网关后，对方看到「正在输入」
- 回复发完后状态消失
- 该功能的任何失败都不得影响消息投递或回复

## 非目标

`ilink/bot/msg/notifystart` 与 `notifystop`（频道启停通知）不在本次范围。

## 协议

- `ilink/bot/getconfig`：入参 `ilink_user_id` + `context_token`，返回 `typing_ticket`（base64）
- `ilink/bot/sendtyping`：入参 `ilink_user_id` + `typing_ticket` + `status`
  - `status` 1 = 正在输入，2 = 取消
- **输入状态需要每 5 秒续期一次**（上游 `keepaliveIntervalMs: 5000`）

## 生命周期

```
入站消息通过 gate ──► startTyping(userId, contextToken)
                       ├─ 取 ticket（缓存命中则不请求）
                       ├─ sendtyping status=1
                       └─ 每 5s 续期
                            │
       reply 全部发完 ───────┴──► stopTyping：清定时器 + sendtyping status=2
       或 3 分钟硬超时 ─────┘
```

**关闭时机在 reply 完成之后**（`finally` 块），不是调用之初：多段文字加附件可能发好几秒，
这期间保持「正在输入」才符合直觉，且发送失败时也能正常关闭。

**3 分钟硬超时**（`TYPING_MAX_MS`）防止 Claude 根本不回复那条消息时状态无限续期。
超时自动停止并发送取消。

## ticket 缓存

内存 `Map<userId, { ticket: string | null; expiresAt: number }>`。

- 成功：缓存 ticket，24 小时有效
- 失败或 `ret != 0`：缓存 `null` 60 秒（负缓存），避免每条消息都去撞

上游有一套指数退避阶梯（2 秒起、封顶 1 小时），**本设计刻意砍掉**：这个功能失败的后果只是
没有输入提示，不值得一套退避状态机。

## 触发条件

只对**通过访问网关**的发送者触发。配对中、被 drop 的陌生人不触发——既避免浪费调用，
也不向未授权的人暴露「这边有个活着的 bot 在响应」。

## 开关

`access.json` 加可选字段 `typing`（布尔，缺省视为 `true`），与现有的 `ackText`、
`textChunkLimit` 同一模式。为 `false` 时一个请求都不发。

## 错误处理

所有 typing 调用 fire-and-forget：错误只写 stderr，**绝不影响消息投递或 reply**。
`typing_ticket` 取不到时整个功能降级为无操作，与上游 `hasTypingTicket` 为 false 时行为一致。

## 测试

续期与超时通过**注入参数**测试（`intervalMs` / `maxMs`），不依赖 fake timer：

- ticket 缓存命中时不重复请求 `getconfig`
- `getconfig` 返回 `ret != 0` 时得到 null 且不抛异常
- `startTyping` 发出 `status=1`，短间隔后自动续期再发一次
- `stopTyping` 发出 `status=2`，之后不再有任何请求
- 硬超时到达后自动停止并发出取消
- `typing: false` 时零请求
- `sendtyping` 失败不向上抛

真机：用户发一条消息 → 微信出现「对方正在输入」→ 回复后消失。

**已知不确定性**：微信客户端是否真的为 bot 会话渲染该状态，属于客户端行为，只能真机验证。
若接口调用成功但界面无变化，结论应如实报告为「接口通、客户端不渲染」，不做臆测。

## 参考

- `Tencent/openclaw-weixin` v2.4.6（MIT）：`src/api/api.ts:520-555`、`src/api/config-cache.ts`、
  `src/messaging/process-message.ts:290-320`
