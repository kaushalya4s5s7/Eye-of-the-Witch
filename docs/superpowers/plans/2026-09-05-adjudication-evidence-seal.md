# Adjudication bands + evidence-bundle seal — Implementation Plan

> **For Claude:** Implement with checkboxes. Core stays on-brief: search proposes → encoder decides → seal whole check → re-verify.

**Goal:** Use math that changes accept/reject decisions (gray bands + dual-confirm reject), and Merkle-seal the **adjudication evidence bundle** (not only winning URLs), then wire events/docs/backend/client.

**Architecture:** Keep face→search→rank→chain. Add `decision ∈ {accept,abstain,reject}` from τ bands; build `evidence.json` + Merkle leaves over probe + per-candidate verdicts + accepted posts; emit `AdjudicationCompleted` / richer `MerkleBuilt`. Expand remains optional; AnchorLocked stays expand-gate only.

**Tech Stack:** Python (`smoke_e2e.py` / `smoke_full.py`), EAS Sepolia, client schema + terminal formatter.

---

## File map

| File | Change |
|---|---|
| `smoke_e2e.py` | τ bands, `decide_verdict()`, enrich scored rows, `step_merkle_evidence()` |
| `smoke_full.py` | Emit adjudication events; call evidence merkle; keep accepted for UI |
| `backend/smoke_*.py` | Sync from root after root works |
| `events_contract.md` | Document new/updated events |
| `docs/pipeline-friendly-guide.md` + `README.md` | Seal-whole-check + bands |
| `client/src/lib/schema.ts`, `terminalFormat.ts`, fixtures | Open events + clean log lines |

---

### Task 1: Decision math in `smoke_e2e.py`

**Files:** Modify `smoke_e2e.py`

- [x] Add constants:
  - `TAU_REJECT = 0.20` — below → reject
  - `TAU_ACCEPT = 0.25` — at/above → accept (align with current `min_face_sim` in full)
  - Gray band = `(TAU_REJECT, TAU_ACCEPT)` → abstain (not sealed as match)
- [x] Add `decide_verdict(sim, *, near_exact, phash_distance) -> str`:
  - if `near_exact` and `sim < TAU_ANCHOR_FACE` → **reject** (poison DP)
  - elif `sim is None` → reject / skip
  - elif `sim >= TAU_ACCEPT` → accept
  - elif `sim >= TAU_REJECT` → abstain
  - else → reject
- [x] In `step_accept`, set `decision` on every scored row; write counts into `candidates_ranked.json`
- [x] Eligible accepted = `decision == "accept"` only (not abstain)

### Task 2: Evidence Merkle seal

**Files:** Modify `smoke_e2e.py`

- [x] Add `step_merkle_evidence(out_dir, *, probe_meta, all_scored, accepted) -> str`
- [x] Leaves (deterministic sorted):
  1. `probe|{embedding_sha256}|{gallery_size}`
  2. For each scored candidate (cap e.g. top 64 by |sim| then url):  
     `verdict|{url}|{content_hash}|{sim or n/a}|{decision}|{engine}`
  3. For each accepted: `accept|{url}|{content_hash}|{engine}|{observed_at}`
- [x] Write `evidence.json` + `merkle.json` (root, leaf kinds, counts)
- [x] `step_verify` still rebuilds from the same leaf recipe (read evidence.json)

### Task 3: Wire `smoke_full.py`

- [x] After `step_accept`, emit `AdjudicationCompleted` with `{scored, accept, abstain, reject, tau_accept, tau_reject}`
- [x] Optionally emit a few `CandidateScored` for top accepts (or skip to avoid spam — prefer one summary event)
- [x] Replace `step_merkle(merkle_set)` with `step_merkle_evidence(...)`
- [x] `MerkleBuilt` payload adds `evidence_leaves`, `accept_count`, `mode: "adjudication_bundle"`

### Task 4: Events contract + docs

- [x] `events_contract.md`: promote `CandidateScored` usage notes; add `AdjudicationCompleted`; extend `MerkleBuilt`
- [x] `pipeline-friendly-guide.md` + README: seal-whole-check + decision bands

### Task 5: Backend sync + client

- [x] Copy root → `backend/`
- [x] Client: schema open events; terminal stages for adjudication; fixture lines

### Task 6: Verify

- [x] Unit-level: `decide_verdict` cases
- [x] Dry run merkle determinism without chain if possible
- [x] Client `npm test`

---

## Out of scope (not this plan)

Edit-tracking / live drift / SUPERSEDES history. Anchor expand remains as-is.
