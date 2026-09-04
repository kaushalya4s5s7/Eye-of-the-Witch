# Live Pipeline Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the client to KC's real pipeline (`verigraph`/`origin`) so uploading a photo through a new upload gate triggers a real `smoke_full.py` run, and the existing left-panel/terminal UI renders it from genuine tailed events instead of only fixture playback.

**Architecture:** Pull the backend's Python CLI verbatim into `backend/`. Extend the existing Vite dev plugin (`client/vite-plugins/jsonl-sse.ts`) with a `POST /dev/run` (upload + spawn) and run-id-aware `GET /dev/events` / `GET /dev/run-file` (incremental tailing instead of fixture replay). Generalize the client's one `fixture` param into a `{fixture}` / `{run}` union that flows through `events.ts` → `useEventStream` → `App.tsx`, and add an upload-gate screen plus a "cast again" reset — none of it touching the reducer, oracle, or any `RitualStage` layer, which are already event-source-agnostic.

**Tech Stack:** Vite dev middleware (Node `child_process`/`fs`), React 18 + TypeScript, Vitest.

**Spec:** [docs/superpowers/specs/2026-09-04-live-pipeline-bridge-design.md](../specs/2026-09-04-live-pipeline-bridge-design.md)

## Global Constraints

- Dev-only. The bridge lives in a Vite dev plugin; nothing here addresses production hosting (spec §7).
- Dev server stays on port **5273** — never 5173.
- **Never commit**: `runs/`, `backend/runs` (symlink), `backend/.venv/`, `backend/uploads/`, `backend/.env`. All must be confirmed git-ignored before committing each relevant task.
- **Never print or expose `.env` secret values** — key *names* only, never values, in any command output or commit.
- One pipeline run at a time — a second `POST /dev/run` while one is in flight returns `409 { "error": "run_in_progress" }` (spec §3).
- Fixture mode (`?fixture=...`) must keep working exactly as before, byte-for-byte, at every task boundary.
- All existing 79 Vitest tests, plus every test this plan adds, and `npm run build` must stay green after every task.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- A genuine end-to-end live run (fresh upload → real SerpAPI/imgbb calls → real Sepolia testnet tx) is never triggered automatically by any task in this plan — it needs the user's explicit go-ahead at that time (spec §6).

---

### Task 1: Pull backend code into `backend/`

**Files:**
- Create: `backend/smoke_full.py`, `backend/smoke_e2e.py`, `backend/requirements.txt`, `backend/samples/531714888_10235987016969385_7416969514884457963_n.jpg`, `backend/samples/AK-Half-Shirt-1-scaled.webp`, `backend/samples/elon_musk.jpg`, `backend/samples/user_face_crop.jpg`
- Create: `backend/runs` (symlink to `../runs`)
- Modify: `.gitignore`
- Modify (move, not copy): `.env` → `backend/.env`

**Interfaces:**
- Produces: `backend/smoke_full.py <image_path>` — the CLI entrypoint every later task's `/dev/run` handler spawns. Prints `FULL RUN <run_id>` to stdout before slow work, writes `backend/runs/full-<run_id>/events.jsonl` incrementally (via `smoke_e2e.py`'s `require_env` reading `backend/.env`).

- [ ] **Step 1: Copy the backend files verbatim from `origin/main`**

```bash
mkdir -p backend/samples
git show origin/main:smoke_full.py > backend/smoke_full.py
git show origin/main:smoke_e2e.py > backend/smoke_e2e.py
git show origin/main:requirements.txt > backend/requirements.txt
git show origin/main:samples/531714888_10235987016969385_7416969514884457963_n.jpg > backend/samples/531714888_10235987016969385_7416969514884457963_n.jpg
git show origin/main:samples/AK-Half-Shirt-1-scaled.webp > backend/samples/AK-Half-Shirt-1-scaled.webp
git show origin/main:samples/elon_musk.jpg > backend/samples/elon_musk.jpg
git show origin/main:samples/user_face_crop.jpg > backend/samples/user_face_crop.jpg
```

- [ ] **Step 2: Verify the files landed intact**

Run: `python3 -c "import ast; ast.parse(open('backend/smoke_full.py').read()); ast.parse(open('backend/smoke_e2e.py').read()); print('syntax ok')"` and `file backend/samples/*`
Expected: `syntax ok`, and `file` reports each sample as a real JPEG/WebP (not empty/truncated).

- [ ] **Step 3: Create the `backend/runs -> ../runs` symlink**

```bash
ln -s ../runs backend/runs
ls -la backend/runs
```
Expected: `backend/runs -> ../runs`, and `ls backend/runs` lists the same `full-*`/timestamp run directories as `ls runs`.

- [ ] **Step 4: Move `.env` under `backend/` (where `smoke_e2e.py` expects it, next to the script)**

```bash
mv .env backend/.env
```

- [ ] **Step 5: Extend `.gitignore` for the new backend runtime state**

Add to `.gitignore` (after the existing `runs/` entry):

```gitignore
# live pipeline bridge — backend runtime state (see
# docs/superpowers/specs/2026-09-04-live-pipeline-bridge-design.md)
backend/.venv/
backend/uploads/
backend/runs
```

- [ ] **Step 6: Confirm gitignore coverage before staging anything**

Run: `git status --porcelain --ignored=matching | grep -E 'backend/(runs|\.env|\.venv|uploads)'`
Expected: each of `backend/runs`, `backend/.env`, `backend/.venv/` (once created in Task 2), `backend/uploads/` (once created in Task 5) appears as `!!` (ignored), never as `??` (untracked). `backend/.venv` and `backend/uploads` won't exist yet at this point — re-check this command again at the end of Tasks 2 and 5.

- [ ] **Step 7: Confirm secrets never got staged**

Run: `git status --porcelain | grep -i env`
Expected: no output (the `.env` move is invisible to git — it was never tracked).

- [ ] **Step 8: Stage and commit only the real source files**

```bash
git add backend/smoke_full.py backend/smoke_e2e.py backend/requirements.txt backend/samples .gitignore
git status --porcelain
```
Expected: only those files staged — no `backend/runs`, `backend/.env`, `backend/.venv`, `backend/uploads`.

```bash
git commit -m "feat(backend): pull verigraph pipeline CLI into backend/

Verbatim from origin/main (smoke_full.py, smoke_e2e.py,
requirements.txt, samples/) — see
docs/superpowers/specs/2026-09-04-live-pipeline-bridge-design.md §2.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Backend Python environment

**Files:**
- Create: `backend/.venv/` (gitignored, not committed)

**Interfaces:**
- Produces: `backend/.venv/bin/python3` — the interpreter Task 5's `/dev/run` handler spawns.

- [ ] **Step 1: Create the venv and install dependencies**

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
cd ..
```
Expected: completes without error. This is the slow step (`insightface`/`onnxruntime` are large wheels) — allow several minutes.

- [ ] **Step 2: Verify every dependency imports cleanly**

```bash
backend/.venv/bin/python3 -c "import insightface, onnxruntime, cv2, web3, eth_account, networkx, dotenv, PIL, requests, numpy; print('deps ok')"
```
Expected: `deps ok`. (Model weights download on first *use*, not on import — this step does not trigger that download and should be fast.)

- [ ] **Step 3: Confirm `backend/.venv/` stays out of git**

```bash
git status --porcelain --ignored=matching | grep 'backend/.venv'
```
Expected: `!! backend/.venv/` (ignored). No commit for this task — nothing here is tracked.

---

### Task 3: Pure tailing helper — `client/src/lib/tailFile.ts`

**Files:**
- Create: `client/src/lib/tailFile.ts`
- Test: `client/src/lib/tailFile.test.ts`

**Interfaces:**
- Produces: `completeLines(raw: string): string[]`, `newLinesSince(raw: string, sentCount: number): { lines: string[]; sentCount: number }` — consumed by Task 5's `/dev/events` run-mode handler.

- [ ] **Step 1: Write the failing test**

Create `client/src/lib/tailFile.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { completeLines, newLinesSince } from './tailFile'

describe('completeLines', () => {
  it('returns only newline-terminated lines, trimmed', () => {
    expect(completeLines('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('holds back a trailing partial line', () => {
    expect(completeLines('{"a":1}\n{"b":2')).toEqual(['{"a":1}'])
  })

  it('returns nothing for an empty or all-partial file', () => {
    expect(completeLines('')).toEqual([])
    expect(completeLines('{"a":1}')).toEqual([])
  })

  it('skips blank lines', () => {
    expect(completeLines('{"a":1}\n\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
  })
})

describe('newLinesSince', () => {
  it('returns nothing new when the file has not grown', () => {
    const raw = '{"a":1}\n{"b":2}\n'
    expect(newLinesSince(raw, 2)).toEqual({ lines: [], sentCount: 2 })
  })

  it('returns only the lines appended since the last poll', () => {
    const raw = '{"a":1}\n{"b":2}\n{"c":3}\n'
    expect(newLinesSince(raw, 1)).toEqual({ lines: ['{"b":2}', '{"c":3}'], sentCount: 3 })
  })

  it('does not resend a line that is still being written', () => {
    const raw = '{"a":1}\n{"b":2}\n{"c":3'
    expect(newLinesSince(raw, 1)).toEqual({ lines: ['{"b":2}'], sentCount: 2 })
  })

  it('starts from zero for a brand new file', () => {
    expect(newLinesSince('{"a":1}\n', 0)).toEqual({ lines: ['{"a":1}'], sentCount: 1 })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx vitest run src/lib/tailFile.test.ts`
Expected: FAIL — `Cannot find module './tailFile'`.

- [ ] **Step 3: Write the implementation**

Create `client/src/lib/tailFile.ts`:

```ts
/**
 * Pure helpers for incrementally tailing a growing JSONL file (see
 * vite-plugins/jsonl-sse.ts, run mode). Given the file's full current text
 * and how many complete lines were already sent, returns any new complete
 * lines plus the updated sent-count.
 *
 * A "complete" line is one already terminated by '\n' — the writer's last,
 * still-open line is held back until the next poll sees its newline, so a
 * line is never sent half-written.
 */

export function completeLines(raw: string): string[] {
  const cut = raw.endsWith('\n') ? raw.length : raw.lastIndexOf('\n') + 1
  return raw
    .slice(0, cut)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

export interface TailResult {
  lines: string[]
  sentCount: number
}

/** @param raw the file's full text as of this poll
 *  @param sentCount how many complete lines were sent as of the last poll */
export function newLinesSince(raw: string, sentCount: number): TailResult {
  const lines = completeLines(raw)
  return { lines: lines.slice(sentCount), sentCount: lines.length }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx vitest run src/lib/tailFile.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the full suite to confirm nothing else broke**

Run: `cd client && npx vitest run`
Expected: PASS, 87 tests (79 existing + 8 new).

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/tailFile.ts client/src/lib/tailFile.test.ts
git commit -m "feat(client): add pure JSONL tailing helper

completeLines/newLinesSince — the incremental-tail logic /dev/events
run mode will use, extracted as a pure, unit-tested module per
docs/superpowers/specs/2026-09-04-live-pipeline-bridge-design.md §3/§6.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Generalize `client/src/lib/events.ts`

**Files:**
- Modify: `client/src/lib/events.ts`
- Test: `client/src/lib/events.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export type EventSource = { mode: 'fixture'; fixture: FixtureName; interval?: number } | { mode: 'run'; runId: string }`, `eventStreamUrl(source: EventSource): string`, `runFileUrl(source: EventSource, name: string): string`, `startRun(file: File): Promise<{ runId: string }>`, `class RunConflictError extends Error` — consumed by Task 5 (server side of the same contract), Task 6 (`useEventStream`), Task 7 (`UploadGate`), Task 9 (`App.tsx`).

- [ ] **Step 1: Write the failing test**

Create `client/src/lib/events.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunConflictError, eventStreamUrl, runFileUrl, startRun } from './events'

describe('eventStreamUrl', () => {
  it('builds a fixture-mode url', () => {
    expect(eventStreamUrl({ mode: 'fixture', fixture: 'success', interval: 800 })).toBe(
      '/dev/events?fixture=success&interval=800',
    )
  })

  it('omits interval when not given', () => {
    expect(eventStreamUrl({ mode: 'fixture', fixture: 'nomatch' })).toBe('/dev/events?fixture=nomatch')
  })

  it('builds a run-mode url', () => {
    expect(eventStreamUrl({ mode: 'run', runId: 'full-abc123' })).toBe('/dev/events?run_id=full-abc123')
  })
})

describe('runFileUrl', () => {
  it('builds a fixture-mode sidecar url', () => {
    expect(runFileUrl({ mode: 'fixture', fixture: 'success' }, 'accepted')).toBe(
      '/dev/run-file?name=accepted&fixture=success',
    )
  })

  it('builds a run-mode sidecar url', () => {
    expect(runFileUrl({ mode: 'run', runId: 'full-abc123' }, 'accepted')).toBe(
      '/dev/run-file?name=accepted&run_id=full-abc123',
    )
  })
})

describe('startRun', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves with the run id on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ run_id: 'full-abc123' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const file = new File([new Uint8Array([1, 2, 3])], 'x.jpg', { type: 'image/jpeg' })

    await expect(startRun(file)).resolves.toEqual({ runId: 'full-abc123' })
    expect(fetchMock).toHaveBeenCalledWith('/dev/run', expect.objectContaining({ method: 'POST' }))
  })

  it('throws RunConflictError on 409', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, text: async () => '' }))
    const file = new File([new Uint8Array([1])], 'x.jpg', { type: 'image/jpeg' })

    await expect(startRun(file)).rejects.toBeInstanceOf(RunConflictError)
  })

  it('throws a generic error on other failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }))
    const file = new File([new Uint8Array([1])], 'x.jpg', { type: 'image/jpeg' })

    await expect(startRun(file)).rejects.toThrow(/500/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx vitest run src/lib/events.test.ts`
Expected: FAIL — `eventStreamUrl` still takes the old `StreamOptions` shape (the fixture-mode assertions won't match) and `startRun`/`RunConflictError` don't exist yet.

- [ ] **Step 3: Rewrite `client/src/lib/events.ts`**

```ts
/** Client-side helpers for the dev event feed (see vite-plugins/jsonl-sse.ts). */

export type FixtureName = 'success' | 'success-noexpand' | 'nomatch' | 'failed'

/** Where events come from: a canned fixture (dev/QA, pinned by `?fixture=`
 *  in the URL), or a real run kicked off through the upload gate. */
export type EventSource =
  | { mode: 'fixture'; fixture: FixtureName; interval?: number }
  | { mode: 'run'; runId: string }

export function eventStreamUrl(source: EventSource): string {
  const params = new URLSearchParams()
  if (source.mode === 'fixture') {
    params.set('fixture', source.fixture)
    if (source.interval != null) params.set('interval', String(source.interval))
  } else {
    params.set('run_id', source.runId)
  }
  return `/dev/events?${params.toString()}`
}

/**
 * URL for a run sidecar file (accepted.json, attest.json, ...). In fixture
 * mode the jsonl-sse plugin serves `fixtures/<name>.<fixture>.json`; in run
 * mode it serves `runs/<run_id>/<name>.json`.
 */
export function runFileUrl(source: EventSource, name: string): string {
  const params = new URLSearchParams({ name })
  if (source.mode === 'fixture') {
    params.set('fixture', source.fixture)
  } else {
    params.set('run_id', source.runId)
  }
  return `/dev/run-file?${params.toString()}`
}

/** Thrown by startRun when a run is already in flight (HTTP 409). */
export class RunConflictError extends Error {}

/**
 * POST an image's raw bytes to /dev/run, kicking off a real pipeline run.
 * Resolves as soon as the backend has printed the run's id — the pipeline
 * keeps running in the background after this returns.
 */
export async function startRun(file: File): Promise<{ runId: string }> {
  const res = await fetch('/dev/run', {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  })
  if (res.status === 409) {
    throw new RunConflictError('a ritual is already underway')
  }
  if (!res.ok) {
    throw new Error(`could not start run: ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as { run_id: string }
  return { runId: body.run_id }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx vitest run src/lib/events.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the full suite**

Run: `cd client && npx vitest run`
Expected: PASS, 95 tests (87 from Task 3 + 8 new). Note: `useEventStream.ts`/`App.tsx` still reference the old `StreamOptions` shape at this point and will fail `tsc` — that's expected and fixed in Tasks 6/9; `vitest run` alone (no type-check) still passes because Vite/esbuild transpiles without full type-checking.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/events.ts client/src/lib/events.test.ts
git commit -m "feat(client): generalize event source to fixture|run, add startRun

eventStreamUrl/runFileUrl now take an EventSource discriminated union
instead of a bare fixture name; startRun() POSTs to /dev/run. See
docs/superpowers/specs/2026-09-04-live-pipeline-bridge-design.md §4.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Extend `client/vite-plugins/jsonl-sse.ts` — the bridge

**Files:**
- Modify: `client/vite-plugins/jsonl-sse.ts`

**Interfaces:**
- Consumes: `completeLines`, `newLinesSince` from `../src/lib/tailFile` (Task 3); the `EventSource`/`startRun` URL contract from `../src/lib/events` (Task 4, matched by convention — this file has no direct import, it just serves the same query-param shape).
- Produces: `POST /dev/run` → `{ run_id: string }` or `409`/`500`; `GET /dev/events?run_id=...` → SSE tail of `runs/<run_id>/events.jsonl`; `GET /dev/run-file?run_id=...&name=...` → `runs/<run_id>/<name>.json` or `404`.

- [ ] **Step 1: Replace the file**

```ts
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { completeLines, newLinesSince } from '../src/lib/tailFile'

/**
 * Dev-only event feed and pipeline bridge.
 *
 * `GET /dev/events`   fixture mode: replays a fixture JSONL at a fixed pace.
 *                     run mode: tails runs/<run_id>/events.jsonl as it grows.
 * `GET /dev/run-file` serves a sidecar (accepted.json, ...) — fixture or run.
 * `POST /dev/run`     uploads a photo, spawns the real pipeline, and
 *                     resolves with its run_id as soon as it's known.
 *
 * See client/CLAUDE.md build step 8 and
 * docs/superpowers/specs/2026-09-04-live-pipeline-bridge-design.md §3.
 *
 * /dev/events query params:
 *   fixture   success | success-noexpand | nomatch | failed  (fixture mode)
 *   interval  ms between lines (default 800). Fixture-mode pacing only.
 *   run_id    e.g. full-20260904T112413Z-0f9c6d60              (run mode)
 *
 * /dev/run-file query params:
 *   name      sidecar base name, e.g. "accepted"
 *   fixture   as above, OR
 *   run_id    as above
 */

const FIXTURES: Record<string, string> = {
  success: 'fixtures/events-success.jsonl',
  'success-noexpand': 'fixtures/events-success-noexpand.jsonl',
  nomatch: 'fixtures/events-nomatch.jsonl',
  failed: 'fixtures/events-failed.jsonl',
}

const DEFAULT_INTERVAL_MS = 800
const POLL_MS = 300
const FILE_WAIT_MS = 2000
const HARD_CEILING_MS = 5 * 60 * 1000

const RUN_ID_RE = /^[a-zA-Z0-9_-]+$/
const NAME_RE = /^[a-z0-9_-]+$/i

export function jsonlSse(): Plugin {
  return {
    name: 'eotw:jsonl-sse',
    configureServer(server) {
      const runsDir = resolve(server.config.root, '../runs')
      const backendDir = resolve(server.config.root, '../backend')
      const uploadsDir = resolve(backendDir, 'uploads')

      // Shared across /dev/run and /dev/events: at most one pipeline
      // process alive at a time (spec §3).
      let runInFlight = false

      server.middlewares.use('/dev/run', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('POST only')
          return
        }
        if (runInFlight) {
          res.statusCode = 409
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'run_in_progress' }))
          return
        }

        const chunks: Buffer[] = []
        for await (const chunk of req) {
          chunks.push(chunk as Buffer)
        }
        const bytes = Buffer.concat(chunks)
        if (bytes.length === 0) {
          res.statusCode = 400
          res.end('empty upload')
          return
        }

        const ext = extFor(req.headers['content-type'])
        await mkdir(uploadsDir, { recursive: true })
        const uploadPath = resolve(uploadsDir, `${randomUUID()}.${ext}`)
        await writeFile(uploadPath, bytes)

        const pythonBin = resolve(backendDir, '.venv/bin/python3')
        const child = spawn(pythonBin, [resolve(backendDir, 'smoke_full.py'), uploadPath], {
          cwd: backendDir,
        })
        runInFlight = true

        let responded = false
        let stdoutBuf = ''

        child.stdout.on('data', (data: Buffer) => {
          const text = data.toString('utf8')
          stdoutBuf += text
          server.config.logger.info(`[live-run] ${text.trimEnd()}`)
          if (!responded) {
            const match = stdoutBuf.match(/FULL RUN (\S+)/)
            if (match) {
              responded = true
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ run_id: `full-${match[1]}` }))
            }
          }
        })
        child.stderr.on('data', (data: Buffer) => {
          server.config.logger.warn(`[live-run] ${data.toString('utf8').trimEnd()}`)
        })
        child.on('error', (err) => {
          runInFlight = false
          if (!responded) {
            responded = true
            res.statusCode = 500
            res.end(`could not start pipeline: ${err.message}`)
          }
        })
        child.on('exit', (code) => {
          runInFlight = false
          server.config.logger.info(`[live-run] pipeline exited (${code})`)
          if (!responded) {
            responded = true
            res.statusCode = 500
            res.end(`pipeline exited before starting (code ${code})`)
          }
        })
      })

      server.middlewares.use('/dev/events', async (req, res) => {
        const params = new URL(req.url ?? '/', 'http://localhost').searchParams
        const runId = params.get('run_id')

        if (runId) {
          await streamRun(req, res, runId, runsDir, () => runInFlight)
          return
        }

        const fixture = params.get('fixture') ?? 'success'
        const interval = Number(params.get('interval') ?? DEFAULT_INTERVAL_MS)

        const rel = FIXTURES[fixture]
        if (!rel) {
          res.statusCode = 400
          res.end(`unknown fixture "${fixture}" (expected: ${Object.keys(FIXTURES).join(', ')})`)
          return
        }

        let lines: string[]
        try {
          const raw = await readFile(resolve(server.config.root, rel), 'utf8')
          lines = raw
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
        } catch (err) {
          res.statusCode = 500
          res.end(`could not read ${rel}: ${(err as Error).message}`)
          return
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        })
        res.write('retry: 3000\n\n')

        let closed = false
        req.on('close', () => {
          closed = true
        })

        server.config.logger.info(
          `[jsonl-sse] streaming ${rel} (${lines.length} lines, ${interval}ms/line)`,
        )

        for (const line of lines) {
          if (closed) return
          res.write(`data: ${line}\n\n`)
          await delay(interval)
        }

        if (!closed) {
          res.write('event: end\ndata: {}\n\n')
          res.end()
        }
      })

      server.middlewares.use('/dev/run-file', async (req, res) => {
        const params = new URL(req.url ?? '/', 'http://localhost').searchParams
        const runId = params.get('run_id')
        const name = params.get('name') ?? ''

        if (!NAME_RE.test(name)) {
          res.statusCode = 400
          res.end(`bad run-file request: name="${name}"`)
          return
        }

        let filePath: string
        if (runId) {
          if (!RUN_ID_RE.test(runId)) {
            res.statusCode = 400
            res.end(`bad run_id "${runId}"`)
            return
          }
          filePath = resolve(runsDir, runId, `${name}.json`)
        } else {
          const fixture = params.get('fixture') ?? 'success'
          if (!(fixture in FIXTURES)) {
            res.statusCode = 400
            res.end(`bad run-file request: fixture="${fixture}"`)
            return
          }
          filePath = resolve(server.config.root, `fixtures/${name}.${fixture}.json`)
        }

        try {
          const raw = await readFile(filePath, 'utf8')
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' })
          res.end(raw)
        } catch {
          // A run legitimately may not have a given sidecar.
          res.statusCode = 404
          res.end(`no sidecar for ${filePath}`)
        }
      })
    },
  }
}

async function streamRun(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  runsDir: string,
  isRunInFlight: () => boolean,
): Promise<void> {
  if (!RUN_ID_RE.test(runId)) {
    res.statusCode = 400
    res.end(`bad run_id "${runId}"`)
    return
  }

  const eventsPath = resolve(runsDir, runId, 'events.jsonl')

  const waitStart = Date.now()
  while (!(await exists(eventsPath))) {
    if (Date.now() - waitStart > FILE_WAIT_MS) {
      res.statusCode = 404
      res.end(`no such run "${runId}"`)
      return
    }
    await delay(POLL_MS)
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })
  res.write('retry: 3000\n\n')

  let closed = false
  req.on('close', () => {
    closed = true
  })

  const start = Date.now()
  let sentCount = 0

  while (!closed) {
    if (Date.now() - start > HARD_CEILING_MS) break

    let raw = ''
    try {
      raw = await readFile(eventsPath, 'utf8')
    } catch {
      // file briefly missing/mid-write; try again next tick
    }

    const result = newLinesSince(raw, sentCount)
    sentCount = result.sentCount
    for (const line of result.lines) {
      if (closed) break
      res.write(`data: ${line}\n\n`)
    }

    if (!isRunInFlight() && sentCount === completeLines(raw).length) {
      // the process has exited and we've drained every line it wrote
      break
    }

    await delay(POLL_MS)
  }

  if (!closed) {
    res.write('event: end\ndata: {}\n\n')
    res.end()
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function extFor(contentType: string | undefined): string {
  switch (contentType) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    default:
      return 'bin'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
```

- [ ] **Step 2: Verify fixture mode still works exactly as before (regression check)**

```bash
cd client && npm run dev
```
In another terminal: `curl -sN http://localhost:5273/dev/events?fixture=success | head -5`
Expected: the same SSE lines as before this change (first few `FaceDetected`/`ImageHosted` events).

- [ ] **Step 3: Verify run-mode tailing against an already-completed real run (no spawn needed)**

Pick any existing completed run directory, e.g. `ls runs | grep ^full- | tail -1`. With the dev server still running:

```bash
curl -sN "http://localhost:5273/dev/events?run_id=full-<pick-one>"
```
Expected: every line of that run's `events.jsonl` streamed as `data: ...` frames, ending with `event: end\ndata: {}`. Since no process is spawned for this run_id, `isRunInFlight()` is `false` from the first poll — the stream should end almost immediately after sending every existing line, not hang for 5 minutes.

- [ ] **Step 4: Verify `/dev/run-file` run mode**

```bash
curl -s "http://localhost:5273/dev/run-file?run_id=full-<same-id>&name=accepted"
curl -s "http://localhost:5273/dev/run-file?run_id=full-<same-id>&name=does-not-exist"
```
Expected: first returns the real `accepted.json` contents (200); second returns 404.

- [ ] **Step 5: Verify the `/dev/run` guard and upload path, without spending real API quota**

This step confirms the endpoint wiring, not a full pipeline run — no `.env` secrets are required for the guard/spawn-start behavior to be observable within a few seconds.

```bash
curl -s -X POST http://localhost:5273/dev/run --data-binary @client/media/Success.mp4 -H "Content-Type: image/jpeg" &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:5273/dev/run --data-binary @client/media/Success.mp4 -H "Content-Type: image/jpeg"
```
Expected: the second request returns `409` while the first is still in flight (`smoke_full.py` will itself fail fast on the invalid "image", which is fine — this step is only checking the upload/spawn/guard wiring, not a real run). Check the dev server's own terminal output for the `[live-run]` log lines.

Stop the dev server (`Ctrl+C`) after this check.

- [ ] **Step 6: Run the full test suite and build**

Run: `cd client && npx vitest run && npm run build`
Expected: PASS, 95 tests; build succeeds with no type errors (this file has no `.test.ts`, so vitest's count is unchanged from Task 4, but `tsc -b` inside `npm run build` now type-checks this file too).

- [ ] **Step 7: Commit**

```bash
git add client/vite-plugins/jsonl-sse.ts
git commit -m "feat(client): add POST /dev/run and run-mode tailing to the dev bridge

/dev/run uploads a photo and spawns backend/smoke_full.py, one run at
a time. /dev/events and /dev/run-file gain a run_id mode that tails
runs/<run_id>/events.jsonl incrementally instead of replaying a
fixture. Fixture mode is unchanged. See
docs/superpowers/specs/2026-09-04-live-pipeline-bridge-design.md §3.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Generalize `client/src/hooks/useEventStream.ts`

**Files:**
- Modify: `client/src/hooks/useEventStream.ts`

**Interfaces:**
- Consumes: `EventSource`, `eventStreamUrl`, `runFileUrl` from `../lib/events` (Task 4).
- Produces: `useEventStream(source: EventSource): EventStream` (renamed parameter type; `EventStream` return shape unchanged) — consumed by Task 9 (`App.tsx`).

- [ ] **Step 1: Update the import and function signature**

In `client/src/hooks/useEventStream.ts`, replace:

```ts
import { eventStreamUrl, runFileUrl, type FixtureName, type StreamOptions } from '../lib/events'
```

with:

```ts
import { eventStreamUrl, runFileUrl, type EventSource } from '../lib/events'
```

Replace:

```ts
export function useEventStream(options: StreamOptions): EventStream {
  const [scene, dispatch] = useReducer(reduceScene, initialScene)
  const [lines, setLines] = useState<TerminalLine[]>([])

  const sourceUrl = eventStreamUrl(options)
```

with:

```ts
export function useEventStream(source: EventSource): EventStream {
  const [scene, dispatch] = useReducer(reduceScene, initialScene)
  const [lines, setLines] = useState<TerminalLine[]>([])

  const sourceUrl = eventStreamUrl(source)
```

- [ ] **Step 2: Drop the now-redundant `fixture` local and use `source` directly**

Replace:

```ts
  useEffect(() => {
    const fixture: FixtureName = options.fixture ?? 'success'
    let lineId = 0
```

with:

```ts
  useEffect(() => {
    let lineId = 0
```

And replace the `PostAccepted` sidecar fetch:

```ts
      if (name === 'PostAccepted') {
        void fetch(runFileUrl(fixture, 'accepted'))
```

with:

```ts
      if (name === 'PostAccepted') {
        void fetch(runFileUrl(source, 'accepted'))
```

- [ ] **Step 3: Simplify the effect's dependency array**

`sourceUrl` is already fully derived from `source` (it encodes fixture/interval or run_id), so the separate `options.fixture` dependency was redundant. Replace:

```ts
  }, [sourceUrl, options.fixture])
```

with:

```ts
  }, [sourceUrl])
```

- [ ] **Step 4: Type-check and run the full test suite**

Run: `cd client && npx tsc -b && npx vitest run`
Expected: `tsc -b` succeeds (no leftover references to `StreamOptions`/`FixtureName` in this file — `App.tsx` will still fail type-check until Task 9, which is fine as an intermediate state; if `tsc -b` fails only on `App.tsx`, that confirms this file itself is correct). `vitest run`: PASS, 95 tests (this file has no dedicated test suite — it's exercised live, per existing project convention).

- [ ] **Step 5: Commit**

```bash
git add client/src/hooks/useEventStream.ts
git commit -m "refactor(client): useEventStream takes an EventSource, not a fixture

Generalizes the hook so it can drive off a real run_id, not just a
fixture name. See
docs/superpowers/specs/2026-09-04-live-pipeline-bridge-design.md §4.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: `UploadGate` component

**Files:**
- Create: `client/src/components/UploadGate.tsx`
- Modify: `client/src/index.css`

**Interfaces:**
- Consumes: `startRun`, `RunConflictError` from `../lib/events` (Task 4).
- Produces: `UploadGate({ onStarted: (runId: string) => void })` — consumed by Task 9 (`App.tsx`).

- [ ] **Step 1: Create the component**

Create `client/src/components/UploadGate.tsx`:

```tsx
/**
 * The upload gate. Shown only when no `?fixture=` is pinned in the URL —
 * the real entry point: pick a photo, kick off a real pipeline run.
 *
 * Holds no pipeline knowledge beyond "post a file, get a run id back or an
 * error" — see
 * docs/superpowers/specs/2026-09-04-live-pipeline-bridge-design.md §4.
 */

import { useCallback, useRef, useState } from 'react'
import { RunConflictError, startRun } from '../lib/events'

const MAX_BYTES = 15 * 1024 * 1024

type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'error'; message: string }

export function UploadGate({ onStarted }: { onStarted: (runId: string) => void }) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        setStatus({ kind: 'error', message: 'that is not an image the Eye can read' })
        return
      }
      if (file.size > MAX_BYTES) {
        setStatus({ kind: 'error', message: 'too large — under 15MB, please' })
        return
      }
      setStatus({ kind: 'busy' })
      try {
        const { runId } = await startRun(file)
        onStarted(runId)
      } catch (err) {
        if (err instanceof RunConflictError) {
          setStatus({ kind: 'error', message: 'a ritual is already underway — wait for it to finish' })
        } else {
          setStatus({ kind: 'error', message: 'the rite failed to begin — try again' })
        }
      }
    },
    [onStarted],
  )

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files?.[0]
      if (file) void submit(file)
    },
    [submit],
  )

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) void submit(file)
      e.target.value = ''
    },
    [submit],
  )

  return (
    <div className="upload-gate">
      <div
        className={`upload-gate__drop${dragOver ? ' is-drag-over' : ''}${status.kind === 'busy' ? ' is-busy' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => status.kind !== 'busy' && inputRef.current?.click()}
        role="button"
        tabIndex={0}
      >
        <p className="upload-gate__title">Show Her Your Face</p>
        <p className="upload-gate__hint">
          {status.kind === 'busy' ? 'the Eye is opening…' : 'drop a photo, or click to choose one'}
        </p>
        {status.kind === 'error' && <p className="upload-gate__error">{status.message}</p>}
      </div>
      <input ref={inputRef} type="file" accept="image/*" className="upload-gate__input" onChange={onPick} />
    </div>
  )
}
```

- [ ] **Step 2: Add its styling to `client/src/index.css`**

Append to `client/src/index.css`, after the `/* ---- right terminal ---- */` block:

```css
/* ---- upload gate (idle, before any run) ---- */
.upload-gate {
  height: 100%;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #04060a;
  font-family: 'EB Garamond', 'Cormorant Garamond', Georgia, 'Times New Roman', serif;
}
.upload-gate__drop {
  cursor: pointer;
  width: min(80%, 380px);
  padding: 40px 28px;
  text-align: center;
  background: linear-gradient(180deg, #160f1c, #0a0710);
  border: 2px dashed #6b4b1f;
  border-radius: 8px;
  transition: border-color 200ms ease, background 200ms ease;
}
.upload-gate__drop.is-drag-over {
  border-color: #d9b45b;
  background: linear-gradient(180deg, #1c1424, #0e0a16);
}
.upload-gate__drop.is-busy {
  cursor: wait;
  opacity: 0.75;
}
.upload-gate__title {
  margin: 0 0 10px;
  font-size: 22px;
  letter-spacing: 0.04em;
  color: #e8c98a;
}
.upload-gate__hint {
  margin: 0;
  font-size: 14px;
  font-style: italic;
  color: #a89a7a;
}
.upload-gate__error {
  margin: 14px 0 0;
  font-size: 12.5px;
  color: #e0a58a;
}
.upload-gate__input {
  display: none;
}
```

- [ ] **Step 3: Type-check**

Run: `cd client && npx tsc -b`
Expected: no new errors from this file (App.tsx wiring happens in Task 9 — until then this component simply isn't imported anywhere yet, which is fine).

- [ ] **Step 4: Commit**

```bash
git add client/src/components/UploadGate.tsx client/src/index.css
git commit -m "feat(client): add UploadGate component

Drag/drop or click-to-pick image upload, client-side type/size
validation, posts to /dev/run via startRun(). Not yet wired into
App.tsx (Task 9). See
docs/superpowers/specs/2026-09-04-live-pipeline-bridge-design.md §4.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: "Cast again" reset control

**Files:**
- Create: `client/src/components/layers/CastAgain.tsx`
- Modify: `client/src/components/RitualStage.tsx`
- Modify: `client/src/index.css`

**Interfaces:**
- Consumes: `isTerminalPhase`, `type Phase` from `../../scene/state` (existing).
- Produces: `RitualStage({ scene: SceneState; onCastAgain?: () => void })` (new optional prop) — consumed by Task 9 (`App.tsx`).

- [ ] **Step 1: Create the control**

Create `client/src/components/layers/CastAgain.tsx`:

```tsx
/**
 * Live-mode-only reset control. Shown at any terminal phase, but only when
 * the app has given us a reset handler — never in fixture mode, where the
 * URL alone decides what plays. See client/CLAUDE.md build step 8.
 */

import { isTerminalPhase, type Phase } from '../../scene/state'

export function CastAgain({ phase, onCastAgain }: { phase: Phase; onCastAgain?: () => void }) {
  if (!onCastAgain || !isTerminalPhase(phase)) return null

  return (
    <button type="button" className="cast-again" onClick={onCastAgain}>
      ↺ cast again
    </button>
  )
}
```

- [ ] **Step 2: Wire it into `RitualStage`**

In `client/src/components/RitualStage.tsx`, add the import:

```tsx
import { CastAgain } from './layers/CastAgain'
```

Change the component signature from:

```tsx
export function RitualStage({ scene }: { scene: SceneState }) {
```

to:

```tsx
export function RitualStage({ scene, onCastAgain }: { scene: SceneState; onCastAgain?: () => void }) {
```

And add `<CastAgain />` as the last child of `.ritual-chrome`, right after `<JRPGTextbox entries={scene.narration} />`:

```tsx
        <JRPGTextbox entries={scene.narration} />
        <CastAgain phase={scene.phase} onCastAgain={onCastAgain} />
      </div>
```

- [ ] **Step 3: Style it**

Append to `client/src/index.css`, after the `.upload-gate__input` block:

```css
/* ---- cast again (live mode only) ---- */
.cast-again {
  pointer-events: auto;
  position: absolute;
  right: 3%;
  bottom: calc(3% + 78px);
  padding: 6px 14px;
  font-family: 'EB Garamond', Georgia, serif;
  font-size: 12px;
  letter-spacing: 0.04em;
  color: #e8c98a;
  background: rgba(10, 7, 16, 0.75);
  border: 1px solid #6b4b1f;
  border-radius: 4px;
  cursor: pointer;
  transition: border-color 150ms ease;
}
.cast-again:hover {
  border-color: #d9b45b;
}
```

- [ ] **Step 4: Type-check and run the full test suite**

Run: `cd client && npx tsc -b && npx vitest run`
Expected: PASS, 95 tests. (`App.tsx` doesn't pass `onCastAgain` yet — that's Task 9; the prop is optional so this compiles fine on its own.)

- [ ] **Step 5: Commit**

```bash
git add client/src/components/layers/CastAgain.tsx client/src/components/RitualStage.tsx client/src/index.css
git commit -m "feat(client): add cast-again reset control to RitualStage

Optional onCastAgain prop, rendered only at a terminal phase and only
when the app provides a handler (never in fixture mode). Not yet wired
into App.tsx (Task 9). See
docs/superpowers/specs/2026-09-04-live-pipeline-bridge-design.md §4.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Wire it all together in `App.tsx`

**Files:**
- Modify: `client/src/App.tsx`

**Interfaces:**
- Consumes: `EventSource`, `type FixtureName` (`../lib/events`, Task 4), `useEventStream` (`../hooks/useEventStream`, Task 6), `UploadGate` (Task 7), `RitualStage`'s new `onCastAgain` prop (Task 8).

- [ ] **Step 1: Replace the file**

```tsx
import { useCallback, useState } from 'react'
import { SplitShell } from './components/SplitShell'
import { EventTerminal } from './components/EventTerminal'
import { RitualStage } from './components/RitualStage'
import { UploadGate } from './components/UploadGate'
import { useEventStream } from './hooks/useEventStream'
import type { EventSource, FixtureName } from './lib/events'

const FIXTURES: FixtureName[] = ['success', 'success-noexpand', 'nomatch', 'failed']

/** `?fixture=nomatch` / `?fixture=failed` for the verify checklist. Absent
 *  entirely -> the real upload gate, not a default fixture. */
function readFixture(): FixtureName | null {
  const q = new URLSearchParams(window.location.search).get('fixture')
  return (FIXTURES as string[]).includes(q ?? '') ? (q as FixtureName) : null
}

// Resolved once at load: fixture mode is locked in by the URL for the whole
// session, exactly as before. Run mode is chosen live via the upload gate.
const FIXED_FIXTURE = readFixture()

type Stage = { kind: 'gate' } | { kind: 'active'; source: EventSource }

export default function App() {
  const [stage, setStage] = useState<Stage>(() =>
    FIXED_FIXTURE
      ? { kind: 'active', source: { mode: 'fixture', fixture: FIXED_FIXTURE, interval: 800 } }
      : { kind: 'gate' },
  )

  const handleStarted = useCallback((runId: string) => {
    setStage({ kind: 'active', source: { mode: 'run', runId } })
  }, [])

  const handleCastAgain = useCallback(() => {
    setStage({ kind: 'gate' })
  }, [])

  if (stage.kind === 'gate') {
    return (
      <SplitShell
        left={<UploadGate onStarted={handleStarted} />}
        right={
          <div className="terminal-frame">
            <header className="terminal-frame__bar">
              <span className="terminal-frame__dot" />
              backend event stream · waiting for a photo
            </header>
            <EventTerminal lines={[]} />
          </div>
        }
      />
    )
  }

  return (
    <ActiveRun
      key={stage.source.mode === 'run' ? stage.source.runId : stage.source.fixture}
      source={stage.source}
      onCastAgain={handleCastAgain}
    />
  )
}

function ActiveRun({ source, onCastAgain }: { source: EventSource; onCastAgain: () => void }) {
  const { scene, lines } = useEventStream(source)
  const label =
    source.mode === 'fixture'
      ? `fixtures/events-${source.fixture}.jsonl`
      : `runs/${source.runId}/events.jsonl`

  return (
    <SplitShell
      left={<RitualStage scene={scene} onCastAgain={source.mode === 'run' ? onCastAgain : undefined} />}
      right={
        <div className="terminal-frame">
          <header className="terminal-frame__bar">
            <span className="terminal-frame__dot" />
            backend event stream · {label}
          </header>
          <EventTerminal lines={lines} />
        </div>
      }
    />
  )
}
```

- [ ] **Step 2: Type-check and run the full test suite**

Run: `cd client && npx tsc -b && npx vitest run`
Expected: both succeed cleanly now — this was the last file referencing the old `StreamOptions` shape. `vitest run`: PASS, 95 tests.

- [ ] **Step 3: Live regression check — fixture mode unaffected**

```bash
npm run dev
```
Open `http://localhost:5273/?fixture=success` in a browser. Expected: identical behavior to before this plan — full run-through, scroll unfurls, no "cast again" button visible anywhere (fixture mode never passes `onCastAgain`).

- [ ] **Step 4: Live check — upload gate**

Open `http://localhost:5273/` (no query param). Expected: the upload gate renders instead of any video/terminal stream; the right pane shows "waiting for a photo" with an empty terminal.

- [ ] **Step 5: Live check — client-side validation**

Try dragging a non-image file (e.g. a `.txt`) onto the drop zone. Expected: inline error "that is not an image the Eye can read", no network request fired (check the Network tab — no `POST /dev/run`).

- [ ] **Step 6: Stop the dev server**

- [ ] **Step 7: Commit**

```bash
git add client/src/App.tsx
git commit -m "feat(client): wire upload gate and run mode into App

No ?fixture= in the URL now shows the upload gate; a successful
upload switches to run mode (a fresh useEventStream keyed on run_id).
Fixture mode is unchanged and never shows the cast-again control. See
docs/superpowers/specs/2026-09-04-live-pipeline-bridge-design.md §4.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: Final regression pass and live-run readiness check

**Files:** none (verification only).

- [ ] **Step 1: Full automated suite**

Run: `cd client && npx vitest run && npx tsc -b && npm run build`
Expected: 95/95 tests pass, no type errors, build succeeds.

- [ ] **Step 2: Live walkthrough — all four fixtures still exact**

With `npm run dev` running, open each of `?fixture=success`, `?fixture=success-noexpand`, `?fixture=nomatch`, `?fixture=failed` in turn. Expected: identical to the RPGM-redesign verification already documented in [client/CLAUDE.md](../../../client/CLAUDE.md)'s "Left panel v2" section — no regressions from this plan's changes.

- [ ] **Step 3: Live walkthrough — cast again**

Load a fixture URL that ends in a terminal phase — this won't show "cast again" (fixture mode never does, by design). Instead: after a live run reaches a terminal phase (Step 5 below), click "cast again" and confirm it returns to the upload gate, and that a second upload starts a genuinely fresh scene (no leftover narration lines or stars from the previous run).

- [ ] **Step 4: Confirm the one-run-at-a-time guard end-to-end**

Start a live run (Step 5 below), then — while it's still in flight — try uploading a second image through the gate (open a second browser tab at `http://localhost:5273/`). Expected: the second upload's gate shows "a ritual is already underway — wait for it to finish".

- [ ] **Step 5: Explicit go-ahead checkpoint — genuine live pipeline run**

Everything up to here is verifiable without spending anything. This step is different: uploading a real photo and letting it run to completion calls real SerpAPI and imgbb endpoints and submits a real transaction on Sepolia testnet from the `backend/.env` wallet's `PRIVATE_KEY`. **Do not perform this step without the user's explicit go-ahead at the time**, separate from this plan's approval. When given the go-ahead: upload `backend/samples/elon_musk.jpg` (or any real face photo) through the gate at `http://localhost:5273/` and confirm the full journey — `scrying` → `weighing` → `weaving` → `naming` → a settled outcome — arrives driven entirely by real events, matching the existing UI exactly as fixture playback does.

- [ ] **Step 6: Stop the dev server. No commit for this task** — it's verification only; any last-mile fixes it surfaces belong to the task whose file they touch, with their own commit.
