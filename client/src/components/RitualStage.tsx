/**
 * The left panel. A stack of layers, bottom to top:
 *
 *   VideoLayer     full-bleed background at every phase (see VideoLayer.tsx)
 *   ritual-chrome  phase readout, scroll, loot gallery, end card, textbox —
 *                  faded out while an outcome clip is having its "beat"
 *                  moment, faded in once it settles (see beatActive below)
 *   GrainVignette  atmospheric wash, non-interactive
 *
 * It holds NO event logic. Everything it shows is derived from `scene`, which
 * is produced by the pure reducer in src/scene/. See client/CLAUDE.md.
 */

import { useCallback, useState } from 'react'
import { CastAgain } from './layers/CastAgain'
import { EndCard } from './layers/EndCard'
import { GrainVignette } from './layers/GrainVignette'
import { JRPGTextbox } from './layers/JRPGTextbox'
import { LootGallery } from './layers/LootGallery'
import { Scroll } from './layers/Scroll'
import { VideoLayer } from './layers/VideoLayer'
import { videoFor, type SceneState } from '../scene/state'

const PHASE_LABEL: Record<SceneState['phase'], string> = {
  idle: 'the eye is closed',
  scrying: 'scrying the skies',
  weighing: 'weighing the lights',
  weaving: 'weaving the figure',
  naming: 'speaking the name',
  fixed: 'the name is fixed',
  empty: 'the dark keeps her',
  broken: 'the eye has gone dark',
}

/** A single caption line shown only during an outcome clip's first,
 *  chrome-free playthrough (see beatActive below). */
const BEAT_CAPTION: Record<'success' | 'failure' | 'rupture', string> = {
  success: 'She has found you.',
  failure: 'The dark keeps her.',
  rupture: 'The witch falls.',
}

export function RitualStage({ scene, onCastAgain }: { scene: SceneState; onCastAgain?: () => void }) {
  const outcome = videoFor(scene)
  const [beatDone, setBeatDone] = useState(false)
  const handleBeatEnd = useCallback(() => setBeatDone(true), [])

  // A terminal outcome gets one uninterrupted playthrough of its clip before
  // the rest of the chrome (scroll, cards, textbox) fades back in. Working
  // phases have no "beat" — chrome is always up.
  const beatActive = outcome !== null && !beatDone

  return (
    <div
      className={`ritual-stage phase-${scene.phase}${beatActive ? ' is-beat' : ''}`}
      data-phase={scene.phase}
    >
      <VideoLayer scene={scene} onBeatEnd={handleBeatEnd} />

      {beatActive && outcome && <p className="ritual-beat-caption">{BEAT_CAPTION[outcome]}</p>}

      <div className="ritual-chrome">
        <span className="ritual-phase-readout" aria-live="polite">
          {PHASE_LABEL[scene.phase]}
        </span>
        <Scroll scene={scene} />
        <LootGallery stars={scene.stars} />
        <EndCard phase={scene.phase} />
        <JRPGTextbox entries={scene.narration} />
        <CastAgain phase={scene.phase} onCastAgain={onCastAgain} />
      </div>

      <GrainVignette />
    </div>
  )
}
