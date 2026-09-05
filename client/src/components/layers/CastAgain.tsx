/**
 * Live-mode-only reset control. Shown at any terminal phase, but only when
 * the app has given us a reset handler — never in fixture mode, where the
 * URL alone decides what plays. See client/CLAUDE.md build step 8.
 */

import { isTerminalPhase, type Phase } from '../../scene/state'

export function CastAgain({ phase, onCastAgain }: { phase: Phase; onCastAgain?: () => void }) {
  if (!onCastAgain || !isTerminalPhase(phase)) return null

  return (
    <button type="button" className="cast-again" onClick={onCastAgain}>
      ↺ cast again
    </button>
  )
}
