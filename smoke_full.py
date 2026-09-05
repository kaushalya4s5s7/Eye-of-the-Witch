#!/usr/bin/env python3
"""Full smoke: InsightFace → multi-engine search → NetworkX graph → face-rank
→ gated handle expand → Merkle → EAS Sepolia → verify.
"""

from __future__ import annotations

import json
import re
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import networkx as nx
import numpy as np
import requests

import smoke_e2e as base

ROOT = Path(__file__).resolve().parent


def emit(events: list[dict], out_dir: Path, kind: str, **payload: Any) -> None:
    ev = {"ts": base.utc_now(), "event": kind, **payload}
    events.append(ev)
    with (out_dir / "events.jsonl").open("a") as f:
        f.write(json.dumps(ev) + "\n")
    print(f"  · event {kind}")


def normalize_hit(raw: dict[str, Any], engine: str, idx: int) -> dict[str, Any] | None:
    link = raw.get("link") or raw.get("source") or raw.get("original") or ""
    if not isinstance(link, str) or not link.startswith("http"):
        # yandex sometimes nests differently
        link = (raw.get("source") if isinstance(raw.get("source"), str) else "") or ""
    if not link.startswith("http"):
        return None
    thumb = raw.get("thumbnail") or raw.get("image") or raw.get("original") or ""
    title = raw.get("title") or raw.get("snippet") or ""
    source = raw.get("source")
    if not isinstance(source, str):
        source = urlparse(link).netloc
    return {
        "link": link,
        "title": title,
        "thumbnail": thumb if isinstance(thumb, str) else "",
        "image": raw.get("image") or thumb,
        "source": source,
        "engine": engine,
        "position": raw.get("position") or idx + 1,
    }


def fetch_engine(engine: str, image_url: str, api_key: str) -> tuple[str, dict, list[dict]]:
    if engine == "google_lens":
        params = {"engine": "google_lens", "url": image_url, "api_key": api_key}
    elif engine == "google_reverse_image":
        params = {"engine": "google_reverse_image", "image_url": image_url, "api_key": api_key}
    elif engine == "yandex_images":
        params = {
            "engine": "yandex_images",
            "url": image_url,
            "tab": "similar",
            "api_key": api_key,
        }
    else:
        raise ValueError(engine)

    r = requests.get("https://serpapi.com/search.json", params=params, timeout=120)
    r.raise_for_status()
    payload = r.json()
    if payload.get("error"):
        return engine, payload, []

    raw_hits: list = []
    if engine == "google_lens":
        raw_hits = (
            payload.get("visual_matches")
            or payload.get("exact_matches")
            or payload.get("image_sources")
            or []
        )
    elif engine == "google_reverse_image":
        raw_hits = payload.get("image_results") or payload.get("inline_images") or []
    elif engine == "yandex_images":
        raw_hits = payload.get("images_results") or []

    hits = []
    for i, h in enumerate(raw_hits):
        n = normalize_hit(h, engine, i)
        if n:
            hits.append(n)
    return engine, payload, hits


def step_multi_search(
    image_url: str,
    api_key: str,
    out_dir: Path,
    events: list,
    *,
    probe_tag: str = "p0",
    emit_request: bool = True,
) -> tuple[list[dict], dict[str, int]]:
    print(f"\n[S2] Multi-engine reverse search ({probe_tag})…")
    engines = ["google_lens", "google_reverse_image", "yandex_images"]
    if emit_request:
        emit(events, out_dir, "ImageSearchRequested", engines=engines, image_url=image_url, probe=probe_tag)

    merged: list[dict] = []
    by_engine: dict[str, int] = {}

    with ThreadPoolExecutor(max_workers=3) as pool:
        futs = {pool.submit(fetch_engine, e, image_url, api_key): e for e in engines}
        for fut in as_completed(futs):
            engine, payload, hits = fut.result()
            (out_dir / f"serpapi_{probe_tag}_{engine}.json").write_text(json.dumps(payload, indent=2))
            if payload.get("error"):
                print(f"  ! {probe_tag}/{engine}: {payload['error']}")
                emit(
                    events,
                    out_dir,
                    "ImageSearchFailed",
                    engine=engine,
                    error=payload["error"],
                    probe=probe_tag,
                )
                by_engine[engine] = 0
                continue
            by_engine[engine] = len(hits)
            for h in hits:
                h["probe"] = probe_tag
            merged.extend(hits)
            emit(
                events,
                out_dir,
                "ImageSearchCompleted",
                engine=engine,
                hits=len(hits),
                probe=probe_tag,
            )
            print(f"  OK {probe_tag}/{engine}: {len(hits)} hits")

    return merged, by_engine


def merge_hit_lists(all_hits: list[dict], by_engine_total: dict[str, int], out_dir: Path, events: list) -> list[dict]:
    by_url: dict[str, dict] = {}
    for h in all_hits:
        u = h["link"].split("?")[0].rstrip("/")
        if u not in by_url:
            by_url[u] = {**h, "engines": [h["engine"]], "probes": [h.get("probe") or "p0"]}
        else:
            if h["engine"] not in by_url[u]["engines"]:
                by_url[u]["engines"].append(h["engine"])
            pr = h.get("probe") or "p0"
            if pr not in by_url[u]["probes"]:
                by_url[u]["probes"].append(pr)
            if not by_url[u].get("thumbnail") and h.get("thumbnail"):
                by_url[u]["thumbnail"] = h["thumbnail"]
                by_url[u]["image"] = h.get("image") or h["thumbnail"]

    hits = list(by_url.values())
    for h in hits:
        h["engine"] = "+".join(h.get("engines") or [h.get("engine") or "unknown"])
        h["probe"] = "+".join(h.get("probes") or ["p0"])

    (out_dir / "search_merged.json").write_text(
        json.dumps(
            {
                "by_engine": by_engine_total,
                "merged_unique": len(hits),
                "hits": hits,
            },
            indent=2,
        )
    )
    if not hits:
        raise RuntimeError("All engines returned 0 usable hits")
    print(f"  OK merged unique URLs: {len(hits)} (from {by_engine_total})")
    emit(events, out_dir, "SearchMerged", unique=len(hits), by_engine=by_engine_total)
    return hits


def step_multi_probe_search(
    probe_urls: list[tuple[str, str]],
    api_key: str,
    out_dir: Path,
    events: list,
) -> list[dict]:
    """Reverse-search each coreset probe URL and merge (deep-opt discovery)."""
    print(f"\n[S2] Deep-opt multi-probe search ({len(probe_urls)} probes)…")
    emit(
        events,
        out_dir,
        "ImageSearchRequested",
        engines=["google_lens", "google_reverse_image", "yandex_images"],
        probes=[t for t, _ in probe_urls],
        multi_probe=True,
    )
    all_hits: list[dict] = []
    by_engine_total: dict[str, int] = {}
    for tag, url in probe_urls:
        merged, by_engine = step_multi_search(
            url, api_key, out_dir, events, probe_tag=tag, emit_request=False
        )
        all_hits.extend(merged)
        for k, v in by_engine.items():
            by_engine_total[k] = by_engine_total.get(k, 0) + v
    return merge_hit_lists(all_hits, by_engine_total, out_dir, events)


def extract_handle(url: str) -> str | None:
    p = urlparse(url)
    host = p.netloc.lower().removeprefix("www.")
    parts = [x for x in p.path.split("/") if x]
    if "linkedin.com" in host and len(parts) >= 2 and parts[0] == "in":
        return f"linkedin:{parts[1]}"
    if "instagram.com" in host and parts:
        if parts[0] not in {"p", "reel", "tv", "stories"}:
            return f"instagram:{parts[0]}"
    if host in {"x.com", "twitter.com"} and parts:
        if parts[0] not in {"i", "intent", "search"}:
            return f"x:{parts[0]}"
    return None


def build_graph(
    seed_meta: dict,
    hits: list[dict],
    accepted: list[dict],
    out_dir: Path,
    events: list,
    expand_notes: list[dict],
    anchor: dict | None = None,
) -> nx.DiGraph:
    print("\n[S3b] Evidence graph (NetworkX)…")
    G = nx.DiGraph()
    seed_id = "face:seed"
    G.add_node(
        seed_id,
        kind="FaceSeed",
        embedding_sha256=seed_meta.get("embedding_sha256"),
        backend=seed_meta.get("backend"),
    )

    for h in hits:
        nid = f"hit:{base.sha256_hex(h['link'].encode())[:16]}"
        G.add_node(
            nid,
            kind="ImageHit",
            url=h["link"],
            title=h.get("title"),
            social=base.is_social(h["link"]),
            engine=h.get("engine"),
        )
        G.add_edge(seed_id, nid, kind="FOUND_VIA", engine=h.get("engine"))
        handle = extract_handle(h["link"])
        if handle:
            hid = f"handle:{handle}"
            G.add_node(hid, kind="Handle", handle=handle)
            G.add_edge(nid, hid, kind="HAS_HANDLE")

    for a in accepted:
        pid = f"post:{base.sha256_hex(a['url'].encode())[:16]}"
        G.add_node(
            pid,
            kind="Post",
            url=a["url"],
            face_similarity=a.get("face_similarity"),
            social=a.get("social"),
            content_hash=a.get("content_hash"),
            near_exact=a.get("near_exact"),
        )
        G.add_edge(seed_id, pid, kind="ACCEPTED_IN", face_similarity=a.get("face_similarity"))
        handle = extract_handle(a["url"])
        if handle:
            hid = f"handle:{handle}"
            if hid not in G:
                G.add_node(hid, kind="Handle", handle=handle)
            G.add_edge(hid, pid, kind="AUTHORED_OR_APPEARS")

    if anchor and anchor.get("url"):
        aid = f"anchor:{base.sha256_hex(anchor['url'].encode())[:16]}"
        G.add_node(
            aid,
            kind="Anchor",
            url=anchor["url"],
            face_similarity=anchor.get("face_similarity"),
            phash_distance=anchor.get("phash_distance"),
            near_exact=True,
        )
        G.add_edge(seed_id, aid, kind="LOCKED_AS_ANCHOR")

    for note in expand_notes:
        eid = f"expand:{base.sha256_hex(note['url'].encode())[:16]}"
        G.add_node(eid, kind="ExpandHit", **note)
        G.add_edge("face:seed", eid, kind="EXPAND_FOUND")

    data = nx.node_link_data(G, edges="links")
    (out_dir / "graph.json").write_text(json.dumps(data, indent=2))
    print(f"  OK nodes={G.number_of_nodes()} edges={G.number_of_edges()}")
    emit(
        events,
        out_dir,
        "GraphUpserted",
        nodes=G.number_of_nodes(),
        edges=G.number_of_edges(),
    )
    return G


def step_smart_expand(
    accepted: list[dict],
    api_key: str,
    out_dir: Path,
    events: list,
    seed_emb: np.ndarray,
    *,
    anchor: dict | None,
) -> list[dict]:
    """One gated hop: only after dual-confirm AnchorLocked (near-exact + face vs seed)."""
    print("\n[S3c] Smart expand (gated)…")
    if not anchor:
        emit(events, out_dir, "ExpandSkipped", reason="no_dual_confirm_anchor")
        print("  skip: no AnchorLocked (need near-exact + face_sim≥τ vs seed)")
        return []

    best = anchor
    if (best.get("face_similarity") or 0) < base.TAU_ANCHOR_FACE:
        emit(events, out_dir, "ExpandSkipped", reason="anchor_face_below_tau")
        print("  skip: anchor face_sim below tau")
        return []

    handle = extract_handle(best["url"])
    # pull a name-like token from title
    title = best.get("title") or ""
    name = None
    m = re.match(r"^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)", title)
    if m:
        name = m.group(1)
    if not name and handle and "linkedin:" in handle:
        name = handle.split(":", 1)[1].replace("-", " ")

    if not name and not handle:
        emit(events, out_dir, "ExpandSkipped", reason="no_name_or_handle")
        print("  skip: could not earn name/handle")
        return []

    q = f'"{name}"' if name else handle
    if name:
        q = f'{name} (site:linkedin.com OR site:instagram.com OR site:x.com OR site:twitter.com)'
    print(f"  expand query: {q}")
    emit(
        events,
        out_dir,
        "ExpandRequested",
        query=q,
        from_url=best["url"],
        handle=handle,
        anchor=True,
    )

    r = requests.get(
        "https://serpapi.com/search.json",
        params={"engine": "google", "q": q, "api_key": api_key, "num": 10},
        timeout=60,
    )
    r.raise_for_status()
    payload = r.json()
    (out_dir / "serpapi_expand_google.json").write_text(json.dumps(payload, indent=2))
    if payload.get("error"):
        emit(events, out_dir, "ExpandSkipped", reason=payload["error"])
        print(f"  skip expand: {payload['error']}")
        return []

    notes = []
    for i, org in enumerate(payload.get("organic_results") or []):
        link = org.get("link") or ""
        if not link.startswith("http"):
            continue
        if not base.is_social(link):
            continue
        notes.append(
            {
                "url": link,
                "title": org.get("title") or "",
                "source": urlparse(link).netloc,
                "social": True,
                "engine": "google_expand",
                "from_handle": handle,
                "expand_query": q,
                "face_similarity": None,  # text expand — no thumb face score here
                "content_hash": base.sha256_hex(link.encode()),
                "observed_at": base.utc_now(),
                "position": i + 1,
            }
        )

    # keep new URLs not already in accepted
    have = {a["url"].split("?")[0].rstrip("/") for a in accepted}
    fresh = [n for n in notes if n["url"].split("?")[0].rstrip("/") not in have][:3]
    (out_dir / "expand_hits.json").write_text(json.dumps(fresh, indent=2))
    emit(events, out_dir, "ExpandCompleted", found=len(fresh), query=q)
    print(f"  OK expand social hits: {len(fresh)}")
    for n in fresh:
        print(f"    - {n['url'][:90]}")
    return fresh


def lock_anchor(out_dir: Path, events: list, accepted: list[dict]) -> dict | None:
    """Lock Anchor only with dual confirm: near_exact AND face_sim ≥ τ vs seed."""
    print("\n[S3a] Anchor lock (dual confirm)…")
    ranked_path = out_dir / "candidates_ranked.json"
    pool = list(accepted)
    if ranked_path.exists():
        all_scored = json.loads(ranked_path.read_text()).get("all_scored") or []
        pool = all_scored or pool

    # Poison guard: near-exact without face match must never lock
    near_but_weak = [
        r
        for r in pool
        if r.get("near_exact")
        and (
            r.get("face_similarity") is None
            or (r.get("face_similarity") or 0) < base.TAU_ANCHOR_FACE
        )
    ]
    for r in near_but_weak[:3]:
        print(
            f"  reject exact-without-face: sim={r.get('face_similarity')} "
            f"phash_d={r.get('phash_distance')} {str(r.get('url'))[:70]}"
        )

    anchor = base.pick_anchor(pool)
    if not anchor:
        print("  no AnchorLocked — expand will be skipped (Case 3: accept-only)")
        (out_dir / "anchor.json").write_text(json.dumps({"locked": False}, indent=2))
        return None

    payload = {
        "locked": True,
        "url": anchor["url"],
        "face_similarity": anchor.get("face_similarity"),
        "phash_distance": anchor.get("phash_distance"),
        "near_exact": True,
        "social": anchor.get("social"),
        "title": anchor.get("title"),
        "tau_anchor_face": base.TAU_ANCHOR_FACE,
    }
    (out_dir / "anchor.json").write_text(json.dumps(payload, indent=2))
    emit(events, out_dir, "AnchorLocked", **payload)
    print(
        f"  OK AnchorLocked sim={payload['face_similarity']} "
        f"phash_d={payload['phash_distance']} {payload['url'][:80]}"
    )
    return anchor


def merge_accept_expand(accepted: list[dict], expand: list[dict], top_k: int = 5) -> list[dict]:
    """Prefer face-scored accepts; fill remaining slots with expand social URLs."""
    out = list(accepted[:top_k])
    have = {a["url"].split("?")[0].rstrip("/") for a in out}
    for e in expand:
        key = e["url"].split("?")[0].rstrip("/")
        if key in have:
            continue
        out.append(e)
        have.add(key)
        if len(out) >= top_k + 2:
            break
    return out


def main() -> int:
    env = base.require_env(
        "SERPAPI_API_KEY",
        "IMGBB_API_KEY",
        "SEPOLIA_RPC_URL",
        "PRIVATE_KEY",
    )
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    out_dir = ROOT / "runs" / f"full-{run_id}"
    out_dir.mkdir(parents=True, exist_ok=True)
    events: list[dict] = []
    print(f"FULL RUN {run_id}")
    print(f"OUT {out_dir}")

    args_paths = base.parse_image_args()
    if args_paths:
        for p in args_paths:
            if not p.exists():
                raise SystemExit(f"Image not found: {p}")
        paths = args_paths
    else:
        matches = list((ROOT / "samples").glob("Screenshot*.png"))
        paths = [matches[0]] if matches else [ROOT / "samples" / "elon_musk.jpg"]
    print(f"IMAGES ({len(paths)}): " + ", ".join(p.name for p in paths))

    results = []
    try:
        gallery = base.step_seed_gallery(paths, out_dir, require_insightface=True)
        face = gallery["primary"]
        results.append(("S0_face", f"{face['backend']}:gallery={gallery['size']}"))
        emit(
            events,
            out_dir,
            "FaceDetected",
            **{k: face[k] for k in ("backend", "det_score", "embedding_sha256")},
            gallery_size=gallery["size"],
        )
        emit(
            events,
            out_dir,
            "GalleryBuilt",
            size=gallery["size"],
            inputs=gallery["inputs"],
            kept=gallery["kept"],
            rejected=gallery["rejected"],
            score_mode=gallery["score_mode"],
            coreset=len(gallery.get("coreset") or []),
            deep_opt=True,
        )
        seed_emb = np.load(face["embedding_path"])
        gal_emb = np.load(gallery["gallery_path"])
        gal_q = np.load(gallery["qualities_path"]) if gallery.get("qualities_path") else None
        crop_paths = [Path(m["crop_path"]) for m in gallery["members"]]

        # Deep-opt: host + reverse-search coreset probes (not only primary)
        coreset = gallery.get("coreset") or [
            {"crop_path": face["crop_path"], "index": 0, "quality": face.get("det_score")}
        ]
        probe_urls: list[tuple[str, str]] = []
        for i, c in enumerate(coreset):
            tag = f"p{i}"
            url = base.step_host(
                Path(c["crop_path"]),
                env["IMGBB_API_KEY"],
                out_dir,
                tag=tag if i > 0 else "primary",
            )
            probe_urls.append((tag, url))
            emit(events, out_dir, "ImageHosted", url=url, probe=tag, quality=c.get("quality"))
        results.append(("S1_host", f"{len(probe_urls)} probes"))

        hits = step_multi_probe_search(
            probe_urls, env["SERPAPI_API_KEY"], out_dir, events
        )
        results.append(("S2_multi", f"{len(hits)} unique / {len(probe_urls)} probes"))

        accepted = base.step_accept(
            hits,
            out_dir,
            seed_emb,
            top_k=5,
            min_face_sim=0.25,
            seed_crop_paths=crop_paths,
            gallery_embeddings=gal_emb,
            gallery_qualities=gal_q,
            require_threshold=True,
            deep_opt=True,
        )
        if not accepted:
            emit(
                events,
                out_dir,
                "NoMatchFound",
                reason="no_hit_above_face_threshold",
                min_face_sim=0.25,
                gallery_size=gallery["size"],
            )
            results.append(("S3_face_rank", "no_match"))
            (out_dir / "smoke_report.json").write_text(
                json.dumps(
                    {
                        "ok": False,
                        "no_match": True,
                        "run_id": run_id,
                        "images": [str(p) for p in paths],
                        "gallery_size": gallery["size"],
                        "steps": results,
                        "events": len(events),
                    },
                    indent=2,
                )
            )
            print("\n=== NO MATCH FOUND (no blockchain write) ===")
            return 2

        results.append(("S3_face_rank", accepted[0]["url"][:60]))
        emit(
            events,
            out_dir,
            "PostAccepted",
            count=len(accepted),
            top_sim=accepted[0].get("face_similarity"),
            gallery_size=gallery["size"],
        )
        for a in accepted:
            emit(
                events,
                out_dir,
                "PostAccepted",
                url=a["url"],
                title=a.get("title"),
                thumbnail=a.get("thumbnail"),
                face_similarity=a.get("face_similarity"),
                social=a.get("social"),
                near_exact=a.get("near_exact"),
                best_gallery_index=a.get("best_gallery_index"),
            )

        anchor = lock_anchor(out_dir, events, accepted)
        results.append(("S3a_anchor", "locked" if anchor else "none"))

        expand = step_smart_expand(
            accepted,
            env["SERPAPI_API_KEY"],
            out_dir,
            events,
            seed_emb,
            anchor=anchor,
        )
        final = merge_accept_expand(accepted, expand, top_k=5)
        (out_dir / "accepted_final.json").write_text(json.dumps(final, indent=2))

        build_graph(face, hits, final, out_dir, events, expand, anchor=anchor)

        merkle_set = [a for a in final if a.get("face_similarity") is not None] or final[:3]
        (out_dir / "accepted.json").write_text(json.dumps(merkle_set, indent=2))

        root = base.step_merkle(merkle_set, out_dir)
        results.append(("S4_merkle", root[:24]))
        emit(events, out_dir, "MerkleBuilt", root=root)

        emit(events, out_dir, "Attesting", root=root)
        attest = base.step_attest(
            root,
            merkle_set[0]["url"],
            env["SEPOLIA_RPC_URL"],
            env["PRIVATE_KEY"],
            out_dir,
        )
        results.append(("S5_attest", attest.get("tx_hash", "")[:18]))
        emit(events, out_dir, "Attested", **{k: attest.get(k) for k in ("tx_hash", "uid", "easscan")})

        base.step_verify(root, attest, env["SEPOLIA_RPC_URL"], out_dir)
        results.append(("S6_verify", "pass"))
        emit(events, out_dir, "VerifyPassed", root=root, uid=attest.get("uid"))

    except Exception as e:
        emit(events, out_dir, "Failed", error=str(e))
        (out_dir / "smoke_report.json").write_text(json.dumps({"ok": False, "error": str(e), "steps": results}, indent=2))
        print(f"\nFULL SMOKE FAILED: {e}")
        return 1

    report = {
        "ok": True,
        "run_id": run_id,
        "images": [str(p) for p in paths],
        "gallery_size": gallery["size"],
        "deep_opt": True,
        "coreset": gallery.get("coreset"),
        "steps": results,
        "events": len(events),
        "attest": json.loads((out_dir / "attest.json").read_text()),
        "anchor": json.loads((out_dir / "anchor.json").read_text())
        if (out_dir / "anchor.json").exists()
        else None,
    }
    (out_dir / "smoke_report.json").write_text(json.dumps(report, indent=2))
    print("\n=== FULL SMOKE PASS ===")
    for k, v in results:
        print(f"  {k}: {v}")
    print(f"  events: {out_dir / 'events.jsonl'}")
    print(f"  graph:  {out_dir / 'graph.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
