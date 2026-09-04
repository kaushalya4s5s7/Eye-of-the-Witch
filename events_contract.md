# Event contract (KC → Ryuk) — lock before UI step 2

Ground truth = what `smoke_full.py` actually emits today in `runs/full-*/events.jsonl`.  
`ryuk_handoff.md` was a vibe brief, **not** a closed schema. Your CLAUDE.md 13-type list is **stricter than the pipeline** — align both ways now.

---

## 1) Is the event list final?

**No — not if CLAUDE.md only has 13 types and drops unknowns.**

### Types emitted in real success runs today

| event | Notes |
|---|---|
| `FaceDetected` | always |
| `ImageHosted` | always |
| `ImageSearchRequested` | always (lists engines) |
| `ImageSearchCompleted` | **once per engine that returns** |
| `ImageSearchFailed` | per engine that errors (still continue) |
| `SearchMerged` | after all engines |
| `PostAccepted` | summary (count + top_sim) — **not one event per post yet** |
| `ExpandSkipped` | when expand gate fails |
| `ExpandRequested` | when expand starts |
| `ExpandCompleted` | when expand finishes |
| `GraphUpserted` | after NetworkX write |
| `MerkleBuilt` | always on success path |
| `Attesting` | before chain tx |
| `Attested` | after tx |
| `VerifyPassed` | after re-verify OK |
| `Failed` | terminal on crash / hard error |

### Types you assumed that pipeline does **not** emit yet

`ConsentBound`, `CandidateScored`, `VerifyFailed`, `NoMatchFound`

**KC decision for step 2:**

- **Allowlist for terminal = union of “emitted today” + your planned terminals.**  
- Unknown events → show as `! off-schema` in terminal (keep), but **do not hard-crash** the left panel.  
- Pipeline will add `NoMatchFound` / `VerifyFailed` / per-post `PostAccepted` / optional `CandidateScored` soon — reserve those names now.

**Recommended closed vocabulary (v1 — treat as the contract):**

```text
FaceDetected
ImageHosted
ImageSearchRequested
ImageSearchCompleted
ImageSearchFailed
SearchMerged
CandidateScored          # reserved (optional later; ignore if absent)
PostAccepted             # may fire once (summary) OR once per post — see §7
ExpandSkipped
ExpandRequested
ExpandCompleted
GraphUpserted
MerkleBuilt
Attesting
Attested
VerifyPassed
VerifyFailed             # reserved
NoMatchFound             # reserved
Failed
ConsentBound             # reserved / unused for demo — treat as log-only if ever sent
```

---

## 2) Envelope shape — REAL vs your fixture

**Real lines today are FLAT + optional envelope fields mixed in:**

```json
{"ts":"2026-09-04T11:06:15.859236+00:00","event":"FaceDetected","backend":"insightface_buffalo_s","det_score":0.8127,"embedding_sha256":"..."}
```

**Not** nested `{ "event", "data": { ... } }`.  
**Not** your exact FaceDetected fixture fields (`face_bbox`, `embedding_id`, `confidence`).

### Actual FaceDetected fields today
`ts`, `event`, `backend`, `det_score`, `embedding_sha256`

### Actual Attested fields today
`ts`, `event`, `tx_hash`, `uid`, `easscan`

### KC recommendation (adopt your proposal)

Validator should accept:

```text
REQUIRED:  "event": string
OPTIONAL envelope (ignore for left-panel FSM): ts, seq, run_id
PAYLOAD:   remaining keys (closed per event type, versioned)
```

Do **not** require a `data` wrapper unless we migrate both sides together.  
**Today = flat.** Your “optional ignored envelope” is correct — implement that.

---

## 3) Left-panel reactions (KC semantics)

| Event | Left panel | Terminal |
|---|---|---|
| `ConsentBound` | none (unused) | log only if ever appears |
| `ImageHosted` | optional: show crop URL / “bound” | yes |
| `ImageSearchRequested` / `Completed` / `Failed` / `SearchMerged` | stay on **concoction** | yes |
| `CandidateScored` | **no** per-candidate UI (too noisy) | optional log |
| `PostAccepted` | **yes** — gallery update (see §7) | yes |
| `Expand*` / `GraphUpserted` | stay concoction / subtle | yes |
| `MerkleBuilt` | subtle “seal forming” optional | yes |
| `Attesting` | **chant / text-reveal** | yes |
| `Attested` | success video + **scroll** with hash | yes |
| `VerifyPassed` | scroll stays / small ✓ under hash | yes |
| `VerifyFailed` | distinct fail ritual (not same as Failed) | yes |
| `NoMatchFound` | empty cauldron / “no truth found” | yes |
| `Failed` | hard fail / broken ritual | yes |

**VerifyPassed vs Attested:** scroll + hash on `Attested`; `VerifyPassed` = confirmation badge only (don’t re-trigger success video).

---

## 4) `NoMatchFound` vs `Failed`

| Condition | Event |
|---|---|
| Engines return hits but **none** pass face/social accept thresholds | `NoMatchFound` *(to be emitted)* |
| All engines return 0 usable hits / merged unique = 0 | `NoMatchFound` |
| Exception, bad image, no face, API key hard fail, RPC fail, attest revert | `Failed` with `error` string (today) + later `stage` |
| Consent refusal (if we add consent) | `Failed` stage=`consent` or skip demo |

**Possible `Failed.stage` values (when we add them):**  
`face` | `host` | `search` | `accept` | `expand` | `merkle` | `attest` | `verify` | `unknown`

Today `Failed` only has `error` string — UI should read `error`, treat missing `stage` as `unknown`.

---

## 5) Terminal-event guarantee

**Today: NO hard guarantee.**  
Success runs end with `VerifyPassed`.  
Hard errors emit `Failed`.  
Process kill → **stream can stop with no terminal event.**

**UI must handle:** “stream ended / process exit ≠ 0 / timeout with no terminal” → treat as `Failed` locally (`stage=unknown`, reason=`stream_ended`).

**Target contract:** every run ends with exactly one of  
`VerifyPassed` | `VerifyFailed` | `NoMatchFound` | `Failed`.

---

## 6) Transport

| Question | Answer now |
|---|---|
| Mechanism | **File** append: `runs/<run_id>/events.jsonl` (and/or stdout later) |
| Readable by UI? | Yes if UI runs on same machine / same repo root |
| Path | Repo-relative: `runs/<run_id>/events.jsonl` |
| Format | Append-only, **one JSON object per line**, flushed per event |
| `run_id` discovery | Folder name = `full-<timestamp>-<hex>` or plain `<id>`; UI should get `run_id` from **pipeline start response** / CLI stdout first line / arg. Optional `runs/latest` symlink — **not implemented yet**; don’t depend on it until KC adds it |
| One run per file? | **Yes** — one directory per run, one `events.jsonl` |

---

## 7) Field formats (honest vs desired)

| Field | Today | Lock for UI |
|---|---|---|
| bbox | **not in events** (only in `face.json` as `[x1,y1,x2,y2]` pixels on source) | If emitted: `[x1,y1,x2,y2]` pixels, source image |
| confidence / face_sim | `det_score` 0–1; `top_sim` 0–1 on PostAccepted | treat as 0–1 floats |
| `PostAccepted` | **once**, `{count, top_sim}` — posts live in `accepted.json` | **Short-term:** on `PostAccepted`, UI reads `runs/<id>/accepted.json` for gallery. **Soon:** one `PostAccepted` per post with `url`, `thumbnail`, `face_similarity`, `title` |
| `MerkleBuilt.leaf_count` | **not emitted** (only `root`) | optional later; leaf count ≈ face-scored merkle set, not expand-only rows |
| `Attested` with 0 posts | should not happen on happy path; pipeline should `NoMatchFound` instead | UI: if Attested with empty gallery, show hash anyway but flag odd |
| multiple `ImageSearchCompleted` | **YES** — one per engine | expected |

---

## 8) Asset URLs

| Field | Today |
|---|---|
| `ImageHosted.url` | Absolute HTTPS imgbb — public |
| Post thumbnails | In `accepted.json` as Google/Yandex CDN thumbs — HTTPS, may hotlink-block / expire; **CORS not guaranteed** |
| Fallback | Placeholder art if thumb 404 |

UI should not assume CORS; use `<img>` tags (no canvas fetch) or proxy later.

---

## 9) Attestation

- Network: **Sepolia**  
- Backend already sends **both** `tx_hash` and `easscan` on `Attested`  
- Also sends `uid`  
- UI uses event fields as-is (don’t invent explorer URLs)

---

## 10) Timing (from real runs)

| Phase | Rough |
|---|---|
| Face + host | ~2–5s |
| Multi-engine search | ~3–10s |
| Face-rank all thumbs | **~30–90s** (longest silence risk) |
| Expand + graph + merkle | ~1–5s |
| Attest + verify | ~5–15s |
| Full success | **~1–2 minutes** typical |

**Longest gap:** between `SearchMerged` and `PostAccepted` (scoring).  
No heartbeat today. UI: concoction loops until next event; show terminal “scoring candidates…” if idle >5s after `SearchMerged`.

---

## The one ask — real fixtures (paths)

Use these now (already on disk):

**Success (full path, expand fired):**  
`runs/full-20260904T112413Z-0f9c6d60/events.jsonl`  
(+ `accepted.json`, `attest.json`, `graph.json`)

**Success (expand skipped):**  
`runs/full-20260904T110615Z-13cf0e62/events.jsonl`

**Failed (no face):**  
`runs/full-20260904T110555Z-f3fa465b/events.jsonl`

**Failed (bad path):**  
`runs/full-20260904T110536Z-8feaba99/events.jsonl`

`NoMatchFound` fixture: **not captured yet** — KC will add a forced no-match run; until then UI can stub it.

---

## Verdict on teammate assumptions

| Assumption | Verdict |
|---|---|
| Event list final as 13 CLAUDE types | **Wrong** — pipeline already emits more; several CLAUDE types don’t exist yet |
| Flat exact fixture fields | **Wrong** — flat yes, field names differ |
| Optional envelope (`ts`, …) | **Right — do that** |
| File tail `runs/<id>/events.jsonl` | **Right** |
| Sepolia + easscan in event | **Right** |
| Terminal always emitted | **Wrong today** — handle stream death |
| Per-candidate left panel | **Don’t** — only `PostAccepted` / accepted.json |
| VerifyFailed / NoMatchFound UI | **Right to demand** — reserve now, pipeline to follow |

**Bottom line:** clear step 2 on **real events.jsonl + this contract**, not on an unpublished CLAUDE 13-list alone. Diff fixtures against validator before more UI steps.
