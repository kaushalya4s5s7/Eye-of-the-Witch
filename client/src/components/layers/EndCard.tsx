/**
 * The failure ending. Hard rule (client/CLAUDE.md): `empty` (NoMatchFound)
 * and `broken` (Failed) stay two distinct outcomes — same staging, same
 * temporary clip, but different copy and tone. `broken` is a real pipeline
 * error (violent framing: the hero cut her down before she finished).
 * `empty` is a clean search that simply found nobody (soft framing: nothing
 * went wrong, there was just no one there).
 *
 * Renders nothing outside those two phases.
 */

import type { Phase } from '../../scene/state'

const COPY: Partial<Record<Phase, { title: string; body: string }>> = {
  broken: {
    title: 'The Destined One Was Not Found',
    body: "The hero's blade found her first. Whatever she was chasing, she took the answer with her.",
  },
  empty: {
    title: 'The Destined One Could Not Be Found',
    body: 'The witch searched every reflection she owns. None of them were you.',
  },
}

export function EndCard({ phase }: { phase: Phase }) {
  const copy = COPY[phase]
  if (!copy) return null

  return (
    <div className="end-card">
      <h2 className="end-card__title">{copy.title}</h2>
      <p className="end-card__body">{copy.body}</p>
    </div>
  )
}
