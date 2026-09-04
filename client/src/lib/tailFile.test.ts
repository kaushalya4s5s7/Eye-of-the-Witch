import { describe, expect, it } from 'vitest'
import { completeLines, newLinesSince } from './tailFile'

describe('completeLines', () => {
  it('returns only newline-terminated lines, trimmed', () => {
    expect(completeLines('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('holds back a trailing partial line', () => {
    expect(completeLines('{"a":1}\n{"b":2')).toEqual(['{"a":1}'])
  })

  it('returns nothing for an empty or all-partial file', () => {
    expect(completeLines('')).toEqual([])
    expect(completeLines('{"a":1}')).toEqual([])
  })

  it('skips blank lines', () => {
    expect(completeLines('{"a":1}\n\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
  })
})

describe('newLinesSince', () => {
  it('returns nothing new when the file has not grown', () => {
    const raw = '{"a":1}\n{"b":2}\n'
    expect(newLinesSince(raw, 2)).toEqual({ lines: [], sentCount: 2 })
  })

  it('returns only the lines appended since the last poll', () => {
    const raw = '{"a":1}\n{"b":2}\n{"c":3}\n'
    expect(newLinesSince(raw, 1)).toEqual({ lines: ['{"b":2}', '{"c":3}'], sentCount: 3 })
  })

  it('does not resend a line that is still being written', () => {
    const raw = '{"a":1}\n{"b":2}\n{"c":3'
    expect(newLinesSince(raw, 1)).toEqual({ lines: ['{"b":2}'], sentCount: 2 })
  })

  it('starts from zero for a brand new file', () => {
    expect(newLinesSince('{"a":1}\n', 0)).toEqual({ lines: ['{"a":1}'], sentCount: 1 })
  })
})
