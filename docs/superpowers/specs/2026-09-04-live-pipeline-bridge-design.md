# Live pipeline bridge — design

Date: 2026-09-04
Status: approved, implementation starting
Scope: wires the client (built through `client/CLAUDE.md` build steps 1–7,
all fixture-driven) to KC's real pipeline (`verigraph` / `origin`), so a real
uploaded photo triggers a real run instead of playing back a fixture. This is
`client/CLAUDE.md` build step 8, expanded with the upload UI KC's handoff doc
calls for ("Photo drop → kicks real run").

---

## 1. Context

Everything built so far — the split shell, the RPGM-redesigned left panel,
the reducer/oracle/terminal — consumes one `EventSource` per
`client/src/hooks/useEventStream.ts`, currently always pointed at a fixture
via `/dev/events?fixture=...` (a Vite dev plugin that reads a whole fixture
file up front and replays it at a fixed pace). None of that changes here —
this doc is only about *where the events come from*.

Findings that shape this design (2026-09-04):

- `origin/main` (`verigraph`, unrelated git history to this repo, 9 commits
  ahead of local `main`) has no HTTP server. `smoke_full.py` is a plain
  Python CLI script: `python3 smoke_full.py <image_path>`. It creates
  `<script dir>/runs/full-<run_id>/`, runs synchronously (~1–2 min per
  `client/CLAUDE.md`'s "Timing" section), and appends `events.jsonl` +
  sidecars (`accepted.json`, `attest.json`, ...) as it goes — the exact
  shape the fixtures already mirror.
- It requires four secrets loaded from a `.env` sitting next to the script
  (`SERPAPI_API_KEY`, `IMGBB_API_KEY`, `SEPOLIA_RPC_URL`, `PRIVATE_KEY`) and
  a Python environment (`insightface`, `onnxruntime`, `opencv-python-headless`,
  `web3`, `eth-account`, `networkx`, `python-dotenv`, `Pillow`, `requests`,
  `numpy` — see `requirements.txt`). Confirmed on this machine: `.env` has
  real values for all four keys; none of the Python deps are installed yet;
  no checkout of the backend code exists outside git history.
- On any internal exception, `smoke_full.py` already catches it, emits a
  `Failed{error}` event to `events.jsonl`, and exits non-zero — this is
  exactly the `Failed` event the client's `broken` phase already renders.
  No new failure-path UI is needed.
- KC's own handoff doc (`ryuk_handoff.md`, on `origin/main`) states the
  intended shape explicitly: *"UI starts pipeline process (or calls a local
  runner)... Pipeline streams JSON lines... UI tails that stream."* — a
  local subprocess, not a hosted API.
- Every real run spends real SerpAPI/imgbb API quota and submits a real
  Sepolia **testnet** transaction from the `.env` wallet. Not real money,
  but not free either — worth being deliberate about when a live run
  actually fires.

### Decisions (from brainstorming, 2026-09-04)

- Backend code (`smoke_full.py`, `smoke_e2e.py`, `requirements.txt`,
  `samples/`) is pulled into this repo, under a new `backend/` folder — not
  a full history merge (unrelated history, and we don't want their sample
  `runs/` tracked), just the specific files.
- The bridge lives inside the existing Vite dev plugin
  (`client/vite-plugins/jsonl-sse.ts`), not a separate server process.
  Chosen over a standalone Node "runner" server or a Python-owned HTTP
  server: it reuses the SSE delivery code already written and tested for
  fixtures, needs no new port/CORS, and matches KC's own suggested simplest
  path. One process (`npm run dev`) start-to-finish.
- Fixture mode (`?fixture=...`) is untouched — still the fast, deterministic
  path for iterating on UI/CSS without spending API quota or waiting on a
  real run.

---

## 2. Backend integration

```
backend/
  smoke_full.py         # from origin/main, unmodified
  smoke_e2e.py           # from origin/main, unmodified
  requirements.txt       # from origin/main, unmodified
  samples/                # from origin/main, unmodified
  .venv/                  # created locally, gitignored
  .env                    # moved from repo root, gitignored
  uploads/                # created at runtime, gitignored
  runs -> ../runs          # symlink, see below
```

Pulled with `git show origin/main:<path>` per file (and per file under
`samples/`) rather than a merge — keeps this repo's own single-history
`feat/client` branch intact, and deliberately leaves `origin/main`'s
committed `runs/` samples out of the working tree (this repo already has
its own reconciled `runs/` at the root, gitignored, used as fixture source
material).

`python3 -m venv backend/.venv && backend/.venv/bin/pip install -r backend/requirements.txt`.
First install is slow (`insightface`/`onnxruntime` are large); the first
real run is additionally slow because `insightface` downloads model weights
on first use.

**The `runs/` path wrinkle:** `smoke_full.py` computes
`ROOT = Path(__file__).resolve().parent` and writes to `ROOT / "runs"` — so
wherever the script physically sits, that's where `runs/` lands. This repo
already has a top-level `runs/` (gitignored, real run data reconciled
against it back in build step 1.6, referenced throughout `client/CLAUDE.md`
and the Vite plugin). Rather than fork that source of truth or patch KC's
script, `backend/runs` is a symlink to `../runs` — `smoke_full.py` writes to
what it thinks is its own `runs/`, and it's transparently the same
directory the client already reads from.

---

## 3. The bridge — `client/vite-plugins/jsonl-sse.ts`

Three additions, all gated dev-only exactly like the existing fixture
handlers:

### `POST /dev/run`

- Body is the raw image bytes (`Content-Type` gives the extension; no
  multipart parsing needed for a single-file upload).
- Writes to `backend/uploads/<uuid>.<ext>`.
- Spawns `backend/.venv/bin/python3 backend/smoke_full.py <abs path>`
  (`cwd: backend/`), stdout/stderr piped to the Vite server's own logger so
  a run's progress is visible in the terminal running `npm run dev`.
- Watches stdout for the line `FULL RUN <run_id>` (printed by the script
  before any slow work starts) and responds `{ "run_id": "full-..." }` as
  soon as it's seen — the client does not wait for the pipeline to finish.
- **One run at a time.** An in-memory flag in the plugin's closure tracks
  whether a spawned process is still alive. A second `POST /dev/run` while
  one is in flight gets `409` with a small JSON body
  (`{ "error": "run_in_progress" }`); the flag clears on process exit
  (success or failure) so the next upload can proceed.
- If the process exits before ever printing `FULL RUN ...` (spawn failure —
  bad venv, `python3` missing, unreadable image), the POST itself fails with
  `500` and a message — this happens before any `run_id`/events exist, so
  it's surfaced as an upload-gate error, not a ritual-in-progress failure.

### `GET /dev/events` — `run_id` param (alongside today's `fixture` param)

Fixture mode is untouched: read-whole-file-then-replay-at-fixed-interval,
exactly as today.

Run mode is genuine tailing, not replay:

- Resolve `runs/<run_id>/events.jsonl` (waits briefly — up to ~2 s, polling
  — for the file to exist, covering the small race between the POST
  response and the script actually creating its output directory).
- Poll the file (interval ~300 ms — simplest cross-platform option, avoids
  `fs.watch` flakiness) tracking the byte offset already sent. Each poll:
  read only the newly-appended bytes, split into complete lines, buffer any
  trailing partial line for the next poll, push each complete line as an SSE
  `data:` frame immediately — no artificial pacing; real pipeline timing
  (near-instant here, a 30–90 s silence there) comes through as-is.
- Ends the stream (`event: end`, matching today's fixture-mode end frame)
  once the process this session spawned has exited *and* a final poll finds
  no new lines — or after a hard fallback ceiling (5 min, comfortably past
  the documented ~1–2 min happy-path and its worst-case gaps) so a stuck
  process can't hang a client connection forever.
- The pure "buffer + prior offset → new complete lines + new offset" step is
  written as a standalone function so it can be unit tested without
  spawning anything real (see Testing).

### `GET /dev/run-file` — `run_id` param (alongside today's `fixture` param)

Same idea as today's fixture sidecar lookup, pointed at
`runs/<run_id>/<name>.json` instead of `fixtures/<name>.<fixture>.json`. A
sidecar that doesn't exist yet (e.g. `accepted.json` requested before
`PostAccepted` has fired) returns `404`, exactly like today's "a run
legitimately may not have a given sidecar" case.

---

## 4. Client changes

- `client/src/hooks/useEventStream.ts`: generalizes its one fixture param
  into a small discriminated source — `{ mode: 'fixture', fixture }` or
  `{ mode: 'run', runId }` — building `?fixture=...` or `?run_id=...` on
  both `/dev/events` and `/dev/run-file` accordingly. Everything downstream
  of the hook (parsing, reducer, oracle, `RitualStage`, terminal, the
  stream-death-synthesizes-`Failed` fallback) is untouched — it already only
  knows "an `EventSource` feeds me lines."
- `client/src/App.tsx`: when no `?fixture=` query param is present, render a
  new upload gate instead of immediately opening an `EventSource`.
- New component, e.g. `client/src/components/UploadGate.tsx` — shown only
  during `idle`. Drag-drop or click-to-pick a file; client-side checks
  (`file.type.startsWith('image/')`, a sane size ceiling e.g. 15 MB) before
  ever hitting the network, with an inline message on rejection. On submit:
  `POST /dev/run` with the raw bytes; on `{run_id}`, switch the event
  source to run mode; on `409`, show "a ritual is already underway, wait
  for it to finish"; on any other failure, a generic retry message. This
  component holds no pipeline knowledge beyond "post a file, get a run id
  back or an error" — it's UI, not orchestration.
- Settled outcomes (`fixed` / `empty` / `broken`) get a small "cast again"
  control (in `EndCard` for the two failure outcomes, and a matching control
  near the scroll for `fixed`) that resets client state back to the upload
  gate — a live demo needs to run more than once without a page reload.
  Purely local state reset; no new event types, no reducer changes.

Nothing in `client/src/scene/`, `client/src/copy/oracle.ts`, or any of the
`RitualStage` layer components changes — the entire left panel is already
event-driven and source-agnostic by construction (this was the point of the
pure-reducer architecture from build step 2).

---

## 5. Error handling summary

| Failure | Where it surfaces | Existing or new? |
|---|---|---|
| Pipeline step throws (face not found, search fails, chain call reverts, ...) | `Failed{error}` event → `broken` phase, real error text in the `aside` narration tier | Existing — `smoke_full.py` already does this |
| Stream ends with no terminal event (process killed, crash before emitting `Failed`) | Client synthesizes local `Failed(stage=unknown, error=stream_ended)` | Existing client logic, unchanged |
| Spawn itself fails (bad venv, `python3` missing) | `POST /dev/run` → `500`, shown on the upload gate | New |
| Second upload while a run is in flight | `POST /dev/run` → `409`, shown on the upload gate | New |
| Malformed/oversized file | Rejected client-side before any request | New |

---

## 6. Testing

- New: a unit test for the pure tailing-offset helper (buffer + prior
  offset in, `{ lines, newOffset }` out) — the one piece of genuinely new
  logic that isn't "spawn a real process."
- Existing 79 Vitest tests and `npm run build` must stay green — nothing in
  `scene/`, `copy/oracle.ts`, or the schema validator changes.
- **Not** unit-testable: spawning real Python/insightface/a real Sepolia tx.
  The real acceptance check is a manual live run (e.g. against
  `backend/samples/elon_musk.jpg`) confirming the full journey — upload →
  `scrying` → `weighing` → `weaving` → `naming` → a settled outcome — arrives
  driven entirely by real events. Because that spends real SerpAPI/imgbb
  quota and submits a real Sepolia transaction, it's run only with explicit
  go-ahead at the time, separate from approving the code itself.

---

## 7. Out of scope

- Multi-user / concurrent runs (single in-flight run is a deliberate,
  demo-scale simplification — see §3).
- Any change to `smoke_full.py`/`smoke_e2e.py` themselves — they're KC's
  side, pulled in verbatim.
- Deploying this anywhere — the bridge is a Vite **dev** plugin, matching
  how the fixture feed already works; this doc doesn't address production
  hosting.
