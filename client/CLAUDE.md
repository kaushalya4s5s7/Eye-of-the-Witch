# Project: Eye of the Witch, UI side (Ryuk's task)

Split-screen ritual UI. Left: fantasy/video UI. Right: real terminal (xterm.js)
tailing a JSONL event stream from the backend pipeline.

This repo only consumes events. No backend logic lives here.

## Hard rules
- Never invent pipeline steps. The left panel reacts only to events in the
  vocabulary below. The terminal shows every line it receives: known events
  formatted, anything off-schema shown verbatim with a `! off-schema` marker.
- An unknown or malformed event must never crash the left panel. It is a
  no-op for the state machine.
- The scroll component renders zero content until an `Attested` event arrives.
  No placeholder or hardcoded tx hash, ever.
- `VerifyPassed` is a confirmation badge only. It must not re-trigger the
  success video and must not, by itself, unfurl the scroll — only `Attested`
  does that.
- `NoMatchFound`, `Failed`, and `VerifyFailed` are three different states with
  three different UI outcomes. Do not merge them.
- There is no guaranteed terminal event. If the stream ends with no
  `VerifyPassed` / `VerifyFailed` / `NoMatchFound` / `Failed`, synthesize a
  local `Failed { stage: "unknown", error: "stream_ended" }`.

## Event contract (v1 — from KC, reconciled 2026-09-04)

Ground truth is what the pipeline's `smoke_full.py` emits into
`runs/<run_id>/events.jsonl`. The earlier 13-type list was a vibe brief, not a
closed schema. `src/lib/schema.ts` mirrors this section; if one changes, change
both, and `schema.test.ts` fails until the fixtures agree.

### Envelope

Events are **flat** JSON objects, one per line. Not nested under `data`.

- `event` — string, **required**, the discriminator.
- `ts`, `seq`, `run_id` — optional envelope fields that may appear on **any**
  event. The state machine ignores them. The validator allows them everywhere.
- All other keys are the payload, closed per event type (below), versioned.

### Emitted today — closed payloads (validator enforces exact fields)

```
FaceDetected          { backend, det_score, embedding_sha256 }
ImageHosted           { url }                       # public imgbb HTTPS
ImageSearchCompleted  { engine, hits }              # ONE PER ENGINE that returns
PostAccepted          { count, top_sim }            # summary; gallery = accepted.json
MerkleBuilt           { root }                      # no leaf_count today
Attesting             { root }                      # same value as MerkleBuilt.root
Attested              { tx_hash, uid, easscan }     # Sepolia; use as-is
Failed                { error, stage? }             # real runs never send stage -> "unknown"
```

`Failed.stage`, when present: `face | host | search | accept | expand | merkle |
attest | verify | unknown`.

### Emitted today — open payloads (name must be valid; fields not yet locked)

```
ImageSearchRequested   { engines, image_url }
ImageSearchFailed      { engine, error }             # pipeline continues
SearchMerged           { unique, by_engine }         # by_engine: {engine: count}
ExpandRequested        { query, from_url, handle }   # handle may be null
ExpandCompleted        { found, query }
ExpandSkipped          { reason }
GraphUpserted          { nodes, edges }
VerifyPassed           { root, uid }                 # re-verify OK -> badge only
```

These validate as long as `event` is a known name; their payloads pass
through untouched. Field shapes above are confirmed against the four real
`runs/full-*/events.jsonl` reconciled 2026-09-04 (see below) — still "open"
tier by design (not yet contractually locked), but the reducer/oracle read
these exact real field names now, not placeholders.

### Reserved — names locked, pipeline to follow (validate as open, mostly no UI)

```
CandidateScored   { url, face_sim, source_trust, decision }  # terminal log only, NO left-panel UI
VerifyFailed      { matched: false, reason }                 # distinct fail ritual
NoMatchFound      { candidates_checked, reason }             # empty-cauldron state, scroll never renders
ConsentBound      { consent_hash }                           # unused for demo; log-only if ever sent
```

### Field formats

- `det_score`, `top_sim`, `face_sim`, `source_trust` — floats 0–1.
- bbox is not in events today (only in `face.json` as `[x1,y1,x2,y2]` pixels).
- `PostAccepted` fires **once** as a summary. On it, read
  `runs/<run_id>/accepted.json` for the gallery: entries carry
  `url`, `thumbnail`, `face_similarity`, `title`. Per-post `PostAccepted`
  events (with those fields inline) come later.
- Post thumbnails are third-party CDN URLs (Google / Yandex). HTTPS, may
  hotlink-block or expire, **CORS not guaranteed** — render with `<img>` only
  (no canvas fetch / `getImageData`), show placeholder art on error.
- `Attested` carries `tx_hash`, `uid`, `easscan`. Do not synthesize explorer
  URLs — use the `easscan` field.

## Transport

- File append: `runs/<run_id>/events.jsonl`, append-only, one JSON object per
  line, flushed per event. One directory per run.
- Sidecars in the same directory: `accepted.json` (gallery), `attest.json`,
  `graph.json`, `face.json`.
- `run_id` comes from the pipeline start response / CLI stdout first line /
  arg. No `runs/latest` symlink yet — do not depend on one.
- `runs/` is gitignored (real data). `fixtures/` holds committed stand-ins.
- Dev: a Vite plugin (`vite-plugins/jsonl-sse.ts`) tails a fixture and pushes
  lines over SSE at `/dev/events`; sidecars at `/dev/run-file`. Step 8 points
  the same client code at a real `runs/<run_id>/`.

## Timing (from real runs)

- Face + host ~2–5 s. Multi-engine search ~3–10 s. Face-rank all thumbs
  **~30–90 s** (longest silence). Expand + graph + merkle ~1–5 s. Attest +
  verify ~5–15 s. Full success **~1–2 min**.
- Longest gap: between `SearchMerged` and `PostAccepted`. No heartbeat. If
  idle > 5 s there, the terminal shows "scoring candidates…" and the left
  panel holds a "weighing the lights" state.

## UI state machine (event -> left panel phase)

Phases: `idle -> scrying -> weighing -> weaving -> naming -> fixed`, with
`empty` (NoMatchFound) and `broken` (Failed) as terminal off-ramps.

```
FaceDetected            idle -> scrying; photo/likeness lock
ImageHosted             record hosted url
ImageSearch*            stay scrying (concoction loop)
SearchMerged            scrying -> weighing
CandidateScored         terminal only; no left-panel change
PostAccepted            weighing -> weaving; fetch accepted.json -> stars fix in
Expand* / GraphUpserted stay weaving (subtle)
MerkleBuilt             constellation lines draw; figure gets its name
Attesting               weaving -> naming; chant / text-reveal
Attested                naming -> fixed; success video; scroll unfurls (real tx_hash + easscan)
VerifyPassed            verified = true; small check under the hash; NO video, NO phase change
VerifyFailed            distinct fail ritual (reserved)
NoMatchFound            -> empty; failure video; scroll never renders (reserved)
Failed                  -> broken; rendered rupture, visually distinct from empty
<stream ends, no terminal>  synthesize Failed(stage=unknown) -> broken
```

## Stack

- React 18 + Vite + TypeScript.
- Terminal: `@xterm/xterm` + `@xterm/addon-fit`.
- Left panel: layered `<RitualStage>` — RPGM redesign (2026-09-04, see
  "Left panel v2" below), driven by a pure `reduce(SceneState, event)` in
  `src/scene/` (unchanged by the redesign). Narration copy in
  `src/copy/oracle.ts`.
- One `EventSource` (`src/hooks/useEventStream.ts`) feeds both panels so they
  stay in sync; it also handles stream-death synthesis and the
  `accepted.json` fetch.
- Event vocabulary + runtime validator: `src/lib/schema.ts`
  (`validateEvent`, `classifyEvent`). `src/lib/schema.test.ts` runs it over
  the fixtures.

### Dev commands (run inside client/)
- `npm install`      once
- `npm run dev`      Vite dev server + event feed, http://localhost:5273
- `npm test`         vitest: schema / fixture / reducer / oracle checks
- `npm run build`    tsc type-check + vite production build

## Setup (live pipeline, one-time per machine)

Fixture mode (`npm run dev`, the default) needs none of this. It's only
needed to exercise `POST /dev/run` against the real backend pipeline:

1. `cd backend && python3 -m venv .venv && source .venv/bin/activate &&
   pip install -r requirements.txt`
2. `backend/.env` with four keys (these are secrets — never commit this
   file, and never write the *values* into chat, logs, or docs, only the
   names below):
   - `SERPAPI_API_KEY`
   - `IMGBB_API_KEY`
   - `SEPOLIA_RPC_URL`
   - `PRIVATE_KEY`
3. `smoke_full.py` writes real runs to `backend/runs/<run_id>/`, but the
   bridge (`vite-plugins/jsonl-sse.ts`) tails the repo-root `runs/`. Link
   them from the repo root: `mkdir -p runs && ln -s ../runs backend/runs`.
   Both the symlink and the repo-root `runs/` dir are gitignored — never
   commit either. If this link is missing or wrong, `npm run dev` logs a
   startup warning naming this exact fix.

## Fixtures (committed stand-ins — reconciled against KC's real runs 2026-09-04)

`origin` now points at KC's pipeline repo (`verigraph`, unrelated git history,
no `client/` dir); its `runs/` was extracted locally (gitignored, untracked)
and used as ground truth to fix two validator-breaking schema bugs
(`ImageSearchCompleted.hit_count` -> `hits`; `Attesting` gained `root`) and to
rename several open-tier fields the reducer/oracle were reading wrong
(`SearchMerged.unique_count` -> `unique`, plus `by_engine`; `VerifyPassed`
carries `root`+`uid`, not `matched`). Values below are synthetic (no real
subject names/URLs committed) but field names, structure, and numeric scale
now match real runs; engine names (`google_lens`, `google_reverse_image`,
`yandex_images`) are real.

- `events-success.jsonl`         expand-fired happy path, ends `VerifyPassed`
  — modeled on `runs/full-20260904T112413Z-0f9c6d60/`
- `events-success-noexpand.jsonl` happy path, `ExpandSkipped`
  — modeled on `runs/full-20260904T110615Z-13cf0e62/`
- `events-nomatch.jsonl`         STUB for the reserved `NoMatchFound` path —
  no real forced-no-match run exists yet (confirmed by KC's
  `events_contract.md`); field names updated for consistency, still synthetic
- `events-failed.jsonl`          `Failed`, verbatim error text from
  `runs/full-20260904T110555Z-f3fa465b/` ("InsightFace found no face"); no
  `stage` field — real `Failed` events never send one, confirmed across both
  real failure runs, so the UI always shows `stage: unknown` today
- `accepted.success.json`        gallery sidecar for the success run —
  shape (`url`, `thumbnail`, `face_similarity`, `title`) verified against the
  real `accepted.json` in the same run directory

## Build order (one focused change per step; verify in localhost each time)
1. Split shell + terminal tailing the fixture, nothing else.            <- DONE
1.5 Reconcile schema/fixtures/validator to KC's v1 contract.            <- DONE
1.6 Second reconciliation pass against KC's real `runs/` output (pulled  <- DONE
    from the `verigraph` remote's `main`, an unrelated-history backend-only
    repo — see "Fixtures" above for the two schema.ts bugs fixed and the
    field renames in reducer.ts/oracle.ts). 79 tests pass; build clean.
2. Left panel state machine wired to the same stream (phases switching  <- DONE
   on event type), real narration + constellation + scroll, video as a
   labeled placeholder panel.
   Delivered: src/scene/{state,reducer}.ts (+tests), src/copy/oracle.ts
   (+test), src/lib/terminalFormat.ts (+test), src/hooks/useEventStream.ts
   (one EventSource -> both panels), src/components/RitualStage.tsx +
   layers/{AmbientLayer,Constellation,NarrationLog,Scroll,VideoLayer,
   GrainVignette}.tsx. EventTerminal.tsx is now a dumb xterm sink fed by
   the shared hook. 79 unit tests pass; tsc + vite build clean.
   Note: changing vite.config.ts / vite-plugins/* needs a dev-server
   restart — Vite does not hot-reload the plugin that serves /dev/events.
3. Drop in real AI-generated video clips; swap the placeholders.          <- SUPERSEDED
   Original delivery (constellation/starfield direction, media/Failure.mp4)
   was replaced wholesale by the RPGM redesign below after direct user
   feedback rejected the constellation visual, the card-on-video overlay,
   and technical labels like "transaction hash". See "Left panel v2".
4. Real fonts + vellum/grain/sigil textures; chant text-reveal polish.
5. Ambient bed + event SFX (no-op-safe if files absent).
6. Scroll pass: confirm it renders nothing before `Attested`; wire the
   `verified` check and the easscan link.                                <- DONE (v2)
7. Run `events-nomatch.jsonl` and `events-failed.jsonl` through the same
   build: confirm `empty` and `broken` are distinct, neither shows the
   scroll or the success video. Confirm synthetic `Failed` on stream death.
   <- DONE (v2) — verified live on localhost, see "Left panel v2".
8. Wire the real event source: tail `runs/<run_id>/events.jsonl` and its   <- DONE
   sidecars instead of the fixtures. `POST /dev/run` spawns the real
   pipeline; run-mode `/dev/events?run_id=...` tails its output. See
   "Setup" and "Live mode" below.

## Left panel v2 — RPGM redesign (2026-09-04)

The original constellation/starfield treatment (build step 3 above) was
rejected outright: "three random dots... stars joining line... does not
look attractive," the card-on-video overlay was "super bad," and technical
labels ("transaction hash") broke the fantasy tone. Replacement direction,
approved via `superpowers:brainstorming` visual-companion mockups
(`full-flow-review.html`): a JRPG/RPG-Maker game feel — witch concocting a
spell as ambient background, one uninterrupted outcome-video "beat" on
success/failure before the rest of the UI ("chrome") fades in, loot-card
style results, single-line JRPG-style textbox instead of a scrolling log.

Note: the design doc at
`docs/superpowers/specs/2026-09-04-left-panel-ritual-ui-design.md` describes
the ORIGINAL (now-superseded) constellation direction — it predates this
redesign and has not been rewritten. Treat this section as the current
source of truth for the left panel's visual architecture until/unless that
doc is updated.

**Layer stack** (`RitualStage.tsx`, bottom to top):
1. `VideoLayer` — full-bleed background at every phase (working phases loop
   an ambient clip; `fixed`/`empty`/`broken` each play their outcome clip
   once). Real per-outcome clips (2026-09-05): `ambient` ->
   `WitchConcocting.mp4`, `success` (`fixed`) -> `WitchSuccess.mp4`,
   `rupture` (`broken`/`Failed`) -> `WitchDefeated.mp4` (violent framing
   matches EndCard's "the hero's blade found her first" copy for that
   phase), `failure` (`empty`/`NoMatchFound`) -> `Failure.mp4` (the
   original clip, kept so `empty` and `broken` stay visually distinct
   rather than sharing `rupture`'s clip). See the `CLIP_SRC` map and header
   comment in `VideoLayer.tsx`.
2. `.ritual-beat-caption` — one italic line, shown only while an outcome
   clip is having its uninterrupted first playthrough (see "beat vs
   settled" below).
3. `.ritual-chrome` — everything else, opacity-faded as a unit:
   - phase readout (top-center)
   - `Scroll` (`layers/Scroll.tsx`) — rune-tile hash breakdown + `easscan`
     link, replacing the old `<dl>`-of-labelled-fields. Still renders
     nothing before `Attested` (hard rule unchanged).
   - `LootGallery` (`layers/LootGallery.tsx`) — accepted posts as star-rated
     loot cards. `null` if `scene.stars` is empty.
   - `EndCard` (`layers/EndCard.tsx`) — centered fantasy copy for the two
     failure outcomes (`empty`/`broken`, kept visually distinct per the
     hard rule); no-op on other phases.
   - `JRPGTextbox` (`layers/JRPGTextbox.tsx`) — bottom-pinned box showing
     only the single latest non-`aside` narration line (not a scrolling
     log). `tone: 'aside'` lines (raw ids/hashes/error strings) are
     filtered out here by design — they still reach the terminal.
4. `GrainVignette` — unchanged.

**Beat vs settled staging**: on reaching `fixed`/`empty`/`broken`,
`RitualStage` hides `.ritual-chrome` (CSS opacity, not unmount) and shows
only the video + a one-line caption until the outcome clip's `onEnded`
fires (or immediately, under `prefers-reduced-motion`), then fades the
chrome in. Implemented with a plain `useState`/`useCallback` in
`RitualStage.tsx`; deliberately no conditional unmounting, to avoid
remount/replay bugs.

**Deleted**: `layers/Constellation.tsx`, `layers/AmbientLayer.tsx` (video is
now the single full-bleed background layer at every phase, not a separate
canvas layer), `layers/NarrationLog.tsx` (superseded by `JRPGTextbox`).

**Verified live on localhost** (all four fixtures, 2026-09-04):
- `?fixture=success` — ambient loop + live narration through working
  phases; settled state shows correct rune-scroll (real hash/easscan),
  three correctly-populated loot cards, correct closing line.
- `?fixture=success-noexpand` — same, `ExpandSkipped` path; scroll/verify
  badge correct. Loot gallery is empty here because
  `fixtures/accepted.success-noexpand.json` was never created (pre-existing
  fixture gap, confirmed via a 404 on `/dev/run-file`, not a redesign bug —
  `LootGallery` correctly no-ops on empty `stars` rather than crashing).
- `?fixture=nomatch` — beat-then-settle staging confirmed with realistic
  timing; settled state shows `empty`-variant `EndCard`, no scroll, no loot
  cards.
- `?fixture=failed` — settled state shows `broken`-variant `EndCard`
  ("The Destined One Was Not Found" / hero-killed-the-witch framing), no
  scroll, no loot cards.

## Live mode

Requires the one-time "Setup" above. Fixture mode (default, no `run_id` in
the URL) is completely unaffected by any of this.

- `POST /dev/run` — binary photo upload (see `UploadGate`). Spawns
  `backend/smoke_full.py` for real: SerpAPI + imgbb + a real Sepolia
  attestation transaction (costs money and gas — not a simulation).
  Resolves `{ run_id }` as soon as the child's stdout prints
  `FULL RUN <id>`. Returns `409 { error: "run_in_progress" }` if a run is
  already active — the dev host runs at most one pipeline at a time.
- `GET /dev/events?run_id=<id>` — run mode: tails
  `runs/<run_id>/events.jsonl` as it grows instead of replaying a fixture.
  Waits up to 90s for the file to first appear (cold model load, see
  below), failing fast — before that ceiling — the moment the pipeline
  process exits without ever writing an event, or the client disconnects.
- `UploadGate` gates entry into live mode: pick/drop a photo client-side
  (15 MB cap, `image/*` only), then POST it to `/dev/run`.
- **`cast-again` never appears in fixture mode.** `App` only ever passes a
  real `onCastAgain` handler in live mode; fixture mode passes
  `onCastAgain={undefined}` explicitly, and `CastAgain` no-ops without a
  handler. This is structural (see `App.tsx`), not a UI convention.
- **Cold-start timing**: on the first run per machine, InsightFace
  downloads its model weights before the pipeline writes its first event —
  observed **~46s** on a real run before any output appears (subsequent
  runs on the same machine are cached and warm, ~2–5s per "Timing" above).
  The left panel currently just sits at `idle` ("the eye is closed") for
  that whole window with no heartbeat — known gap, not fixed here.

## Verify-after-every-step checklist (do not trust "done")
- Does the scroll ever show content before `Attested`? (must be no)
- Does `NoMatchFound` ever trigger the success video, or `VerifyPassed`? (no)
- Are `empty` (NoMatchFound) and `broken` (Failed) visually distinct? (yes)
- Does an unknown/malformed line crash the left panel? (must be no)
- Does the terminal show off-schema lines flagged rather than silently drop
  or crash? (must show, flagged)
