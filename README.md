# Eye of the Witch — HH Goa 2026

**Face scan → live web/social search → matching post(s) → on-chain fingerprint → re-verify**,
wrapped in a split-screen ritual UI.

- **`backend/`** — the pipeline: `InsightFace` detection → live reverse-image
  search (SerpAPI: Google Lens, Yandex Images, Google Reverse Image) → Merkle
  root over accepted posts → attestation on EAS (Sepolia) → re-verify.
- **`client/`** — the UI. Left: fantasy/video ritual panel. Right: a real
  terminal (xterm.js) tailing a JSONL event stream from the backend. Its
  ground-truth spec — event schema, hard rules, UI state machine, build
  order — is [`client/CLAUDE.md`](client/CLAUDE.md). Read that first if
  you're working on the UI.

> The root-level `smoke_e2e.py` / `smoke_full.py` / `samples/` / `requirements.txt`
> are the pipeline's original, pre-UI form (kept for history). `backend/`
> holds the copy the client's dev bridge actually drives; that's the one to
> run against day to day.

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

## Running the pipeline (backend)

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Create `.env` in `backend/` (never commit it):

```bash
SERPAPI_API_KEY=...
IMGBB_API_KEY=...
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
PRIVATE_KEY=0x...   # Sepolia-funded wallet; rotate if ever exposed
```

---

## How to run

**Full pipeline** (multi-engine + seed gallery + graph + anchor gate + EAS):

```bash
# One photo (minimum)
.venv/bin/python smoke_full.py samples/elon_musk.jpg

# Better match: 2–5 photos of the same person (first = primary for reverse search)
.venv/bin/python smoke_full.py samples/photo1.jpg samples/photo2.jpg samples/photo3.jpg
```

**Leaner E2E** (Lens-only path; also accepts multiple images):

```bash
.venv/bin/python smoke_e2e.py --insightface samples/elon_musk.jpg samples/other_angle.jpg
```

## Deep optimization (research-backed)

Enabled by default in `smoke_full.py`:

1. **Quality coreset** — pick best 1–2 seed crops (det_score + sharpness) for reverse search  
2. **Multi-probe discovery** — reverse-search each coreset crop, merge URLs  
3. **Quality-weighted gallery score** — not naive max alone  
4. **Owner vector blend** — average strong hit faces, re-score (cross-profile matching)  
5. **Neighbor consistency** — boost hits that agree with other strong matches  

```bash
.venv/bin/python smoke_full.py samples/D1.png samples/D2.png samples/D3.png samples/D4.png
```

Artifacts land in `backend/runs/<run_id>/`:

| File | Purpose |
|---|---|
<<<<<<< Updated upstream
| `events.jsonl` | Live run events (drives the client's terminal + ritual panel) |
=======
| `events.jsonl` | Live run events (for UI / demo terminal) |
| `gallery.json` | Seed gallery (kept/rejected multi-photo inputs) |
>>>>>>> Stashed changes
| `accepted.json` | Matching posts used for Merkle |
| `anchor.json` | Dual-confirm anchor (if any) |
| `merkle.json` | Root + leaves |
| `attest.json` | tx hash, attestation UID, EASScan link |
| `verify.json` | Local rebuild + on-chain match + tamper check |
| `graph.json` | Evidence graph snapshot |
| `smoke_report.json` | Pass / no-match / fail summary |

Exit codes: `0` pass · `2` no match (no chain write) · `1` hard failure.

---

## Running the UI (client)

```bash
cd client
npm install
npm run dev
```

By default it plays back a committed fixture (`client/fixtures/*.jsonl`) — no
backend run needed. See [`client/CLAUDE.md`](client/CLAUDE.md) for the event
contract, fixture list, and how to point it at a live `backend/` run instead.

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
| InsightFace cosine vs **seed gallery** | Same person — `max` sim over 1..N user photos (pose/light variations OK) |
| Average hash near-exact | Same *photo* nominee vs any seed crop |
| **Dual confirm** | Near-exact **and** face_sim ≥ τ → `AnchorLocked`; expand only then |
| Seed gallery always wins | Exact DP without face match to gallery → rejected (no poison cascade) |
| Multi-photo tip | More public photos of the same person → sharper web ranking |
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
- Gallery-from-profile enrichment (plan Slice II scrape) is **not** implemented — **user multi-photo seed gallery** is the supported path instead.
- Face thresholds are tuned for smoke demos; lookalikes can still score in the mid band.
- `runs/`, `backend/runs/`, and `.env` are gitignored; share demo artifacts separately if needed.
- If a private key was ever pasted in chat, **rotate** it.

---

## Repo layout

```text
backend/                   canonical pipeline (run this day to day)
  smoke_e2e.py
  smoke_full.py
  requirements.txt
  samples/
client/                    the ritual UI
  CLAUDE.md                ground-truth doc (read every session)
  fixtures/                hand-authored JSONL event runs for dev
  media/                   AI-generated video clips
  src/                     the UI
docs/                      design specs and implementation plans
smoke_e2e.py, smoke_full.py, requirements.txt, samples/   original
  pre-UI pipeline copy, kept for history — see the backend/ note above
architecture.md            pipeline architecture notes
events_contract.md         UI event schema
intelligent_search_plan.md
idea.md
ryuk_handoff.md
```

## Task checklist

- [x] Face detect + encode
- [x] Genuine live web/social search → ≥1 matching post
- [x] Hash / fingerprint on chain + re-verify
- [x] No website required (pipeline runs standalone via `backend/`)
- [x] Split-screen ritual UI wired to live pipeline events
- [x] GitHub-ready source + this README
