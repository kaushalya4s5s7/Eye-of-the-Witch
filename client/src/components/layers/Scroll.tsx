/**
 * The witch's mark. Hard rule (client/CLAUDE.md): renders NOTHING until an
 * `Attested` event has produced a real seal. No placeholder, no fake hash.
 * `VerifyPassed` alone must never bring this on screen — only the seal does.
 *
 * The tx_hash is real (never synthesized) but never printed as a labelled
 * "transaction hash" field — it's shown as a row of rune glyphs, in-world.
 * The "Follow the star" link is the `easscan` field verbatim.
 */

import { scrollVisible, type SceneState } from '../../scene/state'

/** Split a real hash into hex byte-pairs for the rune row. Purely a display
 *  transform — the full hash still lives in scene.seal and the `title`
 *  attribute below; nothing here is invented. */
function runes(hash: string, count = 8): string[] {
  const hex = hash.replace(/^0x/, '')
  const out: string[] = []
  for (let i = 0; i < count && i * 2 < hex.length; i++) {
    out.push(hex.slice(i * 2, i * 2 + 2))
  }
  return out
}

export function Scroll({ scene }: { scene: SceneState }) {
  if (!scrollVisible(scene) || !scene.seal) return null

  const { txHash, easscan } = scene.seal

  return (
    <article className="rune-scroll" role="note" aria-label="the witch's mark">
      <h2 className="rune-scroll__title">The Witch Has Found You</h2>
      <p className="rune-scroll__flavor">
        Her eye closes. The mark is burned into the sky where it will never fade.
      </p>

      <div className="rune-row" title={txHash}>
        {runes(txHash).map((r, i) => (
          <span key={i} className="rune">
            {r}
          </span>
        ))}
      </div>

      {easscan && (
        <a className="rune-scroll__follow" href={easscan} target="_blank" rel="noreferrer noopener">
          Follow the star ↗
        </a>
      )}

      <p className={`rune-scroll__verify${scene.verified ? ' is-verified' : ''}`}>
        {scene.verified ? '✓ the sky was read back — the mark holds' : 'awaiting the sky to read it back…'}
      </p>
    </article>
  )
}
