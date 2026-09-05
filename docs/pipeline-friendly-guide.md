# Eye of the Witch — how the pipeline works (friendly guide)

Think of this as one long detective story.

You hand us a **face photo** (or a few photos from different angles).  
We **look for that same face on the public web**, pick the best matching posts,  
**draw a map of what we found**, then **stamp a fingerprint of those posts on the blockchain** and **check that stamp again**.

That’s the whole brief:

> Face scan → Web/social search → Blockchain upload / verification

---

## The cast of characters

| Name | Role (in plain English) |
|---|---|
| **Seed face** | The photo(s) *you* gave us — the “true” person we’re hunting |
| **imgbb** | Temporary public hosting so search engines can *see* the face crop |
| **SerpAPI** | Our door into Google Lens / Yandex / Google Reverse Image |
| **InsightFace** | The brain that turns a face into numbers (an embedding) and compares faces |
| **Evidence graph** | A notebook/map of “seed → hits → accepted posts → maybe an anchor” |
| **Merkle root** | One fingerprint that commits to the **whole check** (probe + verdicts + accepts) |
| **EAS on Sepolia** | Ethereum Attestation Service on the Sepolia testnet — where we store that fingerprint |
| **Re-verify** | Rebuild the fingerprint locally and check it still matches the chain |

---

## Act 1 — Face scan

**What you do:** drop one or more photos in the UI (or run the CLI).

**What we do:**

1. **Detect the face** in each photo (InsightFace `buffalo_s`).
2. **Encode** it into a 512-number vector — the “face fingerprint.”
3. If you gave **several photos**, we build a **seed gallery**: keep faces that look like the same person, score quality (sharpness + detection confidence), and pick the best 1–2 crops as **probes** for search (deep-opt / coreset).
4. We emit events like `FaceDetected` and `GalleryBuilt` so the right-hand terminal can narrate this live.

**Why multiple photos help:** one blurry selfie is a weak clue. Front + side + better light gives the hunter more angles of *you*, so ranking against web thumbnails is steadier.

**Human metaphor:** we’re not storing “your identity papers.” We’re taking a clear mugshot of the person to look for, then comparing *that* mugshot to faces on public pages.

---

## Act 2 — Host the crop (the boring but necessary step)

Search engines don’t accept a file from your laptop.

So we:

1. Upload the face crop(s) to **imgbb**.
2. Get a public HTTPS URL like `https://i.ibb.co/.../face-crop.jpg`.
3. Emit `ImageHosted`.

**Why:** Google Lens / Yandex need a URL they can download. Hosting is the bridge from “local image” → “searchable image.” It’s temporary glue for the demo, not the point of the project.

---

## Act 3 — Web / social search (the real hunt)

We ask several engines, live (not hardcoded):

- Google Lens  
- Yandex Images  
- Google Reverse Image  

Each returns candidate pages / thumbnails. We:

1. Merge and **dedupe by URL** (`SearchMerged`).
2. Download thumbnails where we can.
3. Run **face similarity** of each thumbnail against your **seed** (gallery-aware / quality-weighted when deep-opt is on).
4. **Adjudicate** with bands that change the decision (search only proposes; the encoder decides):
   - `sim ≥ 0.25` → **accept**
   - `0.20 ≤ sim < 0.25` → **abstain** (gray band — not sealed as a match)
   - `sim < 0.20` → **reject**
   - near-exact image but weak face vs seed → **reject** (poison rule)
5. Emit `AdjudicationCompleted` (counts + τ), then keep accepts as **accepted posts** (`PostAccepted`).
6. Prefer social URLs when scores are close, but **seed face always wins** over “the search engine said this looks similar.”

**Human metaphor:** we reverse-image-search the mugshot, then the face model **votes** each candidate — accept, abstain, or reject — not just Lens’s gut feel.

### Anti-poison (important)

If Lens says “same photo” but the *face in that photo* doesn’t match your seed, we **do not** trust that page as your identity.  
Exact image match alone never gets to drive the rest of the hunt. That stops a wrong profile from poisoning everything downstream.

### Anchor (optional gate)

If we find something that is **near-exact image** *and* **strong face match to seed**, we lock an **`AnchorLocked`**.  
Only then may we do a careful “expand” hop (e.g. follow a handle / name).  
No dual-confirm? Expand is skipped — better fewer posts than a wrong identity tree.

---

## Act 4 — Evidence graph (the map of the investigation)

This is NetworkX writing `graph.json`. It’s not the blockchain. It’s our **crime board**.

### How nodes get added

```text
                    ┌─────────────┐
                    │  FaceSeed   │  ← your scan
                    └──────┬──────┘
           ┌───────────────┼───────────────┐
           │               │               │
           ▼               ▼               ▼
      ImageHit        ImageHit  …     ImageHit
   (every search URL)
           │
           ▼
         Handle          (if we can parse @user / profile)
           
      …after ranking…

           ▼
         Post            ← accepted, face-matched posts
           │
           ▼
        Anchor           ← only if dual-confirm locked
           │
           ▼
      ExpandHit          ← optional gated hop results
```

| Node kind | Meaning |
|---|---|
| **FaceSeed** | You / the gallery seed |
| **ImageHit** | A URL the reverse search returned |
| **Handle** | A social handle we extracted from a URL |
| **Post** | An accepted matching post (used later for Merkle) |
| **Anchor** | Dual-confirmed identity lock |
| **ExpandHit** | Extra pages from a gated expand |

Edges are labeled things like `FOUND_VIA`, `ACCEPTED_IN`, `LOCKED_AS_ANCHOR` — so later you can open `graph.json` and *see* the story, not just a flat list of URLs.

**Human metaphor:** seed in the center, sticky notes for every web hit, gold stars for accepted posts, a red pin if we locked an anchor. That’s “intelligent search” memory for the run.

When this is written we emit `GraphUpserted` (node/edge counts). The UI can also summarize: *seed → hits → accepted → anchor/handles*.

---

## Act 5 — Blockchain fingerprint + re-verify

We don’t upload your face to the chain. We upload a **commitment to the whole check**: what we searched with, how we voted each candidate, and what we accepted.

### 5a. Merkle tree (adjudication evidence bundle)

Leaves include:

1. **Probe** — seed embedding fingerprint + gallery size  
2. **Verdicts** — per scored candidate: url, content hash, sim, `accept|abstain|reject`  
3. **Accepts** — posts that cleared accept (what the UI gallery shows)

Those leaves go into a **Merkle tree**. The top hash is the **Merkle root** — one 32-byte fingerprint for the whole adjudication.  
Change a verdict or an accept → root changes. Emit `MerkleBuilt` with `mode=adjudication_bundle`.  
Artifacts: `evidence.json` + `merkle.json`.

### 5b. Attest on EAS (Sepolia)

We send a transaction to **EAS** on Ethereum **Sepolia** attesting:

> “This `contentHash` (the Merkle root) was observed.”

You get:

- `tx_hash` — the transaction  
- `uid` — the attestation id  
- `easscan` — a link to view it  

Emit `Attesting` → `Attested`.

### 5c. Re-verify

We:

1. Rebuild the Merkle root from `accepted.json` locally.  
2. Read the attestation back from the chain.  
3. Check local root == on-chain `contentHash`.  
4. Optionally poke a tamper check (change a leaf → roots diverge).

If all good → `VerifyPassed`.

**Human metaphor:** we put a sealed envelope summary of “these public posts matched this face hunt” on a public bulletin board (Sepolia). Anyone can open the envelope recipe and check the seal still matches.

---

## End-to-end in one breath

1. **You give a face** (maybe several angles).  
2. We **detect & encode** it → seed gallery.  
3. We **host** the crop so search engines can fetch it.  
4. We **live reverse-search** the web → many candidate URLs.  
5. We **compare faces to the seed**, keep the best → accepted posts.  
6. We optionally **lock an anchor** (exact image + face agree).  
7. We **draw the evidence graph** (seed → hits → posts → anchor…).  
8. We **Merkle-hash** the accepted posts and **attest** that root on **EAS Sepolia**.  
9. We **re-verify** local rebuild vs on-chain record.

The left UI is the ritual. The **right terminal** is the live lab notebook of that story, stage by stage.

---

## What is / isn’t the point

| Is the point | Isn’t the point |
|---|---|
| Real face encode | Perfect legal identity proof |
| Real live web search | Hardcoded demo URLs |
| Real on-chain attest + re-verify | Hosting forever on imgbb |
| Evidence graph for the run | A production social scraper |
| Publicly indexed content | Private / non-consensual stalking |

---

## Where the files live after a run

Under `runs/full-<id>/` (or `backend/runs/…` via symlink):

| File | What it is |
|---|---|
| `events.jsonl` | Live story the UI tails |
| `accepted.json` | Matching posts that went into Merkle |
| `graph.json` | Evidence map (NetworkX) |
| `anchor.json` | Dual-confirm lock (or locked: false) |
| `merkle.json` | Root + leaves |
| `attest.json` | Tx / UID / explorer link |
| `verify.json` | Re-verify result |

---

## One-line cheat sheet

**Scan the face → show it to the public web → keep posts that match the seed → map the evidence → fingerprint those posts on Sepolia → prove the fingerprint still matches.**

That’s the pipeline.
