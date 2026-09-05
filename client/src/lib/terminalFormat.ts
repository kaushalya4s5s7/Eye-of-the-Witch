/**
 * Terminal formatting for the right-pane SSE log.
 *
 * Hard rule (client/CLAUDE.md): show EVERY line received. Known events are
 * formatted as a clean staged pipeline (for the screen-recording demo);
 * off-schema / unparseable stay flagged + verbatim.
 *
 * Stages mirror the brief:
 *   Face scan → Web/social search → Evidence graph → Blockchain verify
 */

export const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[38;5;244m',
  name: '\x1b[38;5;81m',
  key: '\x1b[38;5;108m',
  ok: '\x1b[38;5;114m',
  stage: '\x1b[38;5;179m',
  warn: '\x1b[38;5;179m',
  err: '\x1b[38;5;203m',
  bright: '\x1b[1m',
}

export type PipelineStage = 'face' | 'search' | 'graph' | 'chain' | 'fail' | null

const STAGE_FOR: Record<string, PipelineStage> = {
  FaceDetected: 'face',
  GalleryBuilt: 'face',
  ImageHosted: 'face',
  ImageSearchRequested: 'search',
  ImageSearchCompleted: 'search',
  ImageSearchFailed: 'search',
  SearchMerged: 'search',
  PostAccepted: 'search',
  AnchorLocked: 'search',
  ExpandRequested: 'search',
  ExpandCompleted: 'search',
  ExpandSkipped: 'search',
  GraphUpserted: 'graph',
  MerkleBuilt: 'chain',
  Attesting: 'chain',
  Attested: 'chain',
  VerifyPassed: 'chain',
  VerifyFailed: 'chain',
  NoMatchFound: 'fail',
  Failed: 'fail',
}

const STAGE_BANNER: Record<Exclude<PipelineStage, null>, string> = {
  face: '①  FACE SCAN',
  search: '②  WEB / SOCIAL SEARCH',
  graph: '③  EVIDENCE GRAPH',
  chain: '④  BLOCKCHAIN ATTEST + VERIFY',
  fail: '✕  PIPELINE STOPPED',
}

export function stamp(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function shortUrl(url: string, max = 64): string {
  try {
    const u = new URL(url)
    const path = `${u.hostname}${u.pathname}`.replace(/\/$/, '')
    return path.length > max ? `${path.slice(0, max - 1)}…` : path
  } catch {
    return url.length > max ? `${url.slice(0, max - 1)}…` : url
  }
}

function shortHash(h: string, n = 14): string {
  return h.length > n ? `${h.slice(0, n)}…` : h
}

function banner(stage: Exclude<PipelineStage, null>): string {
  const title = STAGE_BANNER[stage]
  return `${ANSI.stage}${ANSI.bright}━━ ${title} ${'━'.repeat(Math.max(4, 42 - title.length))}${ANSI.reset}`
}

function step(label: string, detail?: string): string {
  const head = `${ANSI.dim}[${stamp()}]${ANSI.reset} ${ANSI.ok}✓${ANSI.reset} ${label}`
  return detail ? `${head}  ${ANSI.dim}${detail}${ANSI.reset}` : head
}

function warn(label: string, detail?: string): string {
  const head = `${ANSI.dim}[${stamp()}]${ANSI.reset} ${ANSI.warn}!${ANSI.reset} ${label}`
  return detail ? `${head}  ${ANSI.dim}${detail}${ANSI.reset}` : head
}

function fail(label: string, detail?: string): string {
  const head = `${ANSI.dim}[${stamp()}]${ANSI.reset} ${ANSI.err}✗${ANSI.reset} ${label}`
  return detail ? `${head}  ${ANSI.dim}${detail}${ANSI.reset}` : head
}

/** Human one-liner for a known pipeline event (no stage banner). */
export function describeEvent(obj: Record<string, unknown>): string {
  const name = str(obj.event)
  switch (name) {
    case 'FaceDetected': {
      const gal = num(obj.gallery_size)
      return step(
        'Face detected & encoded',
        `backend=${str(obj.backend)}  det=${num(obj.det_score)?.toFixed(3) ?? '?'}  emb=${shortHash(str(obj.embedding_sha256))}${
          gal != null ? `  gallery=${gal}` : ''
        }`,
      )
    }
    case 'GalleryBuilt': {
      const size = num(obj.size) ?? 1
      const coreset = num(obj.coreset)
      return step(
        size > 1 ? `Seed gallery locked (${size} likenesses)` : 'Seed gallery locked (1 likeness)',
        `kept=${num(obj.kept) ?? size}  rejected=${num(obj.rejected) ?? 0}${
          coreset != null ? `  probes=${coreset}` : ''
        }${obj.deep_opt ? '  deep-opt' : ''}`,
      )
    }
    case 'ImageHosted':
      return step(
        'Face crop hosted for reverse search',
        `${str(obj.probe, 'primary')} → ${shortUrl(str(obj.url))}`,
      )
    case 'ImageSearchRequested': {
      const engines = Array.isArray(obj.engines) ? obj.engines.length : 0
      const probes = Array.isArray(obj.probes) ? obj.probes.length : 0
      return step(
        'Live reverse-image search started',
        probes > 1 ? `${engines} engines × ${probes} probes` : `${engines} engines`,
      )
    }
    case 'ImageSearchCompleted':
      return step(
        `${str(obj.engine, 'engine')} returned hits`,
        `hits=${num(obj.hits) ?? 0}${obj.probe ? `  probe=${obj.probe}` : ''}`,
      )
    case 'ImageSearchFailed':
      return warn(
        `${str(obj.engine, 'engine')} failed (continuing)`,
        str(obj.error).slice(0, 80),
      )
    case 'SearchMerged':
      return step('Candidate URLs merged (deduped)', `unique=${num(obj.unique) ?? 0}`)
    case 'PostAccepted':
      return step(
        'Matching posts accepted',
        `count=${num(obj.count) ?? 0}  top_sim=${num(obj.top_sim)?.toFixed(3) ?? '?'}`,
      )
    case 'AnchorLocked':
      return step(
        'Identity anchor locked (dual-confirm)',
        `sim=${num(obj.face_similarity)?.toFixed(3) ?? '?'}  phash_d=${num(obj.phash_distance) ?? '?'}  ${shortUrl(str(obj.url))}`,
      )
    case 'ExpandRequested':
      return step('Gated expand hop', str(obj.query).slice(0, 72) || str(obj.from_url))
    case 'ExpandCompleted':
      return step('Expand finished', `found=${num(obj.found) ?? 0}`)
    case 'ExpandSkipped':
      return warn('Expand skipped', str(obj.reason, 'gate'))
    case 'GraphUpserted':
      return step(
        'Evidence graph written',
        `nodes=${num(obj.nodes) ?? 0}  edges=${num(obj.edges) ?? 0}`,
      )
    case 'MerkleBuilt':
      return step('Merkle root over accepted posts', shortHash(str(obj.root), 18))
    case 'Attesting':
      return step('Attesting root on EAS (Sepolia)…', shortHash(str(obj.root), 18))
    case 'Attested':
      return step(
        'On-chain attestation confirmed',
        `tx=${shortHash(str(obj.tx_hash), 16)}  uid=${shortHash(str(obj.uid), 16)}`,
      )
    case 'VerifyPassed':
      return step('Re-verify passed — local root matches chain', shortHash(str(obj.root), 18))
    case 'VerifyFailed':
      return fail('Re-verify failed', str(obj.reason))
    case 'NoMatchFound':
      return fail(
        'No matching post cleared the face threshold',
        `checked=${num(obj.candidates_checked) ?? '?'}  ${str(obj.reason)}`,
      )
    case 'Failed':
      return fail('Hard failure', `${str(obj.stage, 'unknown')}: ${str(obj.error)}`)
    case 'CandidateScored':
      return step('Candidate scored', shortUrl(str(obj.url)))
    case 'ConsentBound':
      return step('Consent bound', shortHash(str(obj.consent_hash)))
    default:
      return step(name || 'event')
  }
}

/**
 * Stateful presenter: inserts a stage banner the first time we enter each
 * chapter, then a clean human line for the event.
 */
export class PipelinePresenter {
  private lastStage: PipelineStage = null

  format(obj: Record<string, unknown>): string[] {
    const name = str(obj.event)
    const stage = STAGE_FOR[name] ?? null
    const out: string[] = []
    if (stage && stage !== this.lastStage) {
      if (this.lastStage != null) out.push('')
      out.push(banner(stage))
      this.lastStage = stage
    }
    out.push(describeEvent(obj))
    return out
  }
}

/** @deprecated prefer PipelinePresenter — kept for tests / simple one-liners */
export function formatEventLine(obj: Record<string, unknown>): string {
  return describeEvent(obj)
}

/** Parsed JSON, but off-schema. Shown verbatim. */
export function offSchemaLine(raw: string, problems: string[]): string {
  const why = problems.length ? ` ${ANSI.dim}(${problems.join('; ')})${ANSI.reset}` : ''
  return `${ANSI.warn}! off-schema${ANSI.reset} ${raw}${why}`
}

export function unparseableLine(raw: string): string {
  return `${ANSI.err}✗ unparseable${ANSI.reset} ${raw}`
}

export function noteLine(text: string): string {
  return `${ANSI.dim}-- ${text} --${ANSI.reset}`
}

/** Extra lines after fetching accepted.json — shows the social/web posts found. */
export function formatAcceptedPosts(posts: { url: string; faceSim: number; title: string }[]): string[] {
  if (posts.length === 0) return []
  const lines = [`${ANSI.dim}   matching posts found:${ANSI.reset}`]
  for (const [i, p] of posts.entries()) {
    const title = p.title ? `  “${p.title.slice(0, 40)}${p.title.length > 40 ? '…' : ''}”` : ''
    lines.push(
      `${ANSI.dim}   ${i + 1}.${ANSI.reset} sim=${p.faceSim.toFixed(3)}  ${shortUrl(p.url)}${ANSI.dim}${title}${ANSI.reset}`,
    )
  }
  return lines
}

/** Extra lines after fetching graph.json — shows intelligent-search structure. */
export function formatGraphSummary(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return []
  const g = raw as { nodes?: unknown[]; links?: unknown[]; edges?: unknown[] }
  const nodes = Array.isArray(g.nodes) ? g.nodes : []
  const links = Array.isArray(g.links) ? g.links : Array.isArray(g.edges) ? g.edges : []

  const kinds: Record<string, number> = {}
  let accepted = 0
  let anchors = 0
  let handles = 0
  let hits = 0
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue
    const kind = str((n as Record<string, unknown>).kind, 'Unknown')
    kinds[kind] = (kinds[kind] ?? 0) + 1
    if (kind === 'Post' || kind === 'AcceptedPost') accepted++
    if (kind === 'Anchor') anchors++
    if (kind === 'Handle') handles++
    if (kind === 'ImageHit') hits++
  }

  const kindBits = Object.entries(kinds)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join('  ')

  return [
    `${ANSI.dim}   graph shape: seed → hits → accepted → anchor/handles${ANSI.reset}`,
    `${ANSI.dim}   ${nodes.length} nodes · ${links.length} edges · ${kindBits || 'kinds=?'}${ANSI.reset}`,
    `${ANSI.dim}   flow: ${hits} search hits → ${accepted || kinds['Post'] || 0} accepted · anchors=${anchors} · handles=${handles}${ANSI.reset}`,
  ]
}

export function pipelineBootLines(): string[] {
  return [
    `${ANSI.stage}${ANSI.bright}eye-of-the-witch // live pipeline${ANSI.reset}`,
    `${ANSI.dim}Face scan → Web/social search → Evidence graph → Blockchain attest/verify${ANSI.reset}`,
    '',
  ]
}
