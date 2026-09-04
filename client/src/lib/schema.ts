/**
 * The event schema, verbatim from client/CLAUDE.md.
 *
 * This file is the single source of truth in code. If CLAUDE.md changes,
 * change this too — and `schema.test.ts` will fail until the fixtures agree.
 *
 * Hard rule (CLAUDE.md): do not add or remove fields. `validateEvent` rejects
 * unknown events, missing fields, and unexpected extra fields.
 */

export type EotwEvent =
  | { event: 'FaceDetected'; face_bbox: number[]; embedding_id: string; confidence: number }
  | { event: 'ImageHosted'; crop_url: string }
  | { event: 'ImageSearchCompleted'; engine: string; hit_count: number }
  | { event: 'CandidateScored'; url: string; face_sim: number; source_trust: number; decision: string }
  | { event: 'PostAccepted'; url: string; thumbnail: string; face_sim: number }
  | { event: 'NoMatchFound'; candidates_checked: number; reason: string }
  | { event: 'ConsentBound'; consent_hash: string }
  | { event: 'MerkleBuilt'; merkle_root: string; leaf_count: number }
  | { event: 'Attesting' }
  | { event: 'Attested'; tx_hash: string; attestation_uid: string; easscan_url: string }
  | { event: 'VerifyPassed'; matched: true }
  | { event: 'VerifyFailed'; matched: false; reason: string }
  | { event: 'Failed'; stage: string; error: string }

export type EotwEventName = EotwEvent['event']

type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object'

const SCHEMA: Record<EotwEventName, Record<string, FieldType>> = {
  FaceDetected: { face_bbox: 'array', embedding_id: 'string', confidence: 'number' },
  ImageHosted: { crop_url: 'string' },
  ImageSearchCompleted: { engine: 'string', hit_count: 'number' },
  CandidateScored: { url: 'string', face_sim: 'number', source_trust: 'number', decision: 'string' },
  PostAccepted: { url: 'string', thumbnail: 'string', face_sim: 'number' },
  NoMatchFound: { candidates_checked: 'number', reason: 'string' },
  ConsentBound: { consent_hash: 'string' },
  MerkleBuilt: { merkle_root: 'string', leaf_count: 'number' },
  Attesting: {},
  Attested: { tx_hash: 'string', attestation_uid: 'string', easscan_url: 'string' },
  VerifyPassed: { matched: 'boolean' },
  VerifyFailed: { matched: 'boolean', reason: 'string' },
  Failed: { stage: 'string', error: 'string' },
}

export const KNOWN_EVENTS = Object.keys(SCHEMA) as EotwEventName[]

export function isKnownEvent(name: string): name is EotwEventName {
  return name in SCHEMA
}

function typeOf(value: unknown): FieldType | 'null' | 'undefined' {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'object' || t === 'undefined') return t
  return 'object'
}

/** Returns a list of problems. Empty list == valid. */
export function validateEvent(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return ['not a JSON object']
  const obj = input as Record<string, unknown>

  const name = obj.event
  if (typeof name !== 'string') return ['missing string field "event"']
  if (!isKnownEvent(name)) return [`unknown event "${name}"`]

  const spec = SCHEMA[name]
  const errors: string[] = []
  const allowed = new Set(['event', ...Object.keys(spec)])

  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) errors.push(`${name}: unexpected field "${key}"`)
  }
  for (const [field, expected] of Object.entries(spec)) {
    if (!(field in obj)) {
      errors.push(`${name}: missing field "${field}"`)
      continue
    }
    const actual = typeOf(obj[field])
    if (actual !== expected) {
      errors.push(`${name}: field "${field}" should be ${expected}, got ${actual}`)
    }
  }
  return errors
}

/** Parse one JSONL line into a validated event, or throw with a useful message. */
export function parseEventLine(line: string): EotwEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new Error(`not valid JSON: ${line}`)
  }
  const problems = validateEvent(parsed)
  if (problems.length > 0) {
    throw new Error(`schema violation: ${problems.join('; ')}`)
  }
  return parsed as EotwEvent
}
