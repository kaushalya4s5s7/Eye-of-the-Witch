/**
 * The oracle's dialogue. Maps an event to 0..n lines in the cosmic-seer
 * register, interpolating real event fields — never a hardcoded hash.
 *
 * See docs/superpowers/specs/2026-09-04-left-panel-ritual-ui-design.md §4.
 */

import type { EotwEvent } from '../lib/schema'
import type { NarrationTone, SceneInput, SceneState } from '../scene/state'

export interface OracleLine {
  line: string
  tone: NarrationTone
}

export function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function short(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 10)}…` : hash
}

const ORDINALS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
  'eleventh',
  'twelfth',
]

export function ordinal(n: number): string {
  return ORDINALS[n - 1] ?? `${n}th`
}

function band(n: number, table: [number, string][]): string {
  for (const [threshold, phrase] of table) {
    if (n >= threshold) return phrase
  }
  return table[table.length - 1][1]
}

const DET_BAND: [number, string][] = [
  [0.85, 'It burns bright and certain'],
  [0.6, 'It holds steady'],
  [0, 'It is faint, but it is there'],
]

const SIM_BAND: [number, string][] = [
  [0.9, 'near-perfect truth'],
  [0.8, 'a strong, clean light'],
  [0.7, 'a fair light'],
  [0, 'a dim agreement'],
]

const seer = (line: string): OracleLine => ({ line, tone: 'seer' })
const omen = (line: string): OracleLine => ({ line, tone: 'omen' })
const aside = (line: string): OracleLine => ({ line, tone: 'aside' })

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

/**
 * @param input  the event or internal action just applied
 * @param next   the scene state AFTER applying it (for counts, ordinals)
 */
export function oracleFor(input: SceneInput, next: SceneState): OracleLine[] {
  const ev = input as EotwEvent & Record<string, unknown>
  switch (input.event) {
    case 'FaceDetected':
      return [
        seer('A face surfaces from the dark.'),
        seer(`${band(num(ev.det_score), DET_BAND)} — this is the true light I will hunt.`),
      ]
    case 'ImageHosted':
      return [seer('Her likeness is cast on the water, ready to be shown to every sky.')]
    case 'ImageSearchRequested': {
      const engines = Array.isArray(ev.engines) ? ev.engines.length : next.engines.length
      return [seer(`The Eye turns to ${engines || 'many'} skies at once.`)]
    }
    case 'ImageSearchCompleted':
      return [seer(`The ${str(ev.engine, 'far')} sky answers — ${num(ev.hits)} points of light.`)]
    case 'ImageSearchFailed':
      return [aside(`The ${str(ev.engine, 'far')} sky stays shut. No matter.`)]
    case 'SearchMerged': {
      const n = num(ev.unique, next.mergedCount ?? 0)
      return [seer(`All skies gathered. ${n} lights, and no twins among them.`)]
    }
    case '@Idle':
      return [aside('The Eye weighs each light against the true one. Slow work.')]
    case 'PostAccepted':
      return [
        seer(`${num(ev.count)} lights hold true.`),
        seer(`The brightest burns at ${band(num(ev.top_sim), SIM_BAND)}.`),
      ]
    case '@StarsResolved':
      return next.stars.map((s, i) => seer(`Fixed. The ${ordinal(i + 1)} true star — ${host(s.url)}.`))
    case 'ExpandRequested':
      return [seer('It follows the threads outward.')]
    case 'ExpandCompleted':
      return [seer('The threads are walked.')]
    case 'ExpandSkipped':
      return [seer('No threads worth walking. It holds.')]
    case 'GraphUpserted':
      return [seer('The web remembers.')]
    case 'MerkleBuilt':
      return [seer(`The figure has a name now — ${short(str(ev.root))}.`)]
    case 'Attesting':
      return [seer('She speaks the name to the sky.'), seer('The words are going out…')]
    case 'Attested':
      return [
        seer('Nailed to the firmament.'),
        seer('It will hang there long after we are dust.'),
        aside(`coordinates: ${str(ev.tx_hash)}`),
      ]
    case 'VerifyPassed':
      return [seer('Read back against the sky. The figure matches. It is done.')]
    case 'VerifyFailed':
      return [omen(`Read back against the sky — the figure does not hold. ${str(ev.reason, '')}`.trim())]
    case 'NoMatchFound':
      return [
        seer(`The Eye swept every sky. ${num(ev.candidates_checked, next.noMatch?.candidatesChecked ?? 0)} lights weighed.`),
        omen('No true star among them.'),
        omen('The pot goes cold. She found no one worth naming.'),
        ...(str(ev.reason) ? [aside(`(${str(ev.reason)})`)] : []),
      ]
    case 'Failed': {
      const stage = str(ev.stage, next.failure?.stage ?? 'unknown')
      return [
        omen(stage === 'unknown' ? 'The Eye has gone dark.' : `The Eye has gone dark at the ${stage}.`),
        aside(str(ev.error, 'unknown error')),
        omen('The pot lies broken. No name came of this hunt.'),
      ]
    }
    case '@StreamEnded':
      return next.failure?.error === 'stream_ended'
        ? [omen('The thread was cut before the end. The Eye has gone dark.')]
        : []
    // CandidateScored / ConsentBound: terminal log only, no oracle line.
    default:
      return []
  }
}
