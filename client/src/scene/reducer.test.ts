import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readEventLine, type EotwEvent } from '../lib/schema'
import { initialScene, reduceScene } from './reducer'
import { scrollVisible, videoFor, type SceneInput, type SceneState } from './state'

const FIXTURE_DIR = resolve(import.meta.dirname, '../../fixtures')

function events(fixture: string): EotwEvent[] {
  return readFileSync(resolve(FIXTURE_DIR, fixture), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const r = readEventLine(l)
      if (!r.event) throw new Error(`fixture line not a known event: ${l}`)
      return r.event
    })
}

/** Fold a fixture, returning the state after every step (index 0 = initial). */
function fold(fixture: string, extra: SceneInput[] = []): SceneState[] {
  const inputs: SceneInput[] = [...events(fixture), ...extra]
  const states: SceneState[] = [initialScene]
  let s = initialScene
  let t = 0
  for (const input of inputs) {
    s = reduceScene(s, input, (t += 1000))
    states.push(s)
  }
  return states
}

describe('events-success.jsonl', () => {
  const states = fold('events-success.jsonl')
  const final = states[states.length - 1]
  const names = events('events-success.jsonl').map((e) => e.event)

  it('FaceDetected enters scrying', () => {
    expect(states[1].phase).toBe('scrying')
    expect(states[1].face?.backend).toBe('insightface_buffalo_s')
  })

  it('SearchMerged enters weighing', () => {
    const i = names.indexOf('SearchMerged') + 1
    expect(states[i].phase).toBe('weighing')
    expect(states[i].mergedCount).toBe(18)
  })

  it('PostAccepted enters weaving and records the summary', () => {
    const i = names.indexOf('PostAccepted') + 1
    expect(states[i].phase).toBe('weaving')
    expect(states[i].post).toEqual({ count: 3, topSim: 0.91 })
  })

  it('MerkleBuilt records the figure root', () => {
    const i = names.indexOf('MerkleBuilt') + 1
    expect(states[i].figureRoot).toMatch(/^0x4a7f/)
  })

  it('Attesting enters naming', () => {
    const i = names.indexOf('Attesting') + 1
    expect(states[i].phase).toBe('naming')
  })

  it('seal is null on every state before Attested (CLAUDE.md hard rule)', () => {
    const attestedStateIdx = names.indexOf('Attested') + 1
    for (let i = 0; i < attestedStateIdx; i++) {
      expect(states[i].seal, `state ${i}`).toBeNull()
      expect(scrollVisible(states[i]), `scroll visible at state ${i}`).toBe(false)
    }
  })

  it('Attested sets the seal from real fields and unfurls the scroll', () => {
    const i = names.indexOf('Attested') + 1
    expect(states[i].phase).toBe('fixed')
    expect(states[i].seal).toEqual({
      txHash: '0x9f2c4a7b8e1d3f6a0c5b2e9d8a4f7c1b6e3d0a9f2c8b5e1d4a7f0c3b6e9d2a5f8',
      uid: '0x7b4e9c2a8f1d6b3e0a5c9f2d8b4e7a1c6f3d0b9e2a5c8f1d4b7e0a3c6f9d2b5e8',
      easscan:
        'https://sepolia.easscan.org/attestation/view/0x7b4e9c2a8f1d6b3e0a5c9f2d8b4e7a1c6f3d0b9e2a5c8f1d4b7e0a3c6f9d2b5e8',
    })
    expect(scrollVisible(states[i])).toBe(true)
    expect(videoFor(states[i])).toBe('success')
  })

  it('VerifyPassed is a badge only — no phase change, no seal change', () => {
    expect(final.phase).toBe('fixed')
    expect(final.verified).toBe(true)
    expect(final.terminalReached).toBe(true)
  })

  it('narration accumulates in order with unique ids', () => {
    const ids = final.narration.map((n) => n.id)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
    expect(new Set(ids).size).toBe(ids.length)
    expect(final.narration.some((n) => n.line.includes('Nailed to the firmament'))).toBe(true)
  })
})

describe('@StarsResolved', () => {
  it('populates the gallery without changing phase', () => {
    const stars = [
      { url: 'https://press.example.org/a', thumbnail: 't1', faceSim: 0.9, title: 'A' },
      { url: 'https://news.example.net/b', thumbnail: 't2', faceSim: 0.88, title: 'B' },
    ]
    const states = fold('events-success.jsonl', [{ event: '@StarsResolved', stars }])
    const final = states[states.length - 1]
    expect(final.stars).toHaveLength(2)
    expect(final.phase).toBe('fixed')
    expect(final.narration.filter((n) => n.event === '@StarsResolved')).toHaveLength(2)
  })
})

describe('events-nomatch.jsonl', () => {
  const states = fold('events-nomatch.jsonl')
  const final = states[states.length - 1]

  it('ends in empty, never fixed', () => {
    expect(final.phase).toBe('empty')
    expect(videoFor(final)).toBe('failure')
  })

  it('seal stays null and the scroll never shows at any step', () => {
    for (const [i, s] of states.entries()) {
      expect(s.seal, `state ${i}`).toBeNull()
      expect(scrollVisible(s), `scroll at state ${i}`).toBe(false)
    }
  })

  it('records no stars', () => {
    expect(final.stars).toHaveLength(0)
  })

  it('NoMatchFound does not resolve the success video', () => {
    for (const s of states) expect(videoFor(s)).not.toBe('success')
  })
})

describe('events-failed.jsonl', () => {
  it('enters broken with the error, distinct from empty (real runs omit stage -> "unknown")', () => {
    const states = fold('events-failed.jsonl')
    const final = states[states.length - 1]
    expect(final.phase).toBe('broken')
    expect(final.failure).toEqual({
      stage: 'unknown',
      error: 'InsightFace required but failed: InsightFace found no face',
    })
    expect(final.seal).toBeNull()
    expect(videoFor(final)).toBe('rupture')
  })
})

describe('stream death', () => {
  it('synthesizes a broken state when the stream ends with no terminal event', () => {
    let s = initialScene
    s = reduceScene(s, { event: 'FaceDetected', backend: 'x', det_score: 0.8, embedding_sha256: 'a' })
    s = reduceScene(s, { event: 'ImageHosted', url: 'https://i.ibb.co/x.jpg' })
    s = reduceScene(s, { event: '@StreamEnded' })
    expect(s.phase).toBe('broken')
    expect(s.failure).toEqual({ stage: 'unknown', error: 'stream_ended' })
  })

  it('is a no-op when a terminal event was already seen', () => {
    const states = fold('events-success.jsonl', [{ event: '@StreamEnded' }])
    const final = states[states.length - 1]
    expect(final.phase).toBe('fixed')
    expect(final.failure).toBeNull()
  })
})

describe('unknown / malformed input', () => {
  it('is a no-op, never throws', () => {
    const s = reduceScene(initialScene, { event: 'TotallyNewEvent' } as unknown as SceneInput)
    expect(s).toEqual(initialScene)
  })
})
