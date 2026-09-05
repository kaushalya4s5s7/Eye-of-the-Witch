/**
 * The bottom layer, full-bleed at every phase — there is no separate ambient
 * layer anymore. Clip choice tracks the scene:
 *
 *   working (idle..naming) -> ambient   looping cauldron clip
 *   fixed                  -> success   plays once, holds final frame
 *   empty                  -> failure   plays once, holds final frame
 *   broken                 -> rupture   plays once, holds final frame
 *
 * Real per-outcome clips (2026-09-05): `ambient` is `WitchConcocting.mp4`
 * (the witch mid-spell, loops through every working phase), `success` is
 * `WitchSuccess.mp4` (`fixed`, matches EndCard's absence — no EndCard on
 * this phase). `rupture` is `WitchDefeated.mp4` — chosen for `broken`
 * (`Failed`) specifically because its violent framing matches EndCard's
 * "the hero's blade found her first" copy for that phase. `failure` keeps
 * the older `Failure.mp4` for `empty` (`NoMatchFound`) — this is the pairing
 * media/README.md documented from the start ("failure.* -> NoMatchFound,
 * distinct from the Failed error state"), and it keeps `empty` and `broken`
 * visually distinct rather than sharing `rupture`'s clip.
 *
 * Hard rules (client/CLAUDE.md), unchanged by the redesign:
 *  - only `Attested` -> phase `fixed` -> the success clip.
 *  - `NoMatchFound` (empty) and `Failed` (broken) are distinct outcomes.
 *
 * `onBeatEnd` fires once, when a non-looping (outcome) clip finishes its
 * first playthrough — or immediately, for prefers-reduced-motion. The parent
 * (RitualStage) uses that to reveal the rest of the chrome only once the
 * clip has had its moment, per the approved staging.
 */

import { useEffect, useRef, useState } from 'react'
import { videoFor, type SceneState } from '../../scene/state'
import ambientClip from '../../../media/WitchConcocting.mp4'
import successClip from '../../../media/WitchSuccess.mp4'
import failureClip from '../../../media/Failure.mp4'
import ruptureClip from '../../../media/WitchDefeated.mp4'

type Clip = 'ambient' | 'success' | 'failure' | 'rupture'

const CLIP_SRC: Record<Clip, string> = {
  ambient: ambientClip,
  success: successClip,
  failure: failureClip,
  rupture: ruptureClip,
}

function clipFor(scene: SceneState): Clip {
  return videoFor(scene) ?? 'ambient'
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

export function VideoLayer({ scene, onBeatEnd }: { scene: SceneState; onBeatEnd: () => void }) {
  const clip = clipFor(scene)
  const looping = clip === 'ambient'
  const reduced = usePrefersReducedMotion()
  const videoRef = useRef<HTMLVideoElement>(null)

  // Reduced motion: no autoplay. Outcome clips jump straight to the final
  // hold frame and fire onBeatEnd right away so the chrome isn't stuck
  // waiting on a video that will never play.
  useEffect(() => {
    if (looping || !reduced) return
    const el = videoRef.current
    const finish = () => {
      if (el && Number.isFinite(el.duration) && el.duration > 0) {
        el.currentTime = Math.max(0, el.duration - 0.05)
      }
      onBeatEnd()
    }
    if (!el) {
      onBeatEnd()
      return
    }
    if (el.readyState >= 1) finish()
    else el.addEventListener('loadedmetadata', finish, { once: true })
  }, [reduced, clip, looping, onBeatEnd])

  return (
    <div className={`layer layer-video is-playing outcome-${clip}`} aria-hidden>
      <video
        key={clip}
        ref={videoRef}
        className="video-clip"
        src={CLIP_SRC[clip]}
        autoPlay={!reduced}
        muted
        loop={looping}
        playsInline
        preload="auto"
        onEnded={looping ? undefined : onBeatEnd}
      />
    </div>
  )
}
