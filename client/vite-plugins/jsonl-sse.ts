import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type { Plugin, ViteDevServer } from 'vite'
import { newLinesSince } from '../src/lib/tailFile'

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
// Cold InsightFace model download can take 45s+ before first event writes.
// This only governs the initial "does run's event file exist yet" check;
// per-event polling (POLL_MS) and stream ceiling (HARD_CEILING_MS) unaffected.
const FILE_WAIT_MS = 90000
const HARD_CEILING_MS = 5 * 60 * 1000
// Multi-photo seed gallery: up to 5 faces × 15MB. Total request cap.
const MAX_FILES = 5
const MAX_FILE_BYTES = 15 * 1024 * 1024
const MAX_UPLOAD_BYTES = MAX_FILES * MAX_FILE_BYTES

const RUN_ID_RE = /^[a-zA-Z0-9_-]+$/
const NAME_RE = /^[a-z0-9_-]+$/i

type UploadedImage = { bytes: Buffer; contentType: string; filename: string }

async function readUploadedImages(req: import('node:http').IncomingMessage): Promise<UploadedImage[]> {
  const chunks: Buffer[] = []
  let uploadedBytes = 0
  for await (const chunk of req) {
    uploadedBytes += (chunk as Buffer).length
    if (uploadedBytes > MAX_UPLOAD_BYTES) {
      const err = new Error(`upload too large — max ${MAX_UPLOAD_BYTES} bytes`)
      ;(err as Error & { statusCode: number }).statusCode = 413
      throw err
    }
    chunks.push(chunk as Buffer)
  }
  const body = Buffer.concat(chunks)
  if (body.length === 0) {
    const err = new Error('empty upload')
    ;(err as Error & { statusCode: number }).statusCode = 400
    throw err
  }

  const contentType = String(req.headers['content-type'] || '')
  if (contentType.includes('multipart/form-data')) {
    const webReq = new Request('http://localhost/dev/run', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    })
    const form = await webReq.formData()
    const parts = form.getAll('images')
    const out: UploadedImage[] = []
    for (const part of parts) {
      if (typeof part === 'string') continue
      const file = part as File
      const bytes = Buffer.from(await file.arrayBuffer())
      if (bytes.length === 0) continue
      if (bytes.length > MAX_FILE_BYTES) {
        const err = new Error(`each likeness must be under ${MAX_FILE_BYTES} bytes`)
        ;(err as Error & { statusCode: number }).statusCode = 413
        throw err
      }
      out.push({
        bytes,
        contentType: file.type || 'application/octet-stream',
        filename: file.name || 'upload',
      })
    }
    if (out.length === 0) {
      const err = new Error('empty upload')
      ;(err as Error & { statusCode: number }).statusCode = 400
      throw err
    }
    if (out.length > MAX_FILES) {
      const err = new Error(`at most ${MAX_FILES} likenesses`)
      ;(err as Error & { statusCode: number }).statusCode = 400
      throw err
    }
    return out
  }

  // Legacy single raw-body upload (pre multi-photo).
  return [
    {
      bytes: body,
      contentType,
      filename: 'upload',
    },
  ]
}

export function jsonlSse(): Plugin {
  return {
    name: 'eotw:jsonl-sse',
    apply: 'serve',
    configureServer(server) {
      const runsDir = resolve(server.config.root, '../runs')
      const backendDir = resolve(server.config.root, '../backend')
      const uploadsDir = resolve(backendDir, 'uploads')
      const backendRunsLink = resolve(backendDir, 'runs')

      warnIfRunsLinkMissing(server, backendRunsLink, runsDir)

      // Shared across /dev/run and /dev/events: at most one pipeline process
      // alive at a time (spec §3), *and* which run_id it is (M2) — so tailing
      // a different (e.g. older, already-completed) run_id never mistakes
      // "some run is alive" for "this run is alive" and hangs until
      // HARD_CEILING_MS. `PENDING` is a placeholder held only between
      // claiming the slot and learning the child's real run_id from its
      // stdout; it can never collide with a real run_id (those all start
      // with "full-" and are validated against RUN_ID_RE).
      const PENDING = '__pending__'
      let inFlightRunId: string | null = null

      server.middlewares.use('/dev/run', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('POST only')
          return
        }
        if (inFlightRunId !== null) {
          res.statusCode = 409
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'run_in_progress' }))
          return
        }
        // Claim the slot immediately, before any await, so two concurrent
        // POSTs can't both pass the check above (TOCTOU). Cleared on every
        // early-return/error path below, not just the happy path.
        inFlightRunId = PENDING

        try {
          let images: UploadedImage[]
          try {
            images = await readUploadedImages(req)
          } catch (readErr) {
            inFlightRunId = null
            const status = (readErr as Error & { statusCode?: number }).statusCode ?? 400
            res.statusCode = status
            res.end((readErr as Error).message)
            return
          }

          await mkdir(uploadsDir, { recursive: true })
          const uploadPaths: string[] = []
          for (const img of images) {
            const ext = extFor(img.contentType) || extFromName(img.filename)
            const uploadPath = resolve(uploadsDir, `${randomUUID()}.${ext}`)
            await writeFile(uploadPath, img.bytes)
            uploadPaths.push(uploadPath)
          }

          const pythonBin = resolve(backendDir, '.venv/bin/python3')
          // Strip Cursor/sandbox proxy vars — they point at a local proxy that
          // often isn't running, so requests to imgbb/SerpAPI die with
          // ProxyError / connection refused and the run emits Failed.
          const childEnv = { ...process.env }
          for (const key of Object.keys(childEnv)) {
            if (/^(.*_)?prox(y|ies)$/i.test(key) || /^no_proxy$/i.test(key)) {
              delete childEnv[key]
            }
          }
          // Assign run_id in Node and return it immediately so the UI can open
          // SSE *before* the pipeline finishes. Waiting on "FULL RUN" in stdout
          // used to buffer until process exit (Python fully-buffers when not a
          // TTY), so the terminal dumped every event at once at the end.
          const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
          const runId = `full-${stamp}-${randomUUID().replace(/-/g, '').slice(0, 8)}`
          childEnv.EOTW_RUN_ID = runId
          childEnv.PYTHONUNBUFFERED = '1'

          const child = spawn(
            pythonBin,
            ['-u', resolve(backendDir, 'smoke_full.py'), ...uploadPaths],
            {
              cwd: backendDir,
              env: childEnv,
            },
          )

          const cleanupUpload = async () => {
            for (const uploadPath of uploadPaths) {
              try {
                await unlink(uploadPath)
              } catch (err) {
                server.config.logger.warn(
                  `[live-run] could not remove uploaded file ${uploadPath}: ${(err as Error).message}`,
                )
              }
            }
          }

          // Hand run_id to the client immediately — SSE waits for events.jsonl.
          inFlightRunId = runId
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ run_id: runId, images: uploadPaths.length }))

          child.stdout.on('data', (data: Buffer) => {
            server.config.logger.info(`[live-run] ${data.toString('utf8').trimEnd()}`)
          })
          child.stderr.on('data', (data: Buffer) => {
            server.config.logger.warn(`[live-run] ${data.toString('utf8').trimEnd()}`)
          })
          child.on('error', (err) => {
            inFlightRunId = null
            void cleanupUpload()
            server.config.logger.error(`[live-run] could not start pipeline: ${err.message}`)
          })
          child.on('exit', (code) => {
            inFlightRunId = null
            server.config.logger.info(`[live-run] pipeline exited (${code})`)
            void cleanupUpload()
          })
        } catch (err) {
          inFlightRunId = null
          if (!res.headersSent) {
            res.statusCode = 500
            res.end(`could not start pipeline: ${(err as Error).message}`)
          }
        }
      })

      server.middlewares.use('/dev/events', async (req, res) => {
        const params = new URL(req.url ?? '/', 'http://localhost').searchParams
        const runId = params.get('run_id')

        if (runId) {
          await streamRun(req, res, runId, runsDir, () => inFlightRunId === runId)
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
        res.write('retry: 3600000\n\n')

        let closed = false
        req.on('close', () => {
          closed = true
        })

        server.config.logger.info(
          `[jsonl-sse] streaming ${rel} (${lines.length} lines, ${interval}ms/line)`,
        )

        let id = 0
        for (const line of lines) {
          if (closed) return
          id += 1
          res.write(`id: ${id}\n`)
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
          // A run legitimately may not have a given sidecar. Name the request,
          // not the resolved absolute server-side path (M14).
          res.statusCode = 404
          res.end(`no sidecar "${name}" for ${runId ? `run_id="${runId}"` : `fixture="${params.get('fixture') ?? 'success'}"`}`)
        }
      })
    },
  }
}

/**
 * Minimal surface of `http.IncomingMessage` that `streamRun` actually reads.
 * Kept separate (rather than requiring a real `IncomingMessage`) so tests can
 * drive `streamRun` with a lightweight fake instead of standing up a real
 * request (R3). Real `IncomingMessage` instances satisfy this structurally.
 */
export interface StreamRunRequest {
  on(event: 'close', listener: () => void): void
}

/**
 * Minimal surface of `http.ServerResponse` that `streamRun` actually writes
 * to. Same rationale as `StreamRunRequest`. Real `ServerResponse` instances
 * satisfy this structurally.
 */
export interface StreamRunResponse {
  statusCode: number
  writeHead(statusCode: number, headers?: Record<string, string>): void
  write(chunk: string): void
  end(chunk?: string): void
}

export async function streamRun(
  req: StreamRunRequest,
  res: StreamRunResponse,
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

  // Registered before the wait loop so a client that disconnects while
  // waiting for the file to appear is observed promptly, not just once the
  // tailing loop below starts.
  let closed = false
  req.on('close', () => {
    closed = true
  })

  const waitStart = Date.now()
  while (!(await exists(eventsPath))) {
    if (closed) return
    // The child already exited without ever writing an event: don't wait
    // out the full FILE_WAIT_MS ceiling to say so. (Additive only — a run
    // whose file already exists, e.g. tailing a past completed run, never
    // enters this loop at all.)
    if (!isRunInFlight() || Date.now() - waitStart > FILE_WAIT_MS) {
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
    'X-Accel-Buffering': 'no',
  })
  // Tip the socket into immediate flush mode so each event hits the browser
  // as soon as we write it (otherwise Node may coalesce until the run ends).
  const sock = (res as StreamRunResponse & { socket?: { setNoDelay?: (v: boolean) => void } }).socket
  sock?.setNoDelay?.(true)
  res.write(': connected\n\n')
  // Long retry: a 3s retry was re-opening mid-run and re-sending the whole
  // events.jsonl (duplicate FACE SCAN banners). Client also dedupes.
  res.write('retry: 3600000\n\n')

  const start = Date.now()
  let sentCount = 0

  while (!closed) {
    if (Date.now() - start > HARD_CEILING_MS) break

    let raw: string | null = null
    try {
      raw = await readFile(eventsPath, 'utf8')
    } catch {
      // file briefly missing/mid-write; try again next tick
    }
    if (raw === null) {
      await delay(POLL_MS)
      continue
    }

    const result = newLinesSince(raw, sentCount)
    sentCount = result.sentCount
    for (const line of result.lines) {
      if (closed) break
      res.write(`id: ${sentCount}\n`)
      res.write(`data: ${line}\n\n`)
    }

    if (!isRunInFlight() && result.lines.length === 0) {
      // the process has exited and we've drained every line it wrote
      // (newLinesSince already re-split/re-trimmed raw into result.lines —
      // no need to call completeLines(raw) again just to compare a count).
      break
    }

    await delay(POLL_MS)
  }

  if (!closed) {
    res.write('event: end\ndata: {}\n\n')
    res.end()
  }
}

// Fresh-clone reproducibility (review I3b): `smoke_full.py` writes real
// runs to `backend/runs/<run_id>/`, and that path only reaches the repo-root
// `runs/` the bridge tails via a machine-local, gitignored symlink
// (`backend/runs -> ../runs`). Without it, a live run succeeds silently
// while the bridge polls a directory nothing ever writes to, ending in a
// false `stream_ended` failure ~90s later. This is diagnostic only — it
// must never throw or block dev-server startup, since fixture-mode users
// don't need `backend/runs` at all.
function warnIfRunsLinkMissing(server: ViteDevServer, backendRunsLink: string, runsDir: string): void {
  let linkReal: string | null = null
  try {
    linkReal = realpathSync(backendRunsLink)
  } catch {
    linkReal = null
  }

  let dirReal: string | null = null
  try {
    dirReal = realpathSync(runsDir)
  } catch {
    dirReal = null
  }

  if (linkReal !== null && linkReal === dirReal) return // healthy

  server.config.logger.warn(
    '[jsonl-sse] backend/runs is missing or does not resolve to the repo-root runs/ ' +
      'directory that /dev/events tails. Live runs (POST /dev/run) will appear to hang ' +
      'for up to 90s and then fail with a false "stream_ended" error. ' +
      'Fix: from backend/, run `ln -s ../runs backend/runs` ' +
      '(create the repo-root runs/ directory first if it does not exist). ' +
      'Fixture mode is unaffected.',
  )
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
    case 'image/heic':
      return 'heic'
    case 'image/heif':
      return 'heif'
    default:
      return 'bin'
  }
}

function extFromName(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name)
  return m ? m[1].toLowerCase() : 'bin'
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
