# Handoff for Ryuk — Face → Truth Pipeline UI

Hey Ryuk — short version of what we’re building, what you own, and how it should feel.

---

## What this product is (one breath)

User drops a **face photo**.  
A real pipeline runs: **find that face on the public web/social → freeze what we found as a hash on Ethereum (Sepolia) → prove we can re-check it**.

Your job is **not** the Python search/chain guts.  
Your job is the **stage** judges watch: split screen, fantasy framing, live terminal, magic when the tx lands.

---

## The experience (what judges should feel)

Think: **ritual / witch-lab / destiny scroll** — not a SaaS dashboard.

1. User places a photo into the left (UI) side.  
2. Pipeline starts → concoction / brewing energy (video + motion).  
3. Right side terminal shows **real steps** as they happen (face found → searching → posts → merkle → chain).  
4. When the Ethereum tx is going out → **magic chant / text-reveal** (“destiny being written…”).  
5. Success → witch-magic video, posts appear on screen, then a **scroll / parchment** reveals:

> **The destiny has been embedded and the truth has been found.**  
> *(tx hash / attestation underneath, copyable)*

All copy stays fantasy. All **proof** (hashes, links, steps) stays real.

---

## Layout: split screen

```text
┌─────────────────────────────┬──────────────────────────────┐
│  LEFT — Ritual UI           │  RIGHT — Live terminal       │
│                             │                              │
│  • Drop / capture photo     │  • Real pipeline logs        │
│  • Story / video layers     │  • Step formatting           │
│  • Posts found gallery      │  • Judges see it’s not fake  │
│  • Scroll + tx reveal       │                              │
└─────────────────────────────┴──────────────────────────────┘
```

- **Left** = emotion + story + results.  
- **Right** = trust + “this actually ran.”  
Neither side is optional for the demo.

---

## Your side in detail

### Left — UI / fantasy flow

| Moment | What happens |
|---|---|
| Idle | Soft scene; drop zone for face photo |
| Photo locked | Preview crop / “subject bound” |
| Pipeline running | **Concoction** video / looping brew animation |
| Searching web | Optional vignette; don’t block terminal |
| Posts found | Cards / portals with real post URLs + thumbs |
| Tx submitting | **Chant / text-reveal** (letter by letter or rune fade-in) |
| Success | Witch-magic success video → scroll opens |
| Scroll | Fantasy sentence + **real** tx hash / EAS link underneath |

Tone examples (feel free to rewrite, keep the vibe):

- Running: *“The cauldron reads the face… the web answers…”*  
- Tx: *“Sealing the truth into the chain of fate…”*  
- Done: *“The destiny has been embedded and the truth has been found.”*  
  → then the hash

### Right — terminal

Use a real terminal UI embed so logs look native (not a fake fake console).

Good options:

- **Web / Electron:** [`xterm.js`](https://xtermjs.org/) (best for “real terminal in the app”)  
- **React terminal look:** something on top of xterm, or a styled log stream if you must  

Show **structured steps**, e.g.:

```text
[1/6] FACE     · InsightFace encode ✓
[2/6] HOST     · crop published ✓
[3/6] SEARCH   · Google Lens · 60 hits ✓
[4/6] ACCEPT   · 3 social posts ✓
[5/6] MERKLE   · root e17c0e00… ✓
[6/6] CHAIN    · Sepolia tx ba4744… ✓
VERIFY         · on-chain match ✓
```

Timestamps + colors help judges. **Do not invent steps** — only mirror what the pipeline emits.

---

## How UI ↔ pipeline talk (contract with backend)

Pipeline already (and will keep) writing run artifacts + step events.

**Simplest solid path for demo:**

1. UI starts pipeline process (or calls a local runner).  
2. Pipeline streams **JSON lines** (one event per step) to stdout **or** appends `runs/<id>/events.jsonl`.  
3. UI tails that stream → updates terminal + triggers videos.

Example events (names can match these):

```text
FaceDetected | ImageHosted | ImageSearchCompleted | PostAccepted
MerkleBuilt | Attesting | Attested | VerifyPassed | Failed
```

When `Attesting` → start chant animation.  
When `Attested` → success video + scroll with `tx_hash` / `easscan` URL.  
When `PostAccepted` → show that post in the gallery.

**Rule:** fantasy is the skin; events are the bones.

---

## What already works (backend smoke — don’t redo)

End-to-end smoke already passed once:

- Live SerpAPI Google Lens  
- Merkle root  
- EAS attestation on Sepolia  
- Re-verify vs on-chain hash  

Repo bits you’ll care about:

- `smoke_e2e.py` — current E2E runner  
- `runs/<run_id>/` — artifacts (accepted posts, merkle, attest, verify)  
- `architecture.md` / `idea.md` — full product brain  

Keys live in `.env` (never commit). Face encode target = **InsightFace** (proper); OpenCV was only a disk emergency fallback.

---

## What Kaushal owns vs what you own

| Kaushal (pipeline) | Ryuk (experience) |
|---|---|
| InsightFace encode | Split-screen shell |
| SerpAPI / imgbb / EAS | Terminal embed + log formatting |
| Graph / merkle / verify | Fantasy videos + chant + scroll |
| Event stream / CLI | Photo drop UI + posts gallery |
| README / recording of truth | Making judges *feel* it |

Meet in the middle on: **event names + payload fields** (`tx_hash`, `posts[]`, `merkle_root`, `run_id`).

---

## Suggested build order for you

1. Empty split shell (left panel + right xterm).  
2. Fake event playback (so you can animate without waiting on chain).  
3. Wire real `smoke_e2e` / CLI stream.  
4. Photo drop → kicks real run.  
5. Concoction / success videos.  
6. Chant + scroll on `Attested`.  
7. Polish timing so terminal + video don’t fight.

---

## Assets you’ll want

- Concoction / brew loop (pipeline running)  
- Witch-magic success clip  
- Optional ambient loop for idle  
- Scroll / parchment frame for the hash reveal  
- Sound optional — keep short for recording  

Keep files local in something like `ui/public/media/`.

---

## Side note (your shell branch)

If you’re working from the channel-settings shell:

```bash
git checkout feat/channel-settings-shell
# restart app
```

Use that branch as the **app shell** if it already has layout primitives; otherwise start a clean split view in this repo’s `ui/` folder. Don’t block on perfect routing — demo needs one full-screen ritual page.

---

## Success check (you’re done when…)

- [ ] Judge sees photo go in  
- [ ] Terminal shows live steps (not a pre-written wall of text)  
- [ ] Concoction plays while pipeline runs  
- [ ] Real social post(s) appear on success  
- [ ] Chant plays as tx is submitted  
- [ ] Scroll shows fantasy line + **real** tx/attestation link  
- [ ] Whole thing recordable in one take  

---

## One-line brief for you

> Build a split-screen ritual: left side fantasy UI (photo → concoction → magic → posts → destiny scroll with the Ethereum hash), right side a real terminal streaming the pipeline — so judges feel a game and still trust the tech.

Ping Kaushal for event schema / sample `runs/` JSON if you need a fixture before InsightFace E2E on his face image is locked.
