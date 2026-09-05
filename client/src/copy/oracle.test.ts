import { describe, expect, it } from 'vitest'
import { VOCABULARY } from '../lib/schema'
import { initialScene, type SceneInput, type SceneState } from '../scene/state'
import { host, oracleFor, ordinal, short } from './oracle'

/** A vocabulary name carries no oracle line — terminal-log-only events. */
const SILENT = new Set(['CandidateScored', 'ConsentBound'])

const REAL_HASH = '0x9f2c4a7b8e1d3f6a0c5b2e9d8a4f7c1b6e3d0a9f2c8b5e1d4a7f0c3b6e9d2a5f8'

function sceneWith(patch: Partial<SceneState> = {}): SceneState {
  return { ...initialScene, ...patch }
}

describe('oracleFor — vocabulary coverage', () => {
  for (const name of VOCABULARY) {
    it(`${name} -> ${SILENT.has(name) ? 'no lines' : 'at least one non-empty line'}`, () => {
      const lines = oracleFor({ event: name } as unknown as SceneInput, initialScene)
      if (SILENT.has(name)) {
        expect(lines).toEqual([])
        return
      }
      expect(lines.length).toBeGreaterThan(0)
      for (const l of lines) {
        expect(typeof l.line).toBe('string')
        expect(l.line.trim().length).toBeGreaterThan(0)
        expect(['seer', 'omen', 'aside']).toContain(l.tone)
      }
    })
  }
})

describe('oracleFor — no hardcoded hashes leak', () => {
  it('Attested is the only place the full tx_hash appears', () => {
    const lines = oracleFor(
      { event: 'Attested', tx_hash: REAL_HASH, uid: '0xabc', easscan: 'https://x' } as unknown as SceneInput,
      initialScene,
    )
    expect(lines.some((l) => l.line.includes(REAL_HASH))).toBe(true)
  })

  it('MerkleBuilt truncates the root — never prints it whole', () => {
    const root = `0x${'a'.repeat(64)}`
    const lines = oracleFor({ event: 'MerkleBuilt', root } as unknown as SceneInput, initialScene)
    expect(lines.some((l) => l.line.includes(root))).toBe(false)
    expect(lines.some((l) => l.line.includes('…'))).toBe(true)
  })
})

describe('oracleFor — reads real fields, not placeholders', () => {
  it('ImageSearchCompleted names the engine and the count', () => {
    const [l] = oracleFor(
      { event: 'ImageSearchCompleted', engine: 'yandex', hits: 9 } as unknown as SceneInput,
      initialScene,
    )
    expect(l.line).toContain('yandex')
    expect(l.line).toContain('9')
  })

  it('PostAccepted reports the accepted count', () => {
    const lines = oracleFor(
      { event: 'PostAccepted', count: 3, top_sim: 0.91 } as unknown as SceneInput,
      initialScene,
    )
    expect(lines.some((l) => l.line.includes('3'))).toBe(true)
  })

  it('@StarsResolved yields one line per resolved star, in order', () => {
    const next = sceneWith({
      stars: [
        { url: 'https://press.example.org/a', thumbnail: 't', faceSim: 0.9, title: 'A' },
        { url: 'https://www.news.example.net/b', thumbnail: 't', faceSim: 0.8, title: 'B' },
      ],
    })
    const lines = oracleFor({ event: '@StarsResolved', stars: next.stars }, next)
    expect(lines).toHaveLength(2)
    expect(lines[0].line).toContain('first')
    expect(lines[0].line).toContain('press.example.org')
    expect(lines[1].line).toContain('second')
    expect(lines[1].line).toContain('news.example.net')
  })

  it('NoMatchFound carries an omen tone and the reason', () => {
    const lines = oracleFor(
      { event: 'NoMatchFound', candidates_checked: 7, reason: 'no candidate cleared threshold' } as unknown as SceneInput,
      initialScene,
    )
    expect(lines.some((l) => l.tone === 'omen')).toBe(true)
    expect(lines.some((l) => l.line.includes('7'))).toBe(true)
    expect(lines.some((l) => l.line.includes('no candidate cleared threshold'))).toBe(true)
  })

  it('Failed names the stage and echoes the error', () => {
    const lines = oracleFor(
      { event: 'Failed', stage: 'attest', error: 'rpc timeout' } as unknown as SceneInput,
      initialScene,
    )
    expect(lines.some((l) => l.line.includes('attest'))).toBe(true)
    expect(lines.some((l) => l.line.includes('rpc timeout'))).toBe(true)
  })
})

describe('oracleFor — internal actions', () => {
  it('@Idle produces a patient aside', () => {
    const lines = oracleFor({ event: '@Idle' }, initialScene)
    expect(lines).toHaveLength(1)
    expect(lines[0].tone).toBe('aside')
  })

  it('@StreamEnded speaks only when the failure was a cut thread', () => {
    expect(oracleFor({ event: '@StreamEnded' }, initialScene)).toEqual([])
    const cut = sceneWith({ failure: { stage: 'unknown', error: 'stream_ended' } })
    expect(oracleFor({ event: '@StreamEnded' }, cut).length).toBeGreaterThan(0)
  })
})

describe('helpers', () => {
  it('host strips protocol and www', () => {
    expect(host('https://www.example.com/a/b?c=1')).toBe('example.com')
    expect(host('http://sub.example.org')).toBe('sub.example.org')
    expect(host('not a url')).toBe('not a url')
  })

  it('short truncates long hashes and leaves short strings alone', () => {
    expect(short(`0x${'a'.repeat(64)}`)).toBe('0xaaaaaaaa…')
    expect(short('0xabcd')).toBe('0xabcd')
  })

  it('ordinal covers the first twelve then falls back', () => {
    expect(ordinal(1)).toBe('first')
    expect(ordinal(12)).toBe('twelfth')
    expect(ordinal(13)).toBe('13th')
  })
})
