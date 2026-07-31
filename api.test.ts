import { test, expect, afterEach } from 'bun:test'
import {
  buildClientVersion, randomWechatUin, buildHeaders,
  textItem, getUploadUrl, MessageItemType, UploadMediaType,
  getConfig, sendTyping, TypingStatus, sendItem, getUpdates, extractMessageIds,
} from './api.ts'

test('extractMessageIds reads ids from raw JSON before precision is lost', () => {
  const raw = '{"ret":0,"msgs":[{"message_id":7488896191118167176,"item_list":[]},'
    + '{"message_id":7488894805294949001}],"get_updates_buf":"B"}'
  expect(extractMessageIds(raw)).toEqual(['7488896191118167176', '7488894805294949001'])
})

test('extractMessageIds tolerates ids already sent as strings', () => {
  expect(extractMessageIds('{"message_id":"748889619111816717"}')).toEqual(['748889619111816717'])
})

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

test('buildClientVersion packs major/minor/patch into 0x00MMNNPP', () => {
  expect(buildClientVersion('1.0.11')).toBe(0x0001000b)
  expect(buildClientVersion('0.5.0')).toBe(0x000500)
  expect(buildClientVersion('garbage')).toBe(0)
})

test('randomWechatUin is base64 of a decimal uint32 string', () => {
  const decoded = Buffer.from(randomWechatUin(), 'base64').toString('utf-8')
  expect(decoded).toMatch(/^\d+$/)
  const n = Number(decoded)
  expect(n).toBeGreaterThanOrEqual(0)
  expect(n).toBeLessThanOrEqual(0xffffffff)
})

test('buildHeaders carries ilink auth and app identity', () => {
  const h = buildHeaders('tok')
  expect(h['Content-Type']).toBe('application/json')
  expect(h['AuthorizationType']).toBe('ilink_bot_token')
  expect(h['Authorization']).toBe('Bearer tok')
  expect(h['X-WECHAT-UIN']).toBeTruthy()
  expect(h['iLink-App-Id']).toBe('bot')
  expect(Number(h['iLink-App-ClientVersion'])).toBeGreaterThan(0)
})

test('textItem builds a TEXT item', () => {
  expect(textItem('hi')).toEqual({ type: MessageItemType.TEXT, text_item: { text: 'hi' } })
})

test('getUploadUrl posts the documented body and returns the upload params', async () => {
  let seenUrl = '', seenBody: any = null
  globalThis.fetch = (async (url: any, init: any) => {
    seenUrl = String(url)
    seenBody = JSON.parse(init.body)
    return new Response(JSON.stringify({ ret: 0, upload_param: 'P', upload_full_url: 'https://cdn/u' }))
  }) as any

  const resp = await getUploadUrl(
    { token: 't', baseUrl: 'https://api.example.com/' },
    {
      filekey: 'fk', media_type: UploadMediaType.IMAGE, to_user_id: 'u1',
      rawsize: 10, rawfilemd5: 'md5', filesize: 16,
      no_need_thumb: true, aeskey: 'deadbeef',
    },
  )

  expect(seenUrl).toBe('https://api.example.com/ilink/bot/getuploadurl')
  expect(seenBody.filekey).toBe('fk')
  expect(seenBody.media_type).toBe(1)
  expect(seenBody.no_need_thumb).toBe(true)
  expect(seenBody.aeskey).toBe('deadbeef')
  expect(seenBody.base_info.channel_version).toBeTruthy()
  expect(resp.upload_full_url).toBe('https://cdn/u')
})

test('getUploadUrl throws on non-zero ret', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ret: -14, errmsg: 'stale token' }))) as any

  await expect(getUploadUrl(
    { token: 't', baseUrl: 'https://api.example.com/' },
    {
      filekey: 'fk', media_type: 1, to_user_id: 'u1',
      rawsize: 1, rawfilemd5: 'm', filesize: 16, no_need_thumb: true, aeskey: 'k',
    },
  )).rejects.toThrow(/ret=-14/)
})

test('sendItem returns the server message id with int64 precision intact', async () => {
  globalThis.fetch = (async () =>
    new Response('{"message_id":7488899903869369171}')) as any

  const id = await sendItem(
    { token: 't', baseUrl: 'https://api.example.com/' },
    { to: 'u1', item: textItem('hi'), contextToken: 'ctx' },
  )
  expect(id).toBe('7488899903869369171')
})

test('getUpdates surfaces per-message ids straight from the raw body', async () => {
  globalThis.fetch = (async () => new Response(
    '{"ret":0,"msgs":[{"message_id":7488896191118167176},{"message_id":7488894805294949001}],'
    + '"get_updates_buf":"NEXT"}',
  )) as any

  const { resp, messageIds } = await getUpdates(
    { token: 't', baseUrl: 'https://api.example.com/' }, 'BUF',
  )
  expect(resp.get_updates_buf).toBe('NEXT')
  expect(resp.msgs).toHaveLength(2)
  expect(messageIds).toEqual(['7488896191118167176', '7488894805294949001'])
})

test('getConfig posts the user id and returns the ticket', async () => {
  let seenUrl = '', seenBody: any = null
  globalThis.fetch = (async (url: any, init: any) => {
    seenUrl = String(url)
    seenBody = JSON.parse(init.body)
    return new Response(JSON.stringify({ ret: 0, typing_ticket: 'TICKET' }))
  }) as any

  const resp = await getConfig(
    { token: 't', baseUrl: 'https://api.example.com/' },
    { ilinkUserId: 'u1', contextToken: 'ctx' },
  )

  expect(seenUrl).toBe('https://api.example.com/ilink/bot/getconfig')
  expect(seenBody.ilink_user_id).toBe('u1')
  expect(seenBody.context_token).toBe('ctx')
  expect(resp.typing_ticket).toBe('TICKET')
})

test('getConfig returns non-zero ret instead of throwing — typing is optional', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ret: -1, errmsg: 'nope' }))) as any

  const resp = await getConfig(
    { token: 't', baseUrl: 'https://api.example.com/' },
    { ilinkUserId: 'u1' },
  )
  expect(resp.ret).toBe(-1)
})

test('sendTyping posts the ticket and status', async () => {
  let seenUrl = '', seenBody: any = null
  globalThis.fetch = (async (url: any, init: any) => {
    seenUrl = String(url)
    seenBody = JSON.parse(init.body)
    return new Response(JSON.stringify({ ret: 0 }))
  }) as any

  await sendTyping(
    { token: 't', baseUrl: 'https://api.example.com/' },
    { ilinkUserId: 'u1', ticket: 'TICKET', status: TypingStatus.CANCEL },
  )

  expect(seenUrl).toBe('https://api.example.com/ilink/bot/sendtyping')
  expect(seenBody.ilink_user_id).toBe('u1')
  expect(seenBody.typing_ticket).toBe('TICKET')
  expect(seenBody.status).toBe(2)
  expect(seenBody.base_info.channel_version).toBeTruthy()
})
