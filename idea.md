# Face → Public Evidence Graph → Chain

## In one breath

Someone gives us a face photo. We don’t only ask “where does this image appear?”  
We run an **intelligent routing system** over the public web: grow a **person-evidence graph** (images, names, handles, posts, links between posts), expand only when a hop is worth it, then **notarize accepted evidence** (Merkle root on-chain) so anyone can re-verify later.

When the web changes — new post, edited post, new mirror — the graph updates under policy; the chain keeps immutable checkpoints.

**Product shape:** face in → discover public social/web evidence → verify over time.  
**Not a toy analogy:** the graph is the system of record for routing and evidence; search engines are adapters.

---

## Who this is for (real users)

| User | Job to be done |
|---|---|
| Journalist / researcher | “Where does this face appear in *public* posts and articles?” |
| Rights / brand / creator | “Where is this likeness used publicly?” |
| Individual (self-search) | “Where do *my* public photos show up?” |
| Compliance / trust team | “Freeze what we found at time T; re-check if posts changed.” |

**Hard product rule:** public / consented surfaces only. No private accounts, no DMs, no shadow dossier product. Policy is part of the pipeline, not a footnote.

---

## Is the graph the right core? (production answer)

**Yes — as the system of record for multi-hop discovery.**  
Real users don’t need one Lens screenshot. They need:

- many sources over time  
- paths (“found via handle X → post Y → quoted Z”)  
- dedupe across engines  
- refuse to crawl junk  
- re-run when content changes  

That *is* a property graph problem. A flat URL list cannot own routing state cleanly.

| Concern | Flat list / ad-hoc JSON | Real graph (e.g. Neo4j) |
|---|---|---|
| Handle → posts → quote → media | Manual joins, easy bugs | Native traversal |
| “Don’t expand from Rejected” | Easy to forget in code | No outbound from that label |
| Same post via Lens + handle | Duplicate rows | Merge on stable id / hash |
| Path explanation for users | Rebuild from logs | `shortestPath` / evidence path query |
| Temporal versions (edit/new post) | Painful | Version nodes + `SUPERSEDED_BY` |
| Multi-tenant runs over months | Files rot | First-class graph + indexes |

**Neo4j (or equivalent: Memgraph, Amazon Neptune)** is justified in production when routing depth > 1 and the graph lives across runs. Not bolted on for vocabulary — bolted *in* as the brain.

Search APIs, face models, queues = workers. **Graph = memory + router.**

---

## Shortlist note (slice, not the product)

The HH Goa brief is a **thin vertical slice** of this same system (face → ≥1 live social find → on-chain re-verify). Build the production architecture; the shortlist demo is one run path through it — not a separate dumbed-down app.

| Brief asks | Production system |
|---|---|
| Face detect + encode | Face service |
| Genuine web/social search | Adapter workers + graph routing |
| Hash + re-verify | Merkle service + attestations |
| Pipeline focus | Event-driven workers, CLI/API both fine |

---

## Exact flow (happy path)

```text
1. INPUT
   User drops a face image.

2. FACE
   Detect face → crop → embedding (vector).
   Emit: FaceDetected

3. SEARCH (live, not hardcoded)
   Fan out reverse-image on the face crop (and optionally full image):
   e.g. Google Lens + Bing (+ Yandex if available).
   Emit: ImageSearchCompleted (per engine)

4. FETCH + EXTRACT
   For each interesting hit URL, fetch the page/image when allowed.
   Pull public signals: other images, title/name, social handles, og:image.
   Emit: PageFetched, SignalsExtracted

5. GRAPH UPSERT
   Add nodes + edges with scores (see below).
   This is where “intelligence” lives — not in one API call.

6. SMART EXPAND (gated routing — not a crawl)
   Priority queue of hops scored in 5D (face × identity × source × linkage × novelty).
   Only then:
     trusted name → site-scoped social search
     trusted handle → public profile/posts
     post → linked/quoted post (same handle or clear social URL only)
   Parallel/async via events, but each hop must pass the gate.
   Dead ends: do not expand from Rejected nodes.
   Stop: budget, duplicates, or already have strong accept set.
   Emit: ExpandRequested / ExpandCompleted / ExpandSkipped
   New hits → fetch → score → graph (or drop).

7. ACCEPT
   Rank candidates (face distance + source trust + “is it a social post?”).
   Keep top post(s) — at least one if search returned anything usable.
   Face score ranks and explains; it should not wipe the only brief-valid hit.

8. MERKLE + CHAIN
   Build a Merkle tree over accepted leaves (and optional supporting edges).
   Put the Merkle root (+ run metadata) on-chain.
   Emit: Attested

9. VERIFY
   Later: re-fetch accepted URLs, rebuild leaves, recompute root,
   compare to on-chain root → pass/fail.
```

Event-driven here means a **clear event log** (JSONL is enough): parallel searches, safe expands, visible “why this post.” Not Kafka for a shortlist task.

---

## The graph (human picture)

Think of a notebook that fills itself:

- **Nodes:** FaceCrop · ImageHit · Name · Handle · Profile · Post · (optional Place/Org if public)
- **Edges:** same-image · same-face (score) · mentions-name · has-handle · appears-in · authored

**Example growth**

1. Face crop lands.  
2. Lens finds the same photo on a news page and an X CDN URL → `ImageHit` nodes.  
3. News page text + entity panel give a **Name** → edge `mentions-name` (high trust if face image is on that page).  
4. X URL path gives a **Handle** → `Profile` / `Post` nodes.  
5. Name expand finds another public post with a different photo → re-fetch → face score → new `Post` if it passes.  
6. Accepted posts become the set we notarize.

So we are not “only searching the face.” The face **opens the door**; name/handle (when earned) **walk the hallway** to more posts.

### Filters (how we use name / place without getting dumb)

| Signal | Use when | Don’t |
|---|---|---|
| Face score | Always rank/prune images | Treat as legal ID proof |
| Exact image match | Provenance / mirrors | Assume same person in a collage |
| Name | Backed by face-on-page or entity panel | Expand on a random string |
| Handle in URL | Clear profile/post path | Trust every `instagram.com` CDN junk equally |
| Address/city | Only if already on a public page, to disambiguate common names | Primary search / private lookup |

---

## Controlled growth — the graph must *not* grow for free

Bigger graph ≠ better pipeline. Uncontrolled crawl = noise, cost, and demo death.

**Default stance:** refuse to expand. Only grow when a route is predicted to find **new person images / posts** we don’t already have.

### Before any new node/edge, ask

1. Do we already have this URL / handle / content hash? → **dedupe, don’t grow**
2. Does this hop help the goal (find matching public posts/images of *this* face)? → if no, **skip**
3. Is trust high enough to spend an API/fetch? → if no, **park, don’t expand**
4. Is budget left (max hops, max fetches, max seconds)? → if no, **stop**
5. Would Merkle leaves get better (new accepted post), or only clutter? → clutter = **don’t add to accept set**

**Grow the working graph sparingly. Grow the Merkle accept set even more sparingly** (only notarized posts/evidence).

```text
seen URL? ──yes──► drop
    │ no
    ▼
route score high? ──no──► store as weak hint (optional) / ignore
    │ yes
    ▼
emit Expand / Fetch event
    ▼
face / trust check
    │
    ├─ pass → upsert + maybe accept
    └─ fail → mark Rejected, do NOT expand further from it
```

Dead ends stay dead: no expand from rejected nodes.

---

## 5D intelligent routing (how we decide where to walk next)

Every candidate hop gets a small score across five dimensions. Expand only if the combined route score clears a threshold *and* budget allows.

| Dimension | Meaning | High when… | Low / kill when… |
|---|---|---|---|
| **1. Face** | Is this about *our* person visually? | Embedding close to seed face | Lookalike, collage, no face |
| **2. Identity** | Did we earn name/handle legitimately? | Face + name on same page; clear profile URL | Random string; guessed name |
| **3. Source** | Where are we? | Official profile, known social post URL, press with byline | Random CDN, spam, login wall |
| **4. Linkage** | How did we get here? | Handle→post, post→quoted post, same image mirror | Random site: search with no face tie |
| **5. Novelty** | New evidence? | New post URL, new image hash, new handle | Duplicate mirror of same leaf |

**Route score (simple):**  
`face × identity × source × linkage × novelty` (or weighted sum).  
If any critical dim is ~0 (e.g. face fail on an image hop), **don’t route further from that node**.

This is “intelligent routing”: not BFS over the whole web — **priority queue of hops** ordered by route score.

---

## How routing finds the person around the web

Face search is only the **on-ramp**. After that we follow *earned* social and web links.

### Route A — Image → page → handle → posts → more images

```text
Face crop
  → reverse-image hit (photo on a page)
  → parse page for @handle / profile URL
  → open public profile
  → list public posts
  → for each post image: face-score
  → keep posts/images that match
  → (optional) from those posts, follow links (below)
```

Handles are the best router: one trusted `@user` unlocks many posts without another reverse-image call.

### Route B — Image → name → site-scoped search → posts

```text
Face on news/wiki page → trusted Name
  → search: "Name" site:x.com / linkedin.com / instagram.com
  → candidate posts/profiles
  → face-score images again
```

Only if **Identity** dim is high. Common names need Place/Org disambiguation or we skip.

### Route C — Post → linked post / quoted post / embedded media

People (and platforms) link outwards. We use that carefully:

| Link type | Do | Don’t |
|---|---|---|
| Quote / repost / “shared from” | Fetch parent if public; face-score media | Follow infinite quote chains |
| Post links another post by same handle | Prefer same-handle links (high linkage) | Treat every URL in text as equal |
| Post links external article with photo | Fetch if budget; score face on article image | Crawl whole article domain |
| Hashtags / explore pages | Skip for v1 | Easy noise factory |
| Outbound to unrelated sites | Skip unless face already confirmed on that URL | Open-web rabbit hole |

**Rule:** from a `Post`, only enqueue links that are (a) same handle, (b) clear social post URL, or (c) media URL — and always re-check **Face** before accepting.

### Route D — Same image, many homes (mirrors)

Same photo on X, news, blog:

```text
TinEye/Lens exact mirrors
  → many ImageHits, SAME_IMAGE edges
  → pick the ones that are real social posts for Accept/Merkle
  → other mirrors can stay as provenance edges (optional), not all need expand
```

Mirrors grow **edges**, not necessarily new expand routes.

### Route E — Stop conditions (anti-bloat)

Stop expanding when any is true:

- Already have **≥1 strong social post** and brief is satisfied (optional early stop for demo)
- **Max hops** (e.g. 1–2 expands) or **max fetches** hit
- Priority queue empty of high-score routes
- Same content_hash seen again (loop)
- Source is non-public / blocked

**Early stop is a feature.** Hackathon needs one real matching post, not a web archive.

---

## What actually gets stored vs notarized

| Layer | Grows when | Stays small because |
|---|---|---|
| **Seen set** | Every URL touched | Just ids/hashes, not full pages |
| **Graph** | Only nodes/edges that passed a minimum bar | Rejected paths not expanded; dupes merged |
| **Accept set** | Top posts (and thin support edges) | Hard cap (e.g. top 3–5) |
| **Merkle leaves** | Accept set only | Chain never sees the junk graph |
| **On-chain** | One root per run | Tiny |

So: intelligent routing can *look at* many links; the graph only **keeps** useful structure; Merkle only **freezes** the best finds.

---

## How the graph grows with time

The graph is **append-friendly**, but still **gated**. Each run is a snapshot; time makes it richer *only when new public evidence appears*.

| What happens in the world | What we do |
|---|---|
| New mirror of the same photo appears | New `ImageHit` / `SAME_IMAGE` edge |
| Person posts a new public photo | New reverse hit or name/handle expand → new `Post` |
| We discover a new handle from a page | New `Handle` → more posts next hop |
| User **edits** a post (text/image change) | Re-fetch → leaf hash changes → verify may **fail** against old root; new run grows graph + new root |
| Post deleted / 404 | Verify fails or marks leaf missing; graph can keep a “last seen” note off-chain |
| Stronger name confirmation later | Trust score on edges goes up; expands unlock |

**Mental model:**  
- **Graph** = living public map (local file / DB).  
- **Chain** = frozen checkpoints (“at time T, this Merkle root was the accepted evidence”).

So: graph grows continuously across runs; chain stores **immutable versions** of what we accepted.

```text
Run 1:  face → few posts → Merkle root R1 on-chain
Run 2:  same face (or same person seed) → more posts / changed post → root R2
        Graph now contains Run1 ∪ Run2 nodes; chain has R1 and R2 history
```

---

## Merkle mapping (simple and honest)

We don’t put the whole graph on-chain. We put a **root**.

### Leaves (what goes in the tree)

Each accepted (or supporting) item becomes a leaf hash, for example:

```text
leaf = hash(
  type +          # "post" | "image" | "edge"
  url +
  content_hash +  # hash of fetched image bytes or post text
  face_distance + # optional, for posts/images we scored
  engine +        # which search found it
  observed_at
)
```

Optional: include key **supporting edges** as leaves too (e.g. `Post —appears_in— FaceCrop` with score), so the root commits to *why* we accepted, not only the URL list.

### Tree → chain

```text
leaves → Merkle tree → merkle_root
on-chain record: { merkle_root, run_id, timestamp, input_face_fingerprint? }
```

### Verify

1. Read `merkle_root` from chain.  
2. Re-fetch each leaf’s URL (or use saved content if policy says so).  
3. Recompute each leaf; rebuild root.  
4. Match → OK. Mismatch → something changed (edited post, wrong URL, tampering).

### If the user changes the post

- **Old root:** verify fails (content_hash no longer matches) → tamper-evident, which is what the brief wants.  
- **New run:** new leaf for new content → graph gains a new versioned node (`Post@t2`) → new Merkle root R2 on-chain.  
- Graph can link `Post@t1 → SUPERSEDED_BY → Post@t2` so growth over time is visible.

That’s the map: **posts/versions = leaves; accepted set = tree; checkpoint = root on-chain; edits = failed verify + graph growth + new root.**

---

## Pipeline flow (cleaner diagram)

```text
                    ┌─────────────────┐
                    │  Face image in  │
                    └────────┬────────┘
                             ▼
                    ┌─────────────────┐
                    │ Detect + encode │
                    └────────┬────────┘
                             ▼
              ┌──────────────────────────┐
              │ Event: search fan-out    │
              │ (multi-engine, live)     │
              └────────────┬─────────────┘
                             ▼
              ┌──────────────────────────┐
              │ Fetch pages / images     │
              │ Extract name, handle,…   │
              └────────────┬─────────────┘
                             ▼
              ┌──────────────────────────┐
         ┌───►│   Person evidence graph  │◄──┐
         │    │   (nodes, edges, scores) │   │
         │    └────────────┬─────────────┘   │
         │                 ▼                 │
         │    ┌──────────────────────────┐   │
         │    │ 5D route score + budget  │   │
         │    │ expand / skip / stop     │   │
         │    └────────────┬─────────────┘   │
         │         expand  ▼                 │
         │    ┌──────────────────────────┐   │
         └────│ handle / name / post→post│───┘
              └────────────┬─────────────┘
                             ▼
              ┌──────────────────────────┐
              │ Accept top social posts  │
              │ (rank by face + trust)   │
              └────────────┬─────────────┘
                             ▼
              ┌──────────────────────────┐
              │ Merkle(leaves) → root    │
              │ Attest root on-chain     │
              └────────────┬─────────────┘
                             ▼
              ┌──────────────────────────┐
              │ verify: rebuild + compare│
              └──────────────────────────┘
```

---

## Production architecture (build for real users)

### Core principle

```text
Adapters discover.  Queue fans out.  Policy scores.  Graph remembers + routes.
Merkle freezes.  Chain notarizes.  Verify re-checks the world.
```

The graph is not a slide analogy. It is the **router and memory**. Neo4j (or Memgraph/Neptune) earns its place once hops, time, and path queries matter for users.

### Services

| Service | Job |
|---|---|
| **Face service** | Detect, crop, embed; stable `face_fingerprint` |
| **Search adapters** | Lens, Bing, Yandex, optional face-search APIs — parallel |
| **Fetch / extract workers** | Page + media fetch; OCR/title/handle/og:image extraction |
| **Policy / 5D scorer** | Face × identity × source × linkage × novelty; expand vs skip |
| **Graph DB (Neo4j)** | Nodes/edges, merge, reject-no-expand, path queries, temporal versions |
| **Router / expander** | Priority queue of hops from graph; emits only gated expands |
| **Event bus** | NATS/Kafka/SQS — `FaceDetected`, `SearchCompleted`, `ExpandSkipped`, … |
| **Merkle + attest** | Leaves from accept set → root → EAS/chain |
| **Verify worker** | Re-fetch, rebuild root, compare on-chain; emit drift events |
| **API / CLI** | `investigate`, `verify`, `explain path` for users |

### Event-driven (production, not costume)

Parallelism is required at user scale:

- N engines search at once  
- M URLs fetch at once  
- Expands enqueue only after 5D gate  
- One engine/outage must not kill the run  
- Full event log = audit trail for compliance users  

Use a real queue. Workers are idempotent on `(run_id, url_hash)`.

### Neo4j model (sketch)

**Nodes:** `FaceSeed`, `Image`, `Page`, `PersonName`, `Handle`, `Profile`, `Post`, `Run`, `AcceptSet`  
**Rels:** `FOUND_VIA`, `SAME_IMAGE`, `SAME_FACE`, `MENTIONS`, `HAS_HANDLE`, `AUTHORED`, `APPEARS_IN`, `QUOTES`, `LINKS_TO`, `SUPERSEDED_BY`, `REJECTED_FROM`, `ACCEPTED_IN`

**Queries users actually need:**

- Evidence path: face → … → post  
- All posts for handle with face score ≥ τ  
- What changed since run R1 (new posts, superseded content)  
- Expand frontier: high-score neighbors not yet fetched  

### Intelligent routing (production behavior)

1. Seed face → parallel reverse-image  
2. Upsert hits; merge on content hash / canonical URL  
3. Extract handles/names; **only high-identity** ones become expand roots  
4. Handle → public posts → media face-score  
5. Post → `QUOTES` / same-handle `LINKS_TO` / media URLs (narrow)  
6. Name → site-scoped search when disambiguated  
7. Continuous: re-verify schedule; on drift → new version nodes + optional new Merkle root  
8. Budgets per tenant: max fetches, max depth, max $ API, public-only policy pack  

**Grow only for signal.** Rejected nodes have no outbound expand. Duplicates merge. Accept set ≠ whole graph.

### Graph vs Merkle vs chain (clear jobs)

| Store | Holds | User value |
|---|---|---|
| Neo4j | Full evidence + routing state over time | Find, explain, grow carefully |
| Object/blob store | Fetched bytes, embeddings | Recompute faces/hashes |
| Merkle root on-chain | Checkpoint of *accepted* evidence | Tamper-evident audit |
| Off-chain leaf manifest | Leaf list for that root | Anyone can rebuild verify |

Edits: verify fails on old root → graph `SUPERSEDED_BY` → new accept set → new root. Users see **history**, not a silent overwrite.

### Privacy & product ethics (non-optional)

- Public / robots / ToS-respecting adapters  
- Modes: `self`, `consenting_subject`, `public_figure_research`  
- Retention limits; delete subject → purge graph partition  
- Never market as “secret social stalking”  
- README/product copy: similarity evidence, not legal identity proof  

### What “best pipeline” means

Not most APIs. **Best = highest useful public recall per dollar, with explainable paths, controlled growth, and verifiable checkpoints.**

---

## Delivery slices (product roadmap, not panic cuts)

**Slice A — vertical truth**  
Face → multi-engine → graph upsert → ≥1 social post → Merkle attest → verify  

**Slice B — routing brain**  
Neo4j + 5D policy + handle→posts + ExpandSkipped audit  

**Slice C — link intelligence**  
Post→quote/post links, mirrors as `SAME_IMAGE`, path explain API  

**Slice D — time**  
Scheduled re-verify, `SUPERSEDED_BY`, multi-root history  

Shortlist demo can be Slice A+B. Production users need C+D.

---

## Pitch line

> We resolve public evidence around a face through a gated graph router — handles, posts, and links — and notarize accepted findings as Merkle checkpoints so the record stays honest as the web changes.
