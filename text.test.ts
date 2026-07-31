import { test, expect } from 'bun:test'
import { extractText } from './text.ts'

test('extractText joins text items', () => {
  expect(extractText({ item_list: [{ type: 1, text_item: { text: 'hello' } }] })).toBe('hello')
})

test('extractText renders a placeholder per media kind', () => {
  expect(extractText({ item_list: [{ type: 2 }] })).toBe('(image)')
  expect(extractText({ item_list: [{ type: 3 }] })).toBe('(voice)')
  expect(extractText({ item_list: [{ type: 5 }] })).toBe('(video)')
  expect(extractText({ item_list: [{ type: 4, file_item: { file_name: 'a.pdf' } }] }))
    .toBe('(file: a.pdf)')
})

test('extractText prefers the server-side voice transcript', () => {
  expect(extractText({ item_list: [{ type: 3, voice_item: { text: '早上好' } }] })).toBe('早上好')
})

test('extractText prefixes the quoted message a reply refers to', () => {
  const msg = {
    item_list: [{
      type: 1,
      text_item: { text: '改一下' },
      ref_msg: { message_item: { type: 1, text_item: { text: '昨天的方案' } } },
    }],
  }
  expect(extractText(msg)).toBe('[引用: 昨天的方案]\n改一下')
})

test('extractText includes the quote title alongside its content', () => {
  const msg = {
    item_list: [{
      type: 1,
      text_item: { text: '改一下' },
      ref_msg: { title: '小王', message_item: { type: 1, text_item: { text: '昨天的方案' } } },
    }],
  }
  expect(extractText(msg)).toBe('[引用: 小王 | 昨天的方案]\n改一下')
})

test('extractText names the kind of a quoted attachment', () => {
  const msg = {
    item_list: [{
      type: 1,
      text_item: { text: '这个怎么改' },
      ref_msg: { message_item: { type: 2 } },
    }],
  }
  expect(extractText(msg)).toBe('[引用: (image)]\n这个怎么改')
})

test('extractText resolves a quote that carries only an id', () => {
  const msg = {
    item_list: [{
      type: 1,
      text_item: { text: '对，是图片本身坏了' },
      ref_msg: { message_item: { type: 0, msg_id: '7488894805294949123' } },
    }],
  }
  const resolve = (id: string) =>
    id === '7488894805294949123' ? '那个 CDN 报错是不是解决了' : undefined
  expect(extractText(msg, resolve)).toBe('[引用: 那个 CDN 报错是不是解决了]\n对，是图片本身坏了')
})

test('extractText says so when the quoted message predates the ledger', () => {
  const msg = {
    item_list: [{
      type: 1,
      text_item: { text: '这个怎么改' },
      ref_msg: { message_item: { type: 0, msg_id: '999' } },
    }],
  }
  expect(extractText(msg, () => undefined))
    .toBe('[引用: 一条更早的消息（无法还原）]\n这个怎么改')
})

test('extractText prefers inline quote content over the ledger', () => {
  const msg = {
    item_list: [{
      type: 1,
      text_item: { text: '改一下' },
      ref_msg: { message_item: { type: 1, msg_id: '5', text_item: { text: '昨天的方案' } } },
    }],
  }
  expect(extractText(msg, () => '账本里的旧值')).toBe('[引用: 昨天的方案]\n改一下')
})

test('extractText skips an empty quote rather than showing a bare marker', () => {
  const msg = { item_list: [{ type: 1, text_item: { text: '在吗' }, ref_msg: {} }] }
  expect(extractText(msg)).toBe('在吗')
})

test('extractText falls back to a placeholder for an empty message', () => {
  expect(extractText({})).toBe('(empty message)')
  expect(extractText({ item_list: [{ type: 99 }] })).toBe('(empty message)')
})
