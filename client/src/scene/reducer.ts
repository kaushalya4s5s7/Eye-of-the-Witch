/**
 * reduceScene — the pure left-panel state machine. No side effects, no I/O.
 * `now` is injectable so tests are deterministic.
 *
 * Hard rules enforced here (covered by reducer.test.ts):
 *  - `seal` is written by exactly one case: Attested.
 *  - NoMatchFound -> phase 'empty', never touches seal.
 *  - Failed / @StreamEnded -> phase 'broken', distinct from 'empty'.
 *  - VerifyPassed never sets phase 'fixed' and never touches seal.
 *  - An unknown event object is a no-op.
 */

import type { EotwEvent } from '../lib/schema'
import { oracleFor } from '../copy/oracle'
import {
  advance,
  initialScene,
  isTerminalPhase,
  type EngineResult,
  type SceneInput,
  type SceneState,
} from './state'

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function applyEngineCompleted(engines: EngineResult[], name: string, hitCount: number | null): EngineResult[] {
  const i = engines.findIndex((e) => e.name === name)
  if (i === -1) return [...engines, { name, hitCount, failed: false }]
  const copy = engines.slice()
  copy[i] = { ...copy[i], hitCount }
  return copy
}
function applyEngineFailed(engines: EngineResult[], name: string): EngineResult[] {
  const i = engines.findIndex((e) => e.name === name)
  if (i === -1) return [...engines, { name, hitCount: null, failed: true }]
  const copy = engines.slice()
  copy[i] = { ...copy[i], failed: true }
  return copy
}

function applyEvent(state: SceneState, input: SceneInput, now: number): SceneState {
  const ev = input as EotwEvent & Record<string, unknown>

  switch (input.event) {
    case 'FaceDetected':
      return {
        ...state,
        phase: advance(state.phase, 'scrying'),
        face: {
          backend: str(ev.backend),
          detScore: num(ev.det_score) ?? 0,
          gallerySize: num(ev.gallery_size) ?? undefined,
        },
        lastEventAt: now,
      }

    case 'GalleryBuilt':
      return {
        ...state,
        phase: advance(state.phase, 'scrying'),
        gallerySize: num(ev.size) ?? state.gallerySize,
        lastEventAt: now,
      }

    case 'ImageHosted':
      return { ...state, hostedUrl: str(ev.url) || null, lastEventAt: now }

    case 'ImageSearchRequested': {
      const list = Array.isArray(ev.engines) ? (ev.engines as unknown[]).map(String) : []
      const engines = list.length
        ? list.map((name) => {
            const prev = state.engines.find((e) => e.name === name)
            return prev ?? { name, hitCount: null, failed: false }
          })
        : state.engines
      return { ...state, engines, lastEventAt: now }
    }

    case 'ImageSearchCompleted':
      return {
        ...state,
        engines: applyEngineCompleted(state.engines, str(ev.engine), num(ev.hits)),
        lastEventAt: now,
      }

    case 'ImageSearchFailed':
      return { ...state, engines: applyEngineFailed(state.engines, str(ev.engine)), lastEventAt: now }

    case 'SearchMerged':
      return {
        ...state,
        phase: advance(state.phase, 'weighing'),
        mergedCount: num(ev.unique),
        lastEventAt: now,
      }

    case 'PostAccepted':
      return {
        ...state,
        phase: advance(state.phase, 'weaving'),
        post: { count: num(ev.count) ?? 0, topSim: num(ev.top_sim) ?? 0 },
        lastEventAt: now,
      }

    case 'AnchorLocked':
      return { ...state, anchorLocked: true, lastEventAt: now }

    case '@StarsResolved':
      return { ...state, stars: input.stars, lastEventAt: now }

    case 'ExpandRequested':
      return { ...state, expand: 'requested', lastEventAt: now }
    case 'ExpandCompleted':
      return { ...state, expand: 'completed', lastEventAt: now }
    case 'ExpandSkipped':
      return { ...state, expand: 'skipped', lastEventAt: now }

    case 'GraphUpserted':
      return { ...state, lastEventAt: now }

    case 'MerkleBuilt':
      return { ...state, figureRoot: str(ev.root) || null, lastEventAt: now }

    case 'Attesting':
      return { ...state, phase: advance(state.phase, 'naming'), lastEventAt: now }

    case 'Attested':
      return {
        ...state,
        phase: advance(state.phase, 'fixed'),
        seal: { txHash: str(ev.tx_hash), uid: str(ev.uid), easscan: str(ev.easscan) },
        lastEventAt: now,
      }

    case 'VerifyPassed':
      return { ...state, verified: true, terminalReached: true, lastEventAt: now }

    case 'VerifyFailed':
      return {
        ...state,
        verified: false,
        verifyFailed: { reason: str(ev.reason) },
        terminalReached: true,
        lastEventAt: now,
      }

    case 'NoMatchFound':
      return {
        ...state,
        phase: 'empty',
        noMatch: { candidatesChecked: num(ev.candidates_checked), reason: str(ev.reason) },
        terminalReached: true,
        lastEventAt: now,
      }

    case 'Failed':
      return {
        ...state,
        phase: 'broken',
        failure: { stage: str(ev.stage) || 'unknown', error: str(ev.error) || 'unknown error' },
        terminalReached: true,
        lastEventAt: now,
      }

    case '@StreamEnded':
      if (state.terminalReached) return state
      return {
        ...state,
        phase: 'broken',
        failure: { stage: 'unknown', error: 'stream_ended' },
        terminalReached: true,
      }

    case '@Idle':
      return state

    default:
      // Unknown / unhandled event object — no-op (CLAUDE.md hard rule).
      return state
  }
}

export function reduceScene(
  state: SceneState,
  input: SceneInput,
  now: number = Date.now(),
): SceneState {
  // Once at a terminal off-ramp, only VerifyPassed (the ✓ badge) still lands.
  if (isTerminalPhase(state.phase) && state.phase !== 'fixed' && input.event !== 'VerifyPassed') {
    // still allow @StreamEnded to be a clean no-op, and nothing else mutates.
    if (input.event !== '@StreamEnded') return state
  }

  const next = applyEvent(state, input, now)
  const lines = oracleFor(input, next)
  if (lines.length === 0) return next

  const narration = [
    ...next.narration,
    ...lines.map((l, i) => ({
      id: next.narration.length + i,
      event: String(input.event),
      line: l.line,
      tone: l.tone,
    })),
  ]
  return { ...next, narration }
}

export { initialScene }
