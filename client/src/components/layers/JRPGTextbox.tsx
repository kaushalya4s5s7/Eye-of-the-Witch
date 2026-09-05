/**
 * The witch's voice. A classic RPG dialogue box pinned to the bottom of the
 * stage, showing exactly one line at a time — the most recent — rather than
 * a scrolling log.
 *
 * `tone: 'aside'` lines (raw ids, backend reason/error strings — see
 * src/copy/oracle.ts) are deliberately never shown here. That detail already
 * lives in the raw event terminal on the right side of the split; this box
 * only ever speaks in the fantasy register. During a quiet stretch (no new
 * seer/omen line yet) the box simply holds the last thing it said, which
 * reads as intentional rather than broken.
 */

import { useMemo } from 'react'
import type { NarrationEntry } from '../../scene/state'

function latestSpoken(entries: NarrationEntry[]): NarrationEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].tone !== 'aside') return entries[i]
  }
  return null
}

export function JRPGTextbox({ entries }: { entries: NarrationEntry[] }) {
  const latest = useMemo(() => latestSpoken(entries), [entries])

  return (
    <div className="jrpg-textbox">
      {latest && (
        <p key={latest.id} className={`jrpg-textbox__line tone-${latest.tone}`} aria-live="polite">
          {latest.line}
        </p>
      )}
    </div>
  )
}
