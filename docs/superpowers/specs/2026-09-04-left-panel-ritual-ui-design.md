# Left panel — "the ritual UI" — design

Date: 2026-09-04
Status: approved, implementation started
Scope: the left half of the split-screen. Right half (xterm terminal) already
built in step 1. This is CLAUDE.md build steps 2–7.

---

## 1. Context

Split-screen. Right = a real terminal tailing the backend event stream. Left =
a fantasy-themed reactive UI driven by the same stream. This doc covers the
left panel: architecture, state machine, the narration/"dialogue" system, the
scroll, the asset list, and the two video briefs.

The event contract is KC's "Event contract (KC → Ryuk) — v1", reconciled into
`client/CLAUDE.md` on 2026-09-04. Key facts that shape this design:

- ~16 event types emitted today + 4 reserved names (`CandidateScored`,
  `VerifyFailed`, `NoMatchFound`, `ConsentBound`).
- Flat envelope. `ts` / `seq` / `run_id` ride along on any event; the FSM
  ignores them.
- `PostAccepted` is a **summary** (`{count, top_sim}`) today. The gallery is
  built by reading the `runs/<run_id>/accepted.json` sidecar. Per-post events
  come later.
- No guaranteed terminal event. The stream can just stop. The UI synthesizes a
  local `Failed(stage=unknown, error=stream_ended)` on stream death.
- `VerifyPassed` is a confirmation badge only — it must not re-trigger the
  success video.
- Full run ≈ 1–2 min, with a 30–90 s silent gap between `SearchMerged` and
  `PostAccepted` (candidate scoring). No heartbeat.
- Thumbnails in `accepted.json` are third-party CDN URLs; CORS not guaranteed.
  Render with `<img>` only, placeholder on error.

### Decided direction (from brainstorming, 2026-09-04)

- Witch voice: **cosmic oracle / seer** — vast, prophetic, threads of fate, the
  All-Seeing Eye.
- Core metaphor: **constellation of sightings**. Each accepted post is a star
  the Eye fixes in the dark. The merkle root names the constellation. The
  attestation nails it to the sky. The scroll is the star-chart; the tx hash is
  its coordinates.
- Visuals: **hybrid**. A live-rendered starfield/constellation is the spine.
  Video is reserved for two payoff beats: `Attested` (success) and
  `NoMatchFound` (failure). `Failed` is a rendered rupture, not a video.
- Audio: ambient bed loop + event SFX. Narration is on-screen text, not voiced.
- Art direction: **celestial cartography** — void black + indigo, gold leaf,
  aged star-atlas parchment, astrolabe geometry. Refs: Cellarius star charts,
  antique orreries, Hades UI.
- Deliverable: portfolio / product piece. Build the full state machine, a real
  asset pipeline, accessibility, timing tuned against real runs.

---

## 2. Approach (chosen: A — layered stage driven by a pure scene-reducer)

One `<RitualStage>` composing fixed layers, back to front:

1. `AmbientLayer` — rendered indigo drift (canvas). No asset.
2. `Constellation` — canvas starfield; stars fix in during "weaving", gold
   lines draw on `MerkleBuilt`.
3. `NarrationLog` — the oracle's running dialogue.
4. `Scroll` — the star-chart. Renders **nothing** until `seal !== null`.
5. `VideoLayer` — `<video>` whose `src` swaps on phase; holds last frame.
6. `GrainVignette` — foreground texture. No asset.

A pure function `reduce(SceneState, event) => SceneState` derives everything the
layers read. It is unit-tested exactly like `schema.test.ts`, including the
hard rules. Components read slices of `SceneState`; they hold no event logic.

Rejected: **B** (video-timeline with events as cue points) — brittle against
the real 30–90 s irregular gaps, and "new clips" means re-cutting a timeline.
**C** (pure-rendered, no video) — the two payoff beats want crafted footage.

---

## 3. State machine

```
type Phase =
  | 'idle'      // before FaceDetected — the Eye is closed
  | 'scrying'   // FaceDetected .. SearchMerged — the sweep
  | 'weighing'  // after SearchMerged, before PostAccepted — the long silence
  | 'weaving'   // PostAccepted .. MerkleBuilt — the figure forms
  | 'naming'    // Attesting — the chant
  | 'fixed'     // Attested — scroll unfurls, success video
  | 'empty'     // NoMatchFound — failure video, scroll never renders
  | 'broken'    // Failed (real or synthetic) — rupture, distinct from 'empty'
```

Event → transition:

| Event | Effect |
|---|---|
| `FaceDetected` | `idle → scrying`; record `backend`, `det_score` |
| `ImageHosted` | record `url` (the likeness cast on the water) |
| `ImageSearchRequested` | record engine list |
| `ImageSearchCompleted` | record `engine`, `hit_count` (one per engine) |
| `ImageSearchFailed` | mark that engine failed; stay `scrying` |
| `SearchMerged` | `scrying → weighing`; record merged count |
| `CandidateScored` *(reserved)* | terminal log only; **no** left-panel change |
| `PostAccepted` | `weighing → weaving`; record `{count, top_sim}`; trigger `accepted.json` fetch → `@StarsResolved` populates `stars[]` |
| `ExpandRequested/Completed/Skipped` | record expand state; stay `weaving` |
| `GraphUpserted` | stay `weaving` ("the web remembers") |
| `MerkleBuilt` | record `root`; constellation lines draw; stay `weaving` |
| `Attesting` | `weaving → naming`; chant/text-reveal starts |
| `Attested` | `naming → fixed`; set `seal = {tx_hash, uid, easscan}`; success video; scroll unfurls |
| `VerifyPassed` | `verified = true`; small ✓ under the hash. **No** video replay, no phase change |
| `VerifyFailed` *(reserved)* | distinct fail ritual (not `broken`, not `empty`) — reserved, stubbed |
| `NoMatchFound` *(reserved)* | any phase `→ empty`; failure video; scroll never renders |
| `Failed` | any phase `→ broken`; record `{error, stage ?? 'unknown'}`; rendered rupture |
| `@StreamEnded` (synthetic) | if no terminal event seen `→ broken` with `error='stream_ended'` |
| `@Idle` (synthetic, >5 s since last event in `scrying`/`weighing`) | narration aside: "the Eye weighs each light… slow work" |

### Hard-rule enforcement (in the reducer, covered by tests)

1. `seal` is written by exactly one case: `Attested`. `Scroll` renders `null`
   whenever `seal === null`. Test walks `events-success.jsonl` and asserts
   `seal === null` on every line before the `Attested` line.
2. `NoMatchFound` sets `phase='empty'`, never touches `seal`, resolves the
   video layer to the failure clip. Test asserts against the nomatch fixture.
3. `Failed` sets `phase='broken'`, never merged with `empty`; its own visual.
4. `VerifyPassed` never sets `phase='fixed'` and never resolves the success
   video — only `Attested` does.
5. Unknown event names are classified `unknown` and **no-op** the reducer (the
   terminal still shows them flagged). They never throw.

---

## 4. The narration / "dialogue" system

`src/copy/oracle.ts`: `oracleFor(event, scene) => NarrationEntry[]`. One to
three lines per event, in the cosmic-seer register, **interpolating real
fields** — never a hardcoded hash. Tone tags: `seer` (the Eye speaking),
`omen` (failure/verdict), `aside` (idle/technical).

Helpers: `host(url)` → hostname; `band(n, table)` → number → phrase;
`ordinal(n)`; `short(hash)` → first 10 chars + "…".

| Event | Lines |
|---|---|
| `FaceDetected` | "A face surfaces from the dark." / "{band(det_score)} — this is the true light I will hunt." |
| `ImageHosted` | "Her likeness is cast on the water, ready to be shown to every sky." |
| `ImageSearchRequested` | "The Eye turns to {n} skies at once." |
| `ImageSearchCompleted` | "The {engine} sky answers — {hit_count} points of light." |
| `ImageSearchFailed` | "The {engine} sky stays shut. No matter." |
| `SearchMerged` | "All skies gathered. {n} lights, and no twins among them." |
| `@Idle` (weighing) | "The Eye weighs each light against the true one. Slow work." |
| `PostAccepted` | "{count} lights hold true. The brightest burns at {band(top_sim)}." |
| `@StarsResolved` (per star, staggered) | "Fixed. The {ordinal} true star — {host(url)}." |
| `ExpandRequested` | "It follows the threads outward." |
| `ExpandCompleted` | "The threads are walked." |
| `ExpandSkipped` | "No threads worth walking. It holds." |
| `GraphUpserted` | "The web remembers." |
| `MerkleBuilt` | "The figure has a name now — {short(root)}." |
| `Attesting` | "She speaks the name to the sky." / "The words are going out…" |
| `Attested` | "Nailed to the firmament." / "It will hang there long after we are dust." / "coordinates: {tx_hash}" |
| `VerifyPassed` | "Read back against the sky. The figure matches. It is done." |
| `VerifyFailed` *(reserved)* | "Read back against the sky — the figure does not hold. {reason}" |
| `NoMatchFound` *(reserved)* | "The Eye swept every sky. {candidates_checked} lights weighed." / "No true star among them. The dark keeps her." / "({reason})" |
| `Failed` | "The Eye has gone dark at {stage}." / "{error}" / "Nothing was fixed." |
| `@StreamEnded` | "The thread was cut before the end. The Eye has gone dark." |

---

## 5. Constellation behavior

Canvas layer, deterministic. Star position = hash(`url`) → (angle, radius)
within a safe ellipse, so a given run always draws the same figure.

- `@StarsResolved`: stars fix in one at a time, client-staggered ~600 ms apart
  (the pipeline delivers them as one `accepted.json` today; the stagger keeps
  the "one by one" feel). Each star's `thumbnail` renders as a small
  gold-rimmed `<img>` positioned over the canvas point; `onerror` → a drawn
  star-glyph fallback.
- `MerkleBuilt`: thin gold lines draw star-to-star in sequence, closing an
  abstract figure. One pulse travels the lines.
- No rejected-candidate visuals (KC: no per-candidate left-panel UI).
- `phase` tints the whole field: cold indigo in `scrying`/`weighing`, warming
  gold as stars fix, steady gold at `fixed`, ash-grey drained at `empty`,
  fractured at `broken`.

---

## 6. The scroll

Aged vellum, unfurls (~1.2 s CSS transform) **only in `phase='fixed'`**. It is
a star-chart, not a receipt.

- Header sigil — "THE FIGURE, FIXED"
- The constellation redrawn small in gold, each star labelled `host(url)`
- **Named** — `root` (full, mono) — "the name the sky knows it by"
- **Coordinates** — `tx_hash` (full) — where on the chart the figure hangs
- **Follow the star** — `easscan` as the single interactive element, opens EAS
  in a new tab
- **Sealed** — `uid`, under a rendered wax-seal sigil
- If `verified`, a small ✓ "read back against the sky" under Coordinates

The tx hash is present but framed as coordinates; the easscan link is "follow
it to where it hangs". Not "here is the tx hash".

---

## 7. Asset list

| Asset | Owner | Notes |
|---|---|---|
| `client/media/success.mp4` | **KC/you generate** | brief §8. ≤10 s, ends on locked hold frame |
| `client/media/failure.mp4` | **you generate** | brief §8. ≤10 s, ends on near-black hold |
| `client/media/rupture.*` | **rendered, not filmed** | `Failed` state; canvas/CSS |
| `client/media/ambient.ogg` | **you source** (Freesound CC0) | 30–60 s seamless loop, low drone + wind |
| SFX: `star-fix`, `chant`, `unfurl`, `seal`, `rupture` | **you source** (CC0) | one-shots; wired to no-op if absent |
| `vellum`, `grain`, `wax-seal` sigil, astrolabe frame | **Claude builds** | SVG / procedural CSS |
| Display font (EB Garamond / Cormorant, OFL) + JetBrains Mono | **Claude adds** | self-hosted |
| Ambient starfield, rejection flicker, chant reveal | **Claude builds** | canvas / CSS |

Claude cannot generate video. Stock is only viable for the ambient bed
(NASA public domain / Pexels CC0); the two payoff beats must be generated from
the briefs. `Failed`/rupture is rendered to sync tightly with the line-snap.

---

## 8. Video briefs

Both: ≤10 s, no text / captions / readable letters / sharp faces in frame,
end on a locked hold frame (DOM copy overlays the hold), vertical ~1080×1350,
single continuous camera move decelerating to a lock, no baked-in audio.

### `success.mp4` — "The Sealing" — plays once on `Attested`

- Palette: void black `#04060a`, deep indigo haze, gold leaf `#d9b45b`. No
  white blowout.
- 0–2 s: slow push-in on a black void, ~6 dim gold stars already hanging,
  unlinked. Faint indigo dust drift.
- 2–4 s: from the bottom edge a matte black hand (silhouette, no detail —
  reads as the night itself) rises holding one bright gold bead of light.
- 4–5.5 s: the hand presses the bead into the black at centre — soft radial
  flare — it settles as the brightest star.
- 5.5–7 s: thin gold lines snap star-to-star in quick succession, closing an
  abstract figure; one low pulse runs the lines.
- 7–8 s: camera locks. The figure burns steady and calm, faint breathing
  shimmer only. Hold to end. Constellation centred, slightly low, so DOM text
  has room above.
- Mood: reverent, deliberate. No shake, no cuts.

### `failure.mp4` — "The Dark Keeps Her" — plays once on `NoMatchFound`

- Palette: cold. Ash grey `#9aa4b2`, slate indigo `#1b2233`. **No gold** — the
  absence is the point.
- 0–2 s: slow lateral pan across a wide, cold star-field — many small
  blue-grey points, none linked, none warm.
- 2–5 s: as the unseen gaze passes, each point it crosses gutters out —
  flicker, then dark. Wind over marsh-fires. Black left behind the pan.
- 5–7 s: pan slows; the last two or three weak points flicker and die before
  the gaze reaches them.
- 7–8 s: full black. A soft vignette closes from top and bottom to a
  horizontal line — the Eye shutting. Hold on black.
- Mood: mournful, resigned. Not a jump-scare. Loss, not error.

### `rupture` — "The Eye Goes Dark" — `Failed` — RENDERED

A break, not an emptying. Half-formed gold constellation → hard fracture rips
across → lines snap and recoil → stars scatter cold grey → a crack propagates
through a central iris → cut to black. Sharp, fast, one violent motion, brief
red heat-flash at the fracture. Rendered in canvas/CSS to sync with the
line-snap timing.

---

## 9. Files (implementation)

Step 1.5 — reconcile to KC's contract:
- `client/CLAUDE.md` — v1 vocabulary, flat envelope, transport, hard rules,
  state machine, timing. **Done.**
- `client/src/lib/schema.ts` — closed / open / reserved tiers; envelope keys
  allowed globally; `classifyEvent`.
- `client/fixtures/` — `events-success.jsonl`, `events-success-noexpand.jsonl`,
  `events-nomatch.jsonl` (stub), `events-failed.jsonl`, `accepted.success.json`.
  **Provisional** until diffed against KC's real runs.
- `client/vite-plugins/jsonl-sse.ts` — new fixture names; serve sidecars at
  `/dev/run-file?fixture=&name=`.
- `client/src/lib/events.ts` — `FixtureName`, `runFileUrl`.
- `client/src/lib/schema.test.ts` — envelope tolerance, tiers, classify.

Step 2 — left panel:
- `client/src/scene/state.ts`, `client/src/scene/reducer.ts` (+ `.test.ts`)
- `client/src/copy/oracle.ts` (+ `.test.ts`)
- `client/src/hooks/useEventStream.ts` — one EventSource, validated, fans to
  scene + terminal; stream-death synthesis; `accepted.json` fetch; idle timer.
- `client/src/components/RitualStage.tsx` + `layers/` (`AmbientLayer`,
  `Constellation`, `NarrationLog`, `Scroll`, `VideoLayer`, `GrainVignette`)
- `client/src/audio/cues.ts` — no-op-safe SFX map
- `client/src/components/EventTerminal.tsx` — refactor to render lines handed
  by the hook (so both panels stay in sync off one stream)
- `client/src/App.tsx`, `client/src/index.css`

Steps 3–7 layer on real video, fonts/textures, chant polish, and the failure
path verification per `CLAUDE.md` build order.

---

## 10. Open items (verify / fix when KC's real runs land)

- Close the **open** event payload shapes (`SearchMerged`, `Expand*`,
  `GraphUpserted`, `ImageSearchRequested/Failed`, `VerifyPassed`).
- Confirm `accepted.json` structure (array vs keyed, exact field names).
- Tune fixture replay ordering / counts / `ts` cadence to real gaps.
- Confirm `ts` format (assumed ISO-8601 with offset).
- Replace the `events-nomatch.jsonl` stub with KC's forced no-match run.
