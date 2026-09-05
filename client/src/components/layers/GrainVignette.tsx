/**
 * Top layer, purely atmospheric: a film-grain + vignette wash so the stage
 * reads as one lit surface rather than stacked divs. Non-interactive.
 * Real grain texture / sigil work is build step 4; this is the CSS stand-in.
 */

export function GrainVignette() {
  return <div className="layer layer-grain" aria-hidden />
}
