import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyEvent, readEventLine, validateEvent } from './schema'

const FIXTURE_DIR = resolve(import.meta.dirname, '../../fixtures')

function loadFixture(name: string): { lineNo: number; obj: Record<string, unknown> }[] {
  const raw = readFileSync(resolve(FIXTURE_DIR, name), 'utf8')
  return raw
    .split('\n')
    .map((text, idx) => ({ text: text.trim(), lineNo: idx + 1 }))
    .filter((r) => r.text.length > 0)
    .map((r) => ({ lineNo: r.lineNo, obj: JSON.parse(r.text) as Record<string, unknown> }))
}

function names(rows: { obj: Record<string, unknown> }[]): string[] {
  return rows.map((r) => r.obj.event as string)
}

describe('classifyEvent', () => {
  it('sorts names into tiers', () => {
    expect(classifyEvent('FaceDetected')).toBe('closed')
    expect(classifyEvent('Attested')).toBe('closed')
    expect(classifyEvent('SearchMerged')).toBe('open')
    expect(classifyEvent('VerifyPassed')).toBe('open')
    expect(classifyEvent('GalleryBuilt')).toBe('open')
    expect(classifyEvent('AnchorLocked')).toBe('open')
    expect(classifyEvent('NoMatchFound')).toBe('open')
    expect(classifyEvent('ConsentBound')).toBe('reserved')
    expect(classifyEvent('FaceLocked')).toBe('unknown')
  })
})

describe('validateEvent', () => {
  it('accepts a closed event with exact fields', () => {
    expect(
      validateEvent({
        event: 'Attested',
        tx_hash: '0xaa',
        uid: '0xbb',
        easscan: 'https://sepolia.easscan.org/attestation/view/0xbb',
      }),
    ).toEqual([])
  })

  it('accepts envelope keys (ts, seq, run_id) on any event', () => {
    expect(
      validateEvent({
        event: 'Attesting',
        root: '0xaa',
        ts: '2026-09-04T00:00:00+00:00',
        seq: 4,
        run_id: 'r1',
      }),
    ).toEqual([])
  })

  it('accepts an open event with an arbitrary payload', () => {
    expect(validateEvent({ event: 'SearchMerged', unique: 18, note: 'whatever' })).toEqual([])
  })

  it('accepts a reserved event name', () => {
    expect(validateEvent({ event: 'NoMatchFound', candidates_checked: 6, reason: 'x' })).toEqual([])
  })

  it('rejects an unknown event name', () => {
    expect(validateEvent({ event: 'FaceLocked' })).toEqual(['unknown event "FaceLocked"'])
  })

  it('rejects an unexpected field on a closed event', () => {
    expect(validateEvent({ event: 'Attesting', root: '0xaa', progress: 0.5 })).toEqual([
      'Attesting: unexpected field "progress"',
    ])
  })

  it('rejects a missing field on a closed event', () => {
    expect(validateEvent({ event: 'ImageHosted' })).toEqual(['ImageHosted: missing field "url"'])
  })

  it('rejects a wrong field type on a closed event', () => {
    expect(
      validateEvent({ event: 'ImageSearchCompleted', engine: 'google', hits: '12' }),
    ).toEqual(['ImageSearchCompleted: field "hits" should be number, got string'])
  })

  it('allows the optional Failed.stage but type-checks it', () => {
    expect(validateEvent({ event: 'Failed', error: 'boom' })).toEqual([])
    expect(validateEvent({ event: 'Failed', error: 'boom', stage: 'face' })).toEqual([])
    expect(validateEvent({ event: 'Failed', error: 'boom', stage: 7 })).toEqual([
      'Failed: field "stage" should be string, got number',
    ])
  })
})

describe('readEventLine', () => {
  it('returns a null event + tier "unknown" for a well-formed unknown event, without throwing', () => {
    const r = readEventLine('{"event":"SomethingNew","x":1}')
    expect(r.tier).toBe('unknown')
    expect(r.event).toBeNull()
    expect(r.problems).toEqual(['unknown event "SomethingNew"'])
  })

  it('throws only on invalid JSON', () => {
    expect(() => readEventLine('{not json')).toThrow()
  })
})

describe('fixtures/events-success.jsonl', () => {
  const rows = loadFixture('events-success.jsonl')

  it('every line is valid against the contract', () => {
    for (const { lineNo, obj } of rows) {
      expect(validateEvent(obj), `line ${lineNo}: ${JSON.stringify(obj)}`).toEqual([])
    }
  })

  it('walks the happy path: FaceDetected first, one ImageSearchCompleted per engine, ends VerifyPassed', () => {
    const n = names(rows)
    expect(n[0]).toBe('FaceDetected')
    expect(n.filter((x) => x === 'ImageSearchCompleted').length).toBe(2)
    expect(n).toContain('SearchMerged')
    expect(n).toContain('PostAccepted')
    expect(n).toContain('MerkleBuilt')
    expect(n).toContain('Attesting')
    expect(n).toContain('Attested')
    expect(n.at(-1)).toBe('VerifyPassed')
  })

  it('PostAccepted is a summary (count + top_sim), not per-post', () => {
    const post = rows.find((r) => r.obj.event === 'PostAccepted')!.obj
    expect(post).toHaveProperty('count')
    expect(post).toHaveProperty('top_sim')
    expect(post).not.toHaveProperty('url')
  })

  it('Attested carries tx_hash, uid, easscan and nothing before it does', () => {
    const attestedIdx = rows.findIndex((r) => r.obj.event === 'Attested')
    expect(attestedIdx).toBeGreaterThan(0)
    for (let i = 0; i < attestedIdx; i++) {
      expect(rows[i].obj).not.toHaveProperty('tx_hash')
    }
    const att = rows[attestedIdx].obj
    expect(att).toHaveProperty('tx_hash')
    expect(att).toHaveProperty('uid')
    expect(att).toHaveProperty('easscan')
  })
})

describe('fixtures/events-success-noexpand.jsonl', () => {
  const rows = loadFixture('events-success-noexpand.jsonl')

  it('every line is valid', () => {
    for (const { lineNo, obj } of rows) {
      expect(validateEvent(obj), `line ${lineNo}`).toEqual([])
    }
  })

  it('skips expand and still attests', () => {
    const n = names(rows)
    expect(n).toContain('ExpandSkipped')
    expect(n).not.toContain('ExpandCompleted')
    expect(n).toContain('Attested')
    expect(n.at(-1)).toBe('VerifyPassed')
  })
})

describe('fixtures/events-nomatch.jsonl (emitted path)', () => {
  const rows = loadFixture('events-nomatch.jsonl')

  it('every line is valid', () => {
    for (const { lineNo, obj } of rows) {
      expect(validateEvent(obj), `line ${lineNo}`).toEqual([])
    }
  })

  it('ends on NoMatchFound with zero attestation events (CLAUDE.md hard rule)', () => {
    const n = names(rows)
    expect(n.at(-1)).toBe('NoMatchFound')
    for (const forbidden of ['MerkleBuilt', 'Attesting', 'Attested', 'VerifyPassed', 'PostAccepted']) {
      expect(n, `nomatch fixture must not contain ${forbidden}`).not.toContain(forbidden)
    }
  })
})

describe('fixtures/events-failed.jsonl', () => {
  const rows = loadFixture('events-failed.jsonl')

  it('every line is valid', () => {
    for (const { lineNo, obj } of rows) {
      expect(validateEvent(obj), `line ${lineNo}`).toEqual([])
    }
  })

  it('is a single Failed with an error string', () => {
    expect(rows).toHaveLength(1)
    expect(rows[0].obj.event).toBe('Failed')
    expect(typeof rows[0].obj.error).toBe('string')
  })
})
