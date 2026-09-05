/**
 * The posts found, shown as loot/trading cards under the scroll. Renders
 * nothing until scene.stars is populated (@StarsResolved) — same
 * empty-until-real-data rule as Scroll.
 *
 * Rarity stars are a presentational read of `faceSim` (0..1 -> 1..5 stars),
 * not a new backend concept. The rarity tier (common/rare/legendary) is the
 * same read, used only for the card's border treatment.
 *
 * Thumbnails are third-party CDN URLs (client/CLAUDE.md: "render with <img>
 * only ... show placeholder art on error") — real runs' Google/Yandex links
 * may hotlink-block or expire. `onError` catches an outright fetch failure;
 * it does NOT catch the committed fixtures' placeholder URLs, which resolve
 * as real (but 1x1, content-less) tracking-pixel images rather than 404ing —
 * so `onLoad` also checks `naturalWidth` and treats a degenerate image as a
 * failure too. Either path swaps in a decorative sigil rather than leaving a
 * broken or blank thumbnail.
 */

import { useState } from 'react'
import { host } from '../../copy/oracle'
import type { Star } from '../../scene/state'

function rarityCount(sim: number): number {
  return Math.max(1, Math.min(5, Math.round(sim * 5)))
}

function rarityGlyphs(filled: number): string {
  return '★'.repeat(filled) + '☆'.repeat(5 - filled)
}

function rarityTier(filled: number): 'legendary' | 'rare' | 'common' {
  if (filled >= 5) return 'legendary'
  if (filled >= 4) return 'rare'
  return 'common'
}

function LootCard({ star }: { star: Star }) {
  const [artFailed, setArtFailed] = useState(false)
  const filled = rarityCount(star.faceSim)
  const label = star.title || host(star.url)

  return (
    <a
      className={`loot-card loot-card--${rarityTier(filled)}`}
      href={star.url}
      target="_blank"
      rel="noreferrer noopener"
      title={label}
    >
      <span className="loot-card__art">
        {artFailed ? (
          <span className="loot-card__art-fallback" aria-hidden>
            ✦
          </span>
        ) : (
          <img
            src={star.thumbnail}
            alt=""
            onError={() => setArtFailed(true)}
            onLoad={(e) => {
              const img = e.currentTarget
              if (img.naturalWidth <= 1 || img.naturalHeight <= 1) setArtFailed(true)
            }}
          />
        )}
      </span>
      <span className="loot-card__title">{label}</span>
      <span className="loot-card__stars" aria-hidden>
        {rarityGlyphs(filled)}
      </span>
    </a>
  )
}

export function LootGallery({ stars }: { stars: Star[] }) {
  if (stars.length === 0) return null

  return (
    <div className="loot-gallery">
      {stars.map((s) => (
        <LootCard key={s.url} star={s} />
      ))}
    </div>
  )
}
