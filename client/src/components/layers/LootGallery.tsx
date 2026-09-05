/**
 * The posts found, shown as loot/trading cards under the scroll. Renders
 * nothing until scene.stars is populated (@StarsResolved) — same
 * empty-until-real-data rule as Scroll.
 *
 * Rarity stars are a presentational read of `faceSim` (0..1 -> 1..5 stars),
 * not a new backend concept.
 */

import { host } from '../../copy/oracle'
import type { Star } from '../../scene/state'

function rarity(sim: number): string {
  const filled = Math.max(1, Math.min(5, Math.round(sim * 5)))
  return '★'.repeat(filled) + '☆'.repeat(5 - filled)
}

export function LootGallery({ stars }: { stars: Star[] }) {
  if (stars.length === 0) return null

  return (
    <div className="loot-gallery">
      {stars.map((s) => (
        <a
          key={s.url}
          className="loot-card"
          href={s.url}
          target="_blank"
          rel="noreferrer noopener"
          title={s.title || host(s.url)}
        >
          <span className="loot-card__art" style={{ backgroundImage: `url("${s.thumbnail}")` }} />
          <span className="loot-card__title">{s.title || host(s.url)}</span>
          <span className="loot-card__stars">{rarity(s.faceSim)}</span>
        </a>
      ))}
    </div>
  )
}
