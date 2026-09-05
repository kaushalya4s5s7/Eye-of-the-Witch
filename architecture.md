# Architecture — Face Evidence Pipeline (Hackathon slice)

Designed for HH Goa Task 3: **face → live web/social find → on-chain verify**.  
Standards-clean (ports/adapters, event bus, gated graph), free-tier first, **scale-ready without building scale now**.

---

## 1. Requirements → design drivers

| Requirement | Design driver |
|---|---|
| Detect + encode face | Local face adapter (no paid face API) |
| Genuine web/social search | Live SerpAPI Google Lens (not fixtures in demo path) |
| ≥1 matching social post | Rank + filter; accept top social URL(s) |
| Hash/fingerprint on chain + re-verify | Merkle over accepted leaves → EAS Sepolia |
| Pipeline focus, no website | Python CLI |
| Creative but on-brief | Light evidence graph + async search fan-out |
| Free / cheap | Free SerpAPI + local models + Sepolia faucet |
| Scalable *later* | Interfaces: swap NetworkX→Neo4j, asyncio→Redis later |

**Out of scope for this slice:** Kafka, multi-tenant SaaS, scheduled crawlers, paid face-search APIs.

---

## 2. Research summary — free stack choices

### Face identification (free, local)

| Option | Cost | Notes | Choice |
|---|---|---|---|
| **InsightFace** (`buffalo_s` / `buffalo_l`) + onnxruntime | Free | Strong embeddings; pretrained models = research/non-commercial → OK for hackathon | **Primary** |
| DeepFace | Free | Heavier wrapper, many backends | Fallback |
| `face_recognition` (dlib) | Free | Simpler, weaker | Fallback |

### Web / reverse-image search (free plans)

| Option | Free tier | Notes | Choice |
|---|---|---|---|
| **SerpAPI `google_lens`** | **250 searches/mo** | Real live Lens; needs public image URL or upload | **Primary** |
| SerpAPI other engines | Same credit pool | Optional 2nd engine if credits allow | Optional |
| Bing Visual Search Azure | **Retired Aug 2025** | Do not depend on it | Avoid |
| Bright Data / others | Free trials vary | Extra signup friction | Later |
| Hardcoded URLs | $0 | **Fails brief** | Forbidden in demo path |

**Image host (Lens needs a URL):** free **imgbb** / **Catbox** / temporary public file — upload face crop, pass URL to SerpAPI, delete after run if possible.

### Graph

| Option | Free | Role now | Later |
|---|---|---|---|
| **NetworkX + JSON/SQLite** | Yes | In-process evidence graph | Keep for unit tests |
| **Neo4j Aura Free** | 50k nodes / 175k rels | Optional if time | Drop-in behind `GraphStore` |

### Blockchain

| Option | Cost | Choice |
|---|---|---|
| **EAS on Ethereum Sepolia** | Gas = free test ETH | **Primary** — purpose-built attestations |
| Alchemy / public Sepolia RPC | Free tier | Provider |
| Sepolia faucet | Free | Alchemy / QuickNode / others |
| Local Anvil + mock | Free | Dev-only fallback if faucet blocked |
| Raw `keccak` to random contract | Free | Weaker story than EAS |

**Schema (register once on Sepolia or reuse contentHash-style):**  
`bytes32 merkleRoot, string runId, string primaryPostUrl, uint256 acceptedCount`

### Orchestration

| Option | Now | Later |
|---|---|---|
| **asyncio + in-process EventBus** | Parallel Lens + fetches | — |
| Redis / NATS / Kafka | — | Same event names, different transport |

---

## 3. Target architecture (clean, not tiny, not hyperscale)

```text
                    ┌─────────────────────────────────────────┐
                    │              CLI (Typer)                │
                    │   run | verify | explain | smoke        │
                    └──────────────────┬──────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────────┐
                    │           Pipeline Orchestrator         │
                    │     (subscribes to EventBus; stages)    │
                    └─┬─────────┬─────────┬─────────┬─────────┘
                      │         │         │         │
           ┌──────────▼──┐ ┌────▼────┐ ┌──▼───┐ ┌──▼────────┐
           │ FacePort    │ │SearchPort│ │Graph │ │ AttestPort│
           │ InsightFace │ │ SerpAPI  │ │Store │ │ EAS Sepolia│
           └─────────────┘ └────┬────┘ └──▲───┘ └───────────┘
                                │         │
                         ┌──────▼──┐  NetworkX
                         │ HostPort│  (Neo4j later)
                         │ imgbb   │
                         └─────────┘

           EventBus (in-process) ── JSONL audit log under ./runs/<id>/
```

### Ports (interfaces) — this is the “can scale later” part

```text
FacePort.encode(image) -> FaceSeed { embedding, crop_path, bbox }
ImageHostPort.upload(path) -> public_url
SearchPort.reverse_image(url) -> list[SearchHit]
FetchPort.fetch(url) -> PageSnapshot { html_or_meta, image_bytes? }
GraphStore.upsert_node/edge | neighbors | merge_by_hash
Policy.score(hit, seed) -> RouteScore   # 5D lite
MerkleBuilder.build(leaves) -> root + proofs
AttestPort.attest(root, meta) -> { uid, tx }
AttestPort.get(uid) -> onchain_record
```

Swap implementations without rewriting the orchestrator.

### Packages (repo layout)

```text
src/
  ports/           # protocols / ABCs
  adapters/
    face_insightface.py
    search_serpapi.py
    host_imgbb.py
    graph_networkx.py
    graph_neo4j.py     # stub or optional
    chain_eas_sepolia.py
  domain/
    models.py          # FaceSeed, SearchHit, Post, Edge, Run
    policy.py          # 5D scoring + social domain filter
    merkle.py
  app/
    events.py          # EventBus + event types
    orchestrator.py    # end-to-end run
    verify.py
  cli.py
runs/<run_id>/         # events.jsonl, graph.json, leaves.json, result.json
```

---

## 4. End-to-end smoke flow (what “works” means)

### Happy path (recording script)

```text
0. Prep
   - SERPAPI_API_KEY, IMGBB_API_KEY (or free host)
   - SEPOLIA_RPC_URL, PRIVATE_KEY with faucet ETH
   - Sample: public-figure image OR your own public photo

1. FACE
   CLI: facepipe run ./samples/person.jpg
   → FaceDetected { run_id, embedding_hash, crop }
   Fail smoke if: no face detected

2. HOST
   → Upload crop → public URL
   → ImageHosted { url }
   Fail smoke if: upload fails (Lens needs URL)

3. SEARCH (live, parallel-ready)
   → ImageSearchRequested
   → SerpAPI engine=google_lens
   → ImageSearchCompleted { hits: title, link, source, thumbnail }
   Fail smoke if: 0 hits OR response from fixture file in demo mode
   Pass evidence: log raw serp request id / save response JSON in runs/

4. FILTER + GRAPH
   → Prefer social domains (x.com, twitter.com, instagram.com, linkedin.com, facebook.com, tiktok.com…)
   → Upsert ImageHit / Page / Post candidates
   → Optional: extract handle from URL path → Handle node
   → Optional one expand: if handle earned, list is stretch; min path = best social hit from Lens
   → Score with face when image re-fetched; else rank by domain + exact/visual match signals
   Fail soft: if no social domain, accept best news/web hit that clearly shows the person
     (brief wants social; try harder for social first)

5. ACCEPT
   → ≥1 PostAccepted { url, content_hash, score, engines }
   → Write leaves.json

6. MERKLE + ATTEST
   → merkle_root = Merkle(leaves)
   → EAS.attest(merkleRoot, runId, primaryPostUrl, count)
   → Attested { uid, tx_hash, easscan_url }
   Fail smoke if: tx not mined

7. VERIFY
   CLI: facepipe verify <uid>
   → Load on-chain attestation
   → Re-fetch primary post image / recompute leaf hashes where possible
   → Rebuild merkle root
   → PASS if roots match (or documented partial verify if social CDN blocks re-fetch —
     then verify hash of saved bytes + url from run artifact vs on-chain root)
   Fail smoke if: verify always returns true without reading chain
```

### Failure path smoke (proves honesty)

```text
A. Never-posted selfie (optional) → expect 0 social accepts or weak hits; no fake celebrity URLs
B. Bad SERPAPI key → fail closed, no attest
C. After attest, tamper leaves.json or point verify at wrong bytes → FAIL
```

---

## 5. Event model (async without Kafka)

```text
FaceDetected
ImageHosted
ImageSearchRequested      # can fan-out N engines later
ImageSearchCompleted
PageFetched               # optional
GraphUpserted
ExpandSkipped | ExpandCompleted   # show gated growth
PostAccepted
MerkleBuilt
Attested
VerifyPassed | VerifyFailed
```

**Now:** `asyncio.gather` for multi-engine when you add a second.  
**EventBus:** publish each event → append `runs/<id>/events.jsonl` (demo gold).  
**Later:** same event names on Redis Streams.

---

## 6. Graph (lean now, Neo4j later)

**Hackathon store:** NetworkX DiGraph persisted to `graph.json`.

**Nodes:** `FaceSeed`, `ImageHit`, `Post`, `Handle` (optional)  
**Edges:** `FOUND_VIA`, `SAME_FACE?`, `HAS_HANDLE`, `ACCEPTED_IN`

**Growth rules for this slice:**
- Dedupe by canonical URL / content hash  
- Do not expand from rejected  
- Max 1 expand hop (handle) if time  
- Accept set ≤ 3 leaves for Merkle  

**Interface:** `GraphStore` — implement NetworkX first; Neo4j Aura Free second when routing depth grows.

---

## 7. Merkle + EAS mapping

```text
leaf_i = sha256(
  post_url || content_hash || str(score) || engine || observed_at_iso
)
merkle_root = merkle(leaf_0 … leaf_n)

on-chain (EAS):
  merkleRoot = merkle_root
  runId      = run_id
  primaryPostUrl = accepted[0].url
  acceptedCount  = n
```

**Verify:**
1. `eas.getAttestation(uid)`  
2. Rebuild leaves from re-fetch or run manifest  
3. Compare roots  

If Instagram/X block hotlink: verify uses **content_hash saved at accept time** + prove it matches attestation; document CDN limitation in README (honest, still meets “re-verify against on-chain record”).

---

## 8. Integrations checklist (accounts / keys)

| Integration | Free action | Env var |
|---|---|---|
| SerpAPI | Sign up → 250/mo | `SERPAPI_API_KEY` |
| imgbb (or similar) | Free API key | `IMGBB_API_KEY` |
| Alchemy (or Infura) | Free Sepolia RPC | `SEPOLIA_RPC_URL` |
| Wallet | MetaMask + Sepolia faucet | `PRIVATE_KEY` (dev only; never commit) |
| EAS | Use SDK; register schema once or reuse | `EAS_SCHEMA_UID` |
| InsightFace | `pip install` + model download | none |

**Credit budget (smoke + recording):** ~5–15 SerpAPI calls. Stay well under 250.

---

## 9. Smoke test plan (before building features deep)

| # | Test | Pass criteria |
|---|---|---|
| S0 | Face only | Detect + embedding file written |
| S1 | Host crop | Public URL returns 200 |
| S2 | Live Lens | `visual_matches` or equivalent non-empty; response saved |
| S3 | Social pick | ≥1 URL with social host **or** documented best public post |
| S4 | Merkle | Deterministic root for same leaves |
| S5 | Attest | UID on [easscan Sepolia](https://sepolia.easscan.org/) |
| S6 | Verify | CLI exit 0 on untouched; exit 1 on tampered leaf |
| S7 | Recording | One command shows S0→S6 |

Do **S0→S6 in order**. Do not build Neo4j/expand until S2–S6 pass.

---

## 10. Build order (architecture → working demo)

1. Ports + empty adapters + CLI stubs  
2. Face adapter + S0  
3. Host + SerpAPI + S1–S2 (**crux**)  
4. Policy filter + NetworkX graph + accept  
5. Merkle + EAS attest + verify (S4–S6)  
6. Event JSONL + polish README  
7. Optional: handle expand hop + second search engine  
8. Optional: Neo4j Aura behind same `GraphStore`

---

## 11. Standards used (why this isn’t “too simple”)

| Practice | How |
|---|---|
| Hexagonal / ports & adapters | Swap SerpAPI, Neo4j, chain without rewrite |
| Pipeline stages | Clear events; fail-closed on search/attest |
| Evidence graph | Real routing state, not only a list |
| Content-addressed verify | Merkle + EAS |
| Auditability | `events.jsonl` + `runs/` artifacts |
| Config via env | 12-factor lite |
| Honesty | README limitations (CDN, public-only, Lens ≠ biometric ID) |

**Not doing now:** autoscaling, k8s, multi-region, paid OSINT APIs.

---

## 12. One-line system definition

> A staged, event-logged CLI pipeline: local face encode → free live Lens search → lean evidence graph → Merkle fingerprint attested on EAS Sepolia → re-verify — with ports so graph DB and queues can upgrade later without changing the brief’s three beats.

---

## Next action

1. Create SerpAPI + imgbb + Alchemy + faucet wallet keys.  
2. Scaffold repo from §3 layout.  
3. Run smoke **S0 → S2** first (prove live search).  

Say when to scaffold the repo and implement S0–S2.
