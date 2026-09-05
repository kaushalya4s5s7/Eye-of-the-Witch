/**
 * Sound cues. No-op-safe: if an audio file is missing (they are not committed
 * yet — build step 5), play() silently does nothing. Never throws, never
 * blocks a render.
 *
 * Wire real one-shots into `SOURCES` in step 5. Keep them CC0.
 */

export type Cue = 'star-fix' | 'chant' | 'unfurl' | 'seal' | 'rupture'

const SOURCES: Partial<Record<Cue, string>> = {
  // 'star-fix': '/audio/star-fix.ogg',
  // 'chant':    '/audio/chant.ogg',
  // 'unfurl':   '/audio/unfurl.ogg',
  // 'seal':     '/audio/seal.ogg',
  // 'rupture':  '/audio/rupture.ogg',
}

const cache = new Map<Cue, HTMLAudioElement>()

function element(cue: Cue): HTMLAudioElement | null {
  const src = SOURCES[cue]
  if (!src) return null
  let el = cache.get(cue)
  if (!el) {
    el = new Audio(src)
    el.preload = 'auto'
    cache.set(cue, el)
  }
  return el
}

export function play(cue: Cue, volume = 0.6): void {
  const el = element(cue)
  if (!el) return
  try {
    el.currentTime = 0
    el.volume = volume
    void el.play().catch(() => {})
  } catch {
    /* autoplay policy / decode error — inaudible, not fatal */
  }
}
