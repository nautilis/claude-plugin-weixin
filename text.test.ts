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

test('extractText falls back to a placeholder for an empty message', () => {
  expect(extractText({})).toBe('(empty message)')
  expect(extractText({ item_list: [{ type: 99 }] })).toBe('(empty message)')
})
