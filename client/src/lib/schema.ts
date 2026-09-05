/**
 * Event vocabulary + runtime validator. Mirrors "Event contract (v1)" in
 * client/CLAUDE.md. If that section changes, change this too — schema.test.ts
 * fails until the fixtures agree.
 *
 * Three tiers:
 *   closed    emitted today, exact payload enforced (fields required, no extras)
 *   open      emitted today, payload not yet locked — name must be valid, fields pass
 *   reserved  name locked, pipeline to follow — validated as open
 *
 * Envelope keys (ts, seq, run_id) are allowed on every event and ignored by
 * the state machine.
 */

type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object'

/** Key suffixed with "?" is optional. */
type FieldSpec = Record<string, FieldType>

export type FailedStage =
  | 'face'
  | 'host'
  | 'search'
  | 'accept'
  | 'expand'
  | 'merkle'
  | 'attest'
  | 'verify'
  | 'unknown'

export interface Envelope {
  ts?: string
  seq?: number
  run_id?: string
}

type ClosedEvent =
  | {
      event: 'FaceDetected'
      backend: string
      det_score: number
      embedding_sha256: string
      gallery_size?: number
    }
  | { event: 'ImageHosted'; url: string; probe?: string; quality?: number }
  | { event: 'ImageSearchCompleted'; engine: string; hits: number; probe?: string }
  | { event: 'PostAccepted'; count: number; top_sim: number }
  | { event: 'MerkleBuilt'; root: string }
  | { event: 'Attesting'; root: string }
  | { event: 'Attested'; tx_hash: string; uid: string; easscan: string }
  | { event: 'Failed'; error: string; stage?: FailedStage }

type OpenOrReservedEvent = { event: OpenEventName | ReservedEventName; [key: string]: unknown }

export type EotwEvent = (ClosedEvent | OpenOrReservedEvent) & Envelope

export type EotwEventName = ClosedEventName | OpenEventName | ReservedEventName

const CLOSED_NAMES = [
  'FaceDetected',
  'ImageHosted',
  'ImageSearchCompleted',
  'PostAccepted',
  'MerkleBuilt',
  'Attesting',
  'Attested',
  'Failed',
] as const

const OPEN = [
  'GalleryBuilt',
  'ImageSearchRequested',
  'ImageSearchFailed',
  'SearchMerged',
  'AnchorLocked',
  'ExpandRequested',
  'ExpandCompleted',
  'ExpandSkipped',
  'GraphUpserted',
  'VerifyPassed',
  'NoMatchFound',
] as const

const RESERVED = ['CandidateScored', 'VerifyFailed', 'ConsentBound'] as const

type ClosedEventName = (typeof CLOSED_NAMES)[number]
type OpenEventName = (typeof OPEN)[number]
type ReservedEventName = (typeof RESERVED)[number]

const CLOSED: Record<ClosedEventName, FieldSpec> = {
  FaceDetected: {
    backend: 'string',
    det_score: 'number',
    embedding_sha256: 'string',
    'gallery_size?': 'number',
  },
  ImageHosted: { url: 'string', 'probe?': 'string', 'quality?': 'number' },
  ImageSearchCompleted: { engine: 'string', hits: 'number', 'probe?': 'string' },
  PostAccepted: { count: 'number', top_sim: 'number' },
  MerkleBuilt: { root: 'string' },
  Attesting: { root: 'string' },
  Attested: { tx_hash: 'string', uid: 'string', easscan: 'string' },
  Failed: { error: 'string', 'stage?': 'string' },
}

const ENVELOPE_KEYS: Record<string, FieldType> = {
  ts: 'string',
  seq: 'number',
  run_id: 'string',
}

const OPEN_SET = new Set<string>(OPEN)
const RESERVED_SET = new Set<string>(RESERVED)

export const VOCABULARY: EotwEventName[] = [
  ...(Object.keys(CLOSED) as ClosedEventName[]),
  ...OPEN,
  ...RESERVED,
]

const VOCAB_SET = new Set<string>(VOCABULARY)

export type EventTier = 'closed' | 'open' | 'reserved' | 'unknown'

export function classifyEvent(name: string): EventTier {
  if (name in CLOSED) return 'closed'
  if (OPEN_SET.has(name)) return 'open'
  if (RESERVED_SET.has(name)) return 'reserved'
  return 'unknown'
}

export function isKnownEvent(name: string): name is EotwEventName {
  return VOCAB_SET.has(name)
}

function isClosedName(name: string): name is ClosedEventName {
  return name in CLOSED
}

function typeOf(value: unknown): FieldType | 'null' | 'undefined' {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'undefined') return t
  if (t === 'object') return 'object'
  return 'object'
}

/**
 * Returns a list of problems. Empty list == valid.
 *
 * - non-object / missing `event` -> one problem
 * - unknown event name -> one problem ("unknown event ...")
 * - open / reserved events -> envelope type-checked, payload passes
 * - closed events -> required fields present & typed, no unexpected payload keys
 */
export function validateEvent(input: unknown): string[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return ['not a JSON object']
  }
  const obj = input as Record<string, unknown>

  const name = obj.event
  if (typeof name !== 'string') return ['missing string field "event"']
  if (!isKnownEvent(name)) return [`unknown event "${name}"`]

  const errors: string[] = []

  // Envelope keys: allowed anywhere, but flag a wrong type if present.
  for (const [key, expected] of Object.entries(ENVELOPE_KEYS)) {
    if (key in obj && obj[key] !== undefined) {
      const actual = typeOf(obj[key])
      if (actual !== expected) {
        errors.push(`${name}: envelope "${key}" should be ${expected}, got ${actual}`)
      }
    }
  }

  if (!isClosedName(name)) {
    // open / reserved: no payload constraints yet.
    return errors
  }

  const spec = CLOSED[name]
  const required: Record<string, FieldType> = {}
  const optional: Record<string, FieldType> = {}
  for (const [rawKey, ft] of Object.entries(spec)) {
    if (rawKey.endsWith('?')) optional[rawKey.slice(0, -1)] = ft
    else required[rawKey] = ft
  }

  const allowed = new Set<string>([
    'event',
    ...Object.keys(ENVELOPE_KEYS),
    ...Object.keys(required),
    ...Object.keys(optional),
  ])

  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) errors.push(`${name}: unexpected field "${key}"`)
  }
  for (const [field, expected] of Object.entries(required)) {
    if (!(field in obj)) {
      errors.push(`${name}: missing field "${field}"`)
      continue
    }
    const actual = typeOf(obj[field])
    if (actual !== expected) {
      errors.push(`${name}: field "${field}" should be ${expected}, got ${actual}`)
    }
  }
  for (const [field, expected] of Object.entries(optional)) {
    if (field in obj && obj[field] !== undefined) {
      const actual = typeOf(obj[field])
      if (actual !== expected) {
        errors.push(`${name}: field "${field}" should be ${expected}, got ${actual}`)
      }
    }
  }
  return errors
}

/**
 * Parse one JSONL line. Never throws on a well-formed unknown event — returns
 * it with `tier: "unknown"` so the terminal can flag it and the state machine
 * can no-op it. Throws only on invalid JSON.
 */
export function readEventLine(line: string): {
  raw: unknown
  event: EotwEvent | null
  tier: EventTier
  problems: string[]
} {
  const raw: unknown = JSON.parse(line)
  const problems = validateEvent(raw)
  const name =
    typeof raw === 'object' && raw !== null && typeof (raw as Record<string, unknown>).event === 'string'
      ? ((raw as Record<string, unknown>).event as string)
      : ''
  const tier = classifyEvent(name)
  const event = tier === 'unknown' || name === '' ? null : (raw as EotwEvent)
  return { raw, event, tier, problems }
}
