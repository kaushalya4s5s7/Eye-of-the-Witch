# Plan — Intelligent Search (Anchor → Enrich → Expand)

## 0. Brief is law (do not divert)

**Required pipeline (unchanged):**
```text
Face scan → Web/social search (real, not hardcoded) → ≥1 matching post
         → Blockchain upload (hash/fingerprint) → re-verify against on-chain record
```

| Brief item | Status | Priority |
|---|---|---|
| Face detect + encode | Done (InsightFace) | Keep working |
| Genuine web/social search → ≥1 matching post | Done (SerpAPI + face-rank) | Keep working; polish quality |
| Blockchain hash + re-verify | Done (Merkle → EAS Sepolia) | Keep working |
| No website required | OK (CLI smoke; UI optional) | Don’t spend brief time on site |
| GitHub + README (run, chain, limitations) | **README still missing** | **Required before submit** |

**Intelligent search is not a second product.**  
It only improves the middle step: *better* matching posts, fewer junk accepts.  
If time is short: ship current smoke + README + demo. Anchor/gallery are **optional quality**, not new requirements.

**Out of scope for the brief:** production scrapers for every network, full person-graph product, hosted website, legal identity claims.

---

## 1. Principle (one sentence)

> Earn a high-confidence **identity anchor** before spending budget on the open web; only walk edges that **raise** identity confidence.

Precision over recall when expanding. Face-rank alone on a Lens dump is not enough.  
Still: success for judges = face → real post → chain verify — not “how clever the router is.”

---

## 2. Three match layers (always separate)

| Layer | Meaning | Used for |
|---|---|---|
| **Exact / near-exact image** | Same photo bytes / pHash / SAME_IMAGE | Lock DP / avatar / original post |
| **Same face (embedding)** | InsightFace cosine to seed / gallery | Rank & filter other photos |
| **Account / context** | Profile URL, handle, name on page | Expand *inside* that identity |

Never treat Lens “visual match” as identity by itself.

---

## 2b. Anti-poison rule (wrong DP must not cascade)

**Fear:** lock the wrong “exact DP” → pull that profile’s posts → every later image “matches” the wrong gallery → whole run looks confident but is wrong.

**Ground truth is always the scanned seed face**, never the anchor profile.

| Match type | What it allows | What it must NOT do alone |
|---|---|---|
| **Exact / near-exact image** (pHash / SAME_IMAGE) | Strong *candidate* for Anchor | Expand / gallery without face check |
| **Face embedding vs seed** (InsightFace cosine) | Rank hits; allow *variations* (pose, light, crop, age) | Treat Lens “similar” as same person |
| **Gallery consistency** | Faces agree with each other | Override a weak seed match |

**Hard gates before P3/P4 (expand):**

1. **Dual confirm for Anchor:**  
   `SAME_IMAGE or near-dup` **AND** `face_sim(seed, candidate) ≥ τ_anchor`  
   If Lens says “same photo” but seed face ≠ face in that image → **reject as Anchor** (wrong person crop / collage / mis-index).

2. **Gallery members scored vs seed, not vs each other first:**  
   Keep only faces with `sim(seed, face) ≥ τ_gallery`.  
   Optional second check: mutual consistency among kept faces — but seed veto always wins.

3. **No silent promote:** Band-3 medium hits can sit in the graph; they never become Anchor.  
   Wrong-looking “exact” without face confirm → `ExpandSkipped(reason=anchor_face_mismatch)`.

4. **Variations are accepted for ranking/accept**, not for locking identity:  
   Same person, different photo → OK if cosine to **seed** is high.  
   Different person who merely looks similar → blocked by τ_anchor / τ_gallery (stricter than accept threshold).

5. **If dual confirm fails:** fall back to Case 3 (face-rank P1 only, no gallery). Better fewer posts than a poisoned identity tree.

**One-liner:** exact image finds the *page*; seed face decides if that page is *you*.

---

## 3. Pipeline phases (the plan)

```text
P0  FACE SEED
    detect + InsightFace embed → FaceSeed

P1  DISCOVERY (cheap, parallel)
    multi-engine reverse image (Lens + Yandex [+ …])
    normalize → candidate ImageHits
    DO NOT expand the web yet

P2  ANCHOR LOCK (critical)
    classify hits:
      A) exact/near-exact on social profile/DP/post
      B) high face-sim on social
      C) news/wiki with entity name
      D) junk (product, low sim) → REJECT, never expand
    pick best Anchor (prefer A > B > C)
    if none → NoMatchFound or weak accept only (no expand)

P3  GALLERY ENRICH (only if Anchor is a profile/account)
    from Anchor profile, list PUBLIC posts/media only
    face-detect each → keep faces close to seed (cluster)
    build GalleryEmbedding[] (2–N faces of same person)
    “understood face” = gallery centroid or best members

P4  GATED WEB SEARCH (only with gallery or strong anchor)
    reverse/face search using gallery faces (or best gallery crop)
    OR name/handle search ONLY if name earned from Anchor page
    score every new hit vs gallery (stricter threshold than P1)
    reject branches that don’t beat gallery threshold

P5  ACCEPT + GRAPH + CHAIN
    top social posts that passed gallery check
    graph edges record WHY (FOUND_VIA, ANCHOR, GALLERY_FROM, ACCEPTED)
    Merkle → EAS → verify
```

**Unwanted traversal dies in P2(D) and P4 gates.**

---

## 4. Case playbooks

### Case 1 — Exact Facebook/Instagram DP (your example)

```text
seed → P1 finds SAME_IMAGE on facebook.com/.../photo or profile pic
     → P2 locks Anchor = that profile
     → P3 pull public posts → learn face gallery
     → P4 search web with gallery (not with noisy Lens dump alone)
     → P5 accept high-sim social + attest
```

### Case 2 — Exact photo on news, no profile

```text
P2 Anchor = article URL + extracted entity name (if face-on-page)
P3 skip gallery-from-profile (none)
P4 name-gated site: social search + face-check results
```

### Case 3 — No exact, only medium face-sims

```text
P2 no strong Anchor
P3 skip
P4 skip expand
P5 accept best face-ranked social from P1 only (current smoke behavior)
OR NoMatchFound if below threshold
```

### Case 4 — Glasses / product swarm

```text
P2 mark D (low face-sim despite visual match) → never expand
```

---

## 5. Confidence bands (routing rules)

| Band | Condition | Action |
|---|---|---|
| **1 Exact** | pHash / SAME_IMAGE / near-dup of seed | Candidate for Anchor |
| **2 Strong face + social** | cosine ≥ τ_strong (e.g. 0.55–0.70+) on social | Accept / enrich |
| **3 Medium** | τ_weak ≤ sim < τ_strong | Keep as hit, **no expand** |
| **4 Junk** | sim < τ_weak or no face in thumb | Reject |

Expand (P3/P4) only from Band 1–2 anchors.

Tune τ on public-figure + self-photo fixtures; don’t ship one magic number blindly.

---

## 6. Graph role (load-bearing, not costume)

Nodes: `FaceSeed`, `ImageHit`, `Anchor`, `Handle`, `Profile`, `GalleryFace`, `Post`  
Edges that matter:

- `FOUND_VIA` (engine)  
- `SAME_IMAGE` / `NEAR_DUP`  
- `LOCKED_AS_ANCHOR`  
- `GALLERY_FROM` (profile → gallery faces)  
- `MATCHES_GALLERY`  
- `ACCEPTED_IN`  
- `EXPAND_SKIPPED` (reason) — for judges / Ryuk terminal  

**Rule:** no outbound expand edges from Rejected / Band 4 nodes.

---

## 7. What we already have vs what to build

| Piece | Status |
|---|---|
| InsightFace seed | Done |
| Multi-engine P1 | Done (Lens + Yandex) |
| Face-rank + dedupe | Done (flat list) |
| NetworkX graph record | Done (weak routing) |
| Name expand (weak) | Partial / often skip |
| **Exact/SAME_IMAGE detector** | **Missing — P2** |
| **Anchor lock policy** | **Missing — P2** |
| **Profile gallery enrich P3** | **Missing** |
| **Gallery-vs-web scoring P4** | **Missing** |
| Events: AnchorLocked, GalleryBuilt, ExpandSkipped reasons | Partial |

---

## 8. Build order (brief-first)

### Must ship (brief)
1. Stable E2E: face → live search → ≥1 social/web match → Merkle → EAS → verify  
2. README: what it does, how to run, which chain, limitations  
3. Demo evidence (run folder / screen recording) on a **public** face/post  

### Optional quality (only if Must is green)
| Slice | What | Brief link |
|---|---|---|
| **I** Anchor lock + dual confirm | Better “matching post” quality | Improves middle step only |
| **II** Lite gallery | Fewer lookalike junk accepts | Optional |
| **III** Gated expand | Extra discovery | Optional — skip if time tight |
| **IV** Events polish | Ryuk / demo clarity | Optional |

**If deadline pressure:** stop after Must. Do **not** delay README for gallery/expand.

---

## 9. Hackathon alignment check

| Brief | How this plan helps |
|---|---|
| Face encode | P0 — done |
| Genuine web/social find | P1 (+ optional I–III) — live engines, not hardcoded |
| ≥1 matching post | P5 accept — done; Slice I makes it cleaner |
| Chain verify | unchanged — done |
| README / repo | Must-ship item above |

We are **not** diverting if optional slices stay optional. Diverting = building graph product / scrapers / website instead of README + demo.

---

## 10. Risks & honesty

| Risk | Mitigation |
|---|---|
| Social scrape blocked | Lite gallery from SAME_IMAGE cluster + Anchor page og:image only |
| Exact match rare | Fall back to Case 3 (current face-rank) |
| Lookalike gallery pollution | Require sim to seed + optional mutual consistency |
| SerpAPI credits | P1 once; P4 only if Anchor earned |
| Ethics / private posts | Public only; README limitation |

---

## 11. Success metrics (for a “smart search” smoke)

- Exact-DP fixture → `AnchorLocked` on that Facebook/IG URL  
- Band-4 product URLs → zero expand edges  
- Accepted set mean face_sim **higher** than old blind top-3  
- Expand only after Anchor (events prove order)  
- Still Merkle + EAS verify green  

---

## 12. Decision

**Default:** brief Must-ship first (README + reliable demo run).  
**Then optional:** Slice I only if Must is green and time remains.  
Gallery/expand = nice-to-have, not required by the task text.

---

## One-line plan

> Face → real web/social match → on-chain fingerprint + re-verify.  
> Optional: smarter middle (anchor + dual face confirm) so the match is cleaner — never instead of the spine.
