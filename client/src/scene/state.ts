/**
 * SceneState — everything the left-panel layers read. Derived only by
 * `reduceScene` (see reducer.ts). Layers hold no event logic.
 *
 * See client/CLAUDE.md "UI state machine" and
 * docs/superpowers/specs/2026-09-04-left-panel-ritual-ui-design.md §3.
 */

import type { EotwEvent } from '../lib/schema'

export type Phase =
  | 'idle' // before FaceDetected — the Eye is closed
  | 'scrying' // FaceDetected .. SearchMerged — the sweep
  | 'weighing' // after SearchMerged, before PostAccepted — the long silence
  | 'weaving' // PostAccepted .. MerkleBuilt — the figure forms
  | 'naming' // Attesting — the chant
  | 'fixed' // Attested — scroll unfurls, success video
  | 'empty' // NoMatchFound — failure video, scroll never renders
  | 'broken' // Failed (real or synthetic) — rupture

export interface Star {
  url: string
  thumbnail: string
  faceSim: number
  title: string
}

export interface Seal {
  txHash: string
  uid: string
  easscan: string
}

export interface EngineResult {
  name: string
  hitCount: number | null
  failed: boolean
}

export type NarrationTone = 'seer' | 'omen' | 'aside'

export interface NarrationEntry {
  id: number
  event: string
  line: string
  tone: NarrationTone
}

export interface SceneState {
  phase: Phase
  face: { backend: string; detScore: number } | null
  hostedUrl: string | null
  engines: EngineResult[]
  mergedCount: number | null
  post: { count: number; topSim: number } | null
  stars: Star[]
  expand: 'none' | 'requested' | 'completed' | 'skipped'
  figureRoot: string | null
  seal: Seal | null
  verified: boolean
  verifyFailed: { reason: string } | null
  noMatch: { candidatesChecked: number | null; reason: string } | null
  failure: { stage: string; error: string } | null
  narration: NarrationEntry[]
  lastEventAt: number | null
  terminalReached: boolean
}

/** Internal actions the hook dispatches alongside real events. `@` prefix so
 *  they can never collide with a pipeline event name. */
export type InternalAction =
  | { event: '@StarsResolved'; stars: Star[] }
  | { event: '@StreamEnded' }
  | { event: '@Idle' }

export type SceneInput = EotwEvent | InternalAction

export const initialScene: SceneState = {
  phase: 'idle',
  face: null,
  hostedUrl: null,
  engines: [],
  mergedCount: null,
  post: null,
  stars: [],
  expand: 'none',
  figureRoot: null,
  seal: null,
  verified: false,
  verifyFailed: null,
  noMatch: null,
  failure: null,
  narration: [],
  lastEventAt: null,
  terminalReached: false,
}

/** The scroll renders content only once a real Attested seal exists. */
export function scrollVisible(s: SceneState): boolean {
  return s.seal !== null
}

/** Which video clip the video layer should resolve, if any. */
export function videoFor(s: SceneState): 'success' | 'failure' | 'rupture' | null {
  if (s.phase === 'fixed') return 'success'
  if (s.phase === 'empty') return 'failure'
  if (s.phase === 'broken') return 'rupture'
  return null
}

const PHASE_RANK: Record<Phase, number> = {
  idle: 0,
  scrying: 1,
  weighing: 2,
  weaving: 3,
  naming: 4,
  fixed: 5,
  empty: 9,
  broken: 9,
}

export function isTerminalPhase(p: Phase): boolean {
  return p === 'fixed' || p === 'empty' || p === 'broken'
}

/** Move forward along the linear spine only; never regress. Off-ramps
 *  (empty / broken) are set directly by their events, not through here. */
export function advance(current: Phase, target: Phase): Phase {
  if (current === 'empty' || current === 'broken') return current
  return PHASE_RANK[target] > PHASE_RANK[current] ? target : current
}
