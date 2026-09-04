# Project: Eye of the Witch, UI side (Ryuk's task)

Split-screen ritual UI. Left: fantasy/video UI. Right: real terminal (xterm.js)
tailing a JSONL event stream from the backend pipeline.

## Hard rules
- Never invent pipeline steps. The terminal only displays events that exist
  in the event schema below, exactly as received.
- The scroll component renders zero content until an `Attested` event
  arrives. No placeholder or hardcoded tx hash, ever.
- `NoMatchFound` and `Failed` are different states with different UI
  outcomes. Do not merge them.

## Event schema (exact shape, do not add or remove fields)
FaceDetected      { face_bbox, embedding_id, confidence }
ImageHosted       { crop_url }
ImageSearchCompleted { engine, hit_count }
CandidateScored   { url, face_sim, source_trust, decision }
PostAccepted      { url, thumbnail, face_sim }
NoMatchFound      { candidates_checked, reason }
ConsentBound      { consent_hash }
MerkleBuilt       { merkle_root, leaf_count }
Attesting         { }
Attested          { tx_hash, attestation_uid, easscan_url }
VerifyPassed      { matched: true }
VerifyFailed      { matched: false, reason }
Failed            { stage, error }

## UI state machine (event -> left panel state)
FaceDetected -> photo lock/crop preview
ImageSearchCompleted -> concoction loop continues
PostAccepted -> append card to posts gallery (real thumbnail + url)
NoMatchFound -> cut to failure video, scroll never renders
Attesting -> chant/text-reveal animation starts
Attested -> success video, scroll unfurls with real tx_hash + easscan_url
Failed -> distinct error state, visually different from NoMatchFound

## Stack
- Split screen shell (left ritual UI, right xterm.js)
- Event source: tailing fixtures/*.jsonl during dev, real events.jsonl later
- No backend logic lives in this repo. This repo only consumes events.

### Concrete choices (decided 2026-09-04)
- React 18 + Vite + TypeScript.
- Terminal: `@xterm/xterm` + `@xterm/addon-fit`.
- Dev event feed: a Vite dev-server plugin (`vite-plugins/jsonl-sse.ts`) tails
  a JSONL file and pushes each line over Server-Sent Events at `/dev/events`.
  - `?fixture=success` | `?fixture=failure` selects a file under `fixtures/`.
  - `?interval=<ms>` paces replay (default 800ms). This pacing is a DEV
    convenience only; the real feed has irregular gaps (see build step 8).
  - Swapping to the real source = point the plugin at `runs/<run_id>/events.jsonl`
    and stop injecting the interval. The client code does not change.
- Event types + a runtime schema validator live in `src/lib/schema.ts`. The
  validator rejects unknown events and unexpected/missing fields, enforcing
  "do not add or remove fields". `src/lib/schema.test.ts` runs it over both
  fixtures.

## Dev commands (run inside client/)
- `npm install`      once
- `npm run dev`      Vite dev server, event feed included, http://localhost:5173
- `npm test`         vitest: fixture + schema checks
- `npm run build`    tsc type-check + vite production build

## Build order (one focused change per step; verify in localhost each time)
1. Split shell + terminal tailing the fixture, nothing else.            <- DONE
2. Left panel state machine wired to the same fixture stream
   (video/photo states switching on event type), no real videos yet,
   colored placeholder boxes labeled with the state name.
3. Drop in real AI-generated video clips, swap the placeholders.
4. Posts gallery, cards appending on `PostAccepted`.
5. Chant/text-reveal on `Attesting`.
6. Scroll component, hidden by default, only content is the real fixture's
   `tx_hash` and `easscan_url`. Verify it renders nothing before `Attested`.
7. Run the failure fixture through the same build: confirm `NoMatchFound`
   skips the scroll and cuts to the failure video. Do not assume it works
   because the success path does.
8. Wire the real event source: tail `runs/<run_id>/events.jsonl` instead of
   the static fixture.

## Verify-after-every-step checklist (do not trust "done")
- Does the scroll ever show content before `Attested`? (must be no)
- Does `NoMatchFound` ever trigger the success video? (must be no)
- Is the terminal printing anything not in the schema above? (must be no)
