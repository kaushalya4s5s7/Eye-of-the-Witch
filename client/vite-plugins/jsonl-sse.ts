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
// Cold InsightFace model download can take 45s+ before first event writes.
// This only governs the initial "does run's event file exist yet" check;
// per-event polling (POLL_MS) and stream ceiling (HARD_CEILING_MS) unaffected.
const FILE_WAIT_MS = 90000
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
