import { describe, expect, it } from 'vitest'
import { formatEventLine, noteLine, offSchemaLine, stamp, unparseableLine } from './terminalFormat'

// Strip ANSI so assertions read the plain text.
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

describe('formatEventLine', () => {
  it('leads with the event name and renders payload as key=value', () => {
    const line = plain(formatEventLine({ event: 'ImageSearchCompleted', engine: 'google', hits: 12 }))
    expect(line).toContain('ImageSearchCompleted')
    expect(line).toContain('engine="google"')
    expect(line).toContain('hits=12')
  })

  it('handles a payload-less event', () => {
    expect(plain(formatEventLine({ event: 'Attesting' }))).toMatch(/Attesting\s*$/)
  })
})

describe('offSchemaLine — hard rule: never dropped, always verbatim + flagged', () => {
  it('keeps the raw line and appends the reasons', () => {
    const raw = '{"event":"FaceLocked","weird":true}'
    const line = plain(offSchemaLine(raw, ['unknown event "FaceLocked"']))
    expect(line).toContain('! off-schema')
    expect(line).toContain(raw)
    expect(line).toContain('unknown event "FaceLocked"')
  })

  it('still shows the raw line when there are no specific problems', () => {
    const raw = '{"event":"SearchMerged","x":1}'
    expect(plain(offSchemaLine(raw, []))).toContain(raw)
  })
})

describe('unparseableLine', () => {
  it('flags and preserves a non-JSON line', () => {
    const line = plain(unparseableLine('not json at all'))
    expect(line).toContain('! unparseable')
    expect(line).toContain('not json at all')
  })
})

describe('noteLine', () => {
  it('wraps a local note in dashes', () => {
    expect(plain(noteLine('stream end'))).toBe('-- stream end --')
  })
})

describe('stamp', () => {
  it('formats hh:mm:ss.mmm', () => {
    expect(stamp(new Date(2026, 0, 1, 4, 7, 9, 3))).toBe('04:07:09.003')
  })
})
