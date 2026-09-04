import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateEvent, type EotwEventName } from './schema'

const FIXTURE_DIR = resolve(import.meta.dirname, '../../fixtures')

function loadFixture(name: string): { lineNo: number; obj: Record<string, unknown> }[] {
  const raw = readFileSync(resolve(FIXTURE_DIR, name), 'utf8')
  return raw
    .split('\n')
    .map((text, idx) => ({ text: text.trim(), lineNo: idx + 1 }))
    .filter((r) => r.text.length > 0)
    .map((r) => ({ lineNo: r.lineNo, obj: JSON.parse(r.text) as Record<string, unknown> }))
}

function eventNames(rows: { obj: Record<string, unknown> }[]): EotwEventName[] {
  return rows.map((r) => r.obj.event as EotwEventName)
}

describe('validateEvent', () => {
  it('accepts a well-formed event', () => {
    expect(validateEvent({ event: 'Attesting' })).toEqual([])
  })

  it('rejects an unknown event name', () => {
    expect(validateEvent({ event: 'FaceLocked' })).toEqual(['unknown event "FaceLocked"'])
  })

  it('rejects an added field (CLAUDE.md: do not add or remove fields)', () => {
    expect(validateEvent({ event: 'Attesting', progress: 0.5 })).toEqual([
      'Attesting: unexpected field "progress"',
    ])
  })

  it('rejects a missing field', () => {
    expect(validateEvent({ event: 'ImageHosted' })).toEqual(['ImageHosted: missing field "crop_url"'])
  })

  it('rejects a wrong field type', () => {
    expect(validateEvent({ event: 'ImageSearchCompleted', engine: 'serpapi', hit_count: '14' })).toEqual([
      'ImageSearchCompleted: field "hit_count" should be number, got string',
    ])
  })
})

describe('fixtures/events-success.jsonl', () => {
  const rows = loadFixture('events-success.jsonl')

  it('every line matches the schema exactly', () => {
    for (const { lineNo, obj } of rows) {
      expect(validateEvent(obj), `line ${lineNo}: ${JSON.stringify(obj)}`).toEqual([])
    }
  })

  it('walks the full attestation happy path and ends on VerifyPassed', () => {
    const names = eventNames(rows)
    expect(names[0]).toBe('FaceDetected')
    expect(names).toContain('PostAccepted')
    expect(names).toContain('MerkleBuilt')
    expect(names).toContain('Attesting')
    expect(names).toContain('Attested')
    expect(names.at(-1)).toBe('VerifyPassed')
  })
})

describe('fixtures/events-failure.jsonl', () => {
  const rows = loadFixture('events-failure.jsonl')

  it('every line matches the schema exactly', () => {
    for (const { lineNo, obj } of rows) {
      expect(validateEvent(obj), `line ${lineNo}: ${JSON.stringify(obj)}`).toEqual([])
    }
  })

  it('is a NoMatchFound run with zero attestation events (CLAUDE.md hard rule)', () => {
    const names = eventNames(rows)
    expect(names).toContain('NoMatchFound')
    for (const forbidden of ['MerkleBuilt', 'Attesting', 'Attested', 'VerifyPassed'] as const) {
      expect(names, `failure fixture must not contain ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('never emits PostAccepted (nothing cleared scoring)', () => {
    expect(eventNames(rows)).not.toContain('PostAccepted')
  })
})
