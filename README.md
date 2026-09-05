# HH Goa 2026 — Face → Web Search → Blockchain Verify

End-to-end pipeline for the shortlisting task:

**Face scan → live web/social search → matching post(s) → on-chain fingerprint → re-verify**

No website. CLI pipeline only.

---

## What it does

1. **Face identification** — Detect and encode a face from an input image (`InsightFace` buffalo_s).
2. **Web / social search** — Host the face crop (imgbb), run **live** reverse-image search via SerpAPI (Google Lens, Yandex Images, Google Reverse Image). Rank hits by face similarity to the **seed** face. Prefer social domains. Not hardcoded.
3. **Blockchain verification** — Build a Merkle root over accepted post leaves, attest `bytes32 contentHash` on **EAS (Ethereum Attestation Service) Sepolia**, then rebuild the root and check it against the on-chain attestation.

Optional intelligence (still the same pipeline shape):

- **Near-exact image** detection (average hash) + **dual confirm** with seed face before locking an Anchor.
- Expand / gated hop only if `AnchorLocked` (prevents junk and poison-DP cascades).
- Evidence graph snapshot (`graph.json`) for the run.

---

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Create `.env` in the repo root (never commit it):

```bash
SERPAPI_API_KEY=...
IMGBB_API_KEY=...
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
PRIVATE_KEY=0x...   # Sepolia-funded wallet; rotate if ever exposed
```

---

## How to run

**Full pipeline** (multi-engine + graph + anchor gate + EAS):

```bash
.venv/bin/python smoke_full.py samples/elon_musk.jpg
# or your own public-figure / own public photo:
.venv/bin/python smoke_full.py path/to/face.jpg
```

**Leaner E2E** (Lens-only path):

```bash
.venv/bin/python smoke_e2e.py --insightface samples/elon_musk.jpg
```

Artifacts land in `runs/<run_id>/`:

| File | Purpose |
|---|---|
| `events.jsonl` | Live run events (for UI / demo terminal) |
| `accepted.json` | Matching posts used for Merkle |
| `anchor.json` | Dual-confirm anchor (if any) |
| `merkle.json` | Root + leaves |
| `attest.json` | tx hash, attestation UID, EASScan link |
| `verify.json` | Local rebuild + on-chain match + tamper check |
| `graph.json` | Evidence graph snapshot |
| `smoke_report.json` | Pass / no-match / fail summary |

Exit codes: `0` pass · `2` no match (no chain write) · `1` hard failure.

---

## Blockchain used

| Item | Value |
|---|---|
| Network | **Ethereum Sepolia** (public testnet) |
| System | **EAS** — `0xC2679fBD37d54388Ce493F1DB75320D236e1815e` |
| Schema | `bytes32 contentHash` — UID `0xdf4c41ea0f6263c72aa385580124f41f2898d3613e86c50519fc3cfd7ff13ad4` |
| What is attested | Merkle root over accepted leaves (`url\|content_hash\|engine\|observed_at`) |
| Re-verify | Rebuild Merkle from `accepted.json`; compare to attestation `contentHash` via `getAttestation` |

Explorer links are written to `attest.json` (`easscan`, `tx_url`).

---

## Matching rules (honest)

| Signal | Role |
|---|---|
| InsightFace cosine vs **seed** | Same person (pose/light variations OK) |
| Average hash near-exact | Same *photo* nominee only |
| **Dual confirm** | Near-exact **and** face_sim ≥ τ → `AnchorLocked`; expand only then |
| Seed always wins | Exact DP without face match to seed → rejected (no poison gallery) |

This is **similarity evidence**, not legal identity proof.

---

## Privacy / demo ethics

- Use **publicly indexed** images (public figure or your own public photo).
- Do not target private accounts or non-consensual personal searches for demos.
- Search engines and CDNs may block or expire thumbnails; hashes saved at accept time remain for verify.

---

## Known limitations

- Relies on third-party APIs (SerpAPI, imgbb) and free RPC rate limits.
- Social hotlink / scrape limits: we score **thumbnails** from search results, not full private profiles.
- Gallery-from-profile enrichment (plan Slice II) is **not** implemented — brief is satisfied without it.
- Face thresholds are tuned for smoke demos; lookalikes can still score in the mid band.
- `runs/` and `.env` are gitignored; share demo artifacts separately if needed.
- If a private key was ever pasted in chat, **rotate** it.

---

## Repo layout

```text
smoke_e2e.py              # core steps + lean E2E
smoke_full.py             # full multi-engine + anchor + graph + events
requirements.txt
samples/                  # demo images
runs/                     # local run artifacts (gitignored)
events_contract.md        # UI event schema (optional teammate)
intelligent_search_plan.md
architecture.md
```

---

## Task checklist

- [x] Face detect + encode  
- [x] Genuine live web/social search → ≥1 matching post  
- [x] Hash / fingerprint on chain + re-verify  
- [x] No website required  
- [x] GitHub-ready source + this README  
