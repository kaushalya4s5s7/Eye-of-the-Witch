import type { ReactNode } from 'react'

/**
 * The shell: left ritual UI, right terminal, a seam between them.
 * Layout only — it holds no event logic.
 */
export function SplitShell({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="split-shell">
      <section className="pane pane-left">{left}</section>
      <div className="pane-seam" aria-hidden />
      <section className="pane pane-right">{right}</section>
    </div>
  )
}
