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


def step_multi_search(image_url: str, api_key: str, out_dir: Path, events: list) -> list[dict]:
    print("\n[S2] Multi-engine reverse search (parallel)…")
    engines = ["google_lens", "google_reverse_image", "yandex_images"]
    emit(events, out_dir, "ImageSearchRequested", engines=engines, image_url=image_url)

    merged: list[dict] = []
    by_engine: dict[str, int] = {}

    with ThreadPoolExecutor(max_workers=3) as pool:
        futs = {pool.submit(fetch_engine, e, image_url, api_key): e for e in engines}
        for fut in as_completed(futs):
            engine, payload, hits = fut.result()
            (out_dir / f"serpapi_{engine}.json").write_text(json.dumps(payload, indent=2))
            if payload.get("error"):
                print(f"  ! {engine}: {payload['error']}")
                emit(events, out_dir, "ImageSearchFailed", engine=engine, error=payload["error"])
                by_engine[engine] = 0
                continue
            by_engine[engine] = len(hits)
            merged.extend(hits)
            emit(events, out_dir, "ImageSearchCompleted", engine=engine, hits=len(hits))
            print(f"  OK {engine}: {len(hits)} hits")

    # URL-level merge (keep first, tag engines)
    by_url: dict[str, dict] = {}
    for h in merged:
        u = h["link"].split("?")[0].rstrip("/")
        if u not in by_url:
            by_url[u] = {**h, "engines": [h["engine"]]}
        else:
            if h["engine"] not in by_url[u]["engines"]:
                by_url[u]["engines"].append(h["engine"])
            # prefer non-empty thumb
            if not by_url[u].get("thumbnail") and h.get("thumbnail"):
                by_url[u]["thumbnail"] = h["thumbnail"]
                by_url[u]["image"] = h.get("image") or h["thumbnail"]

    hits = list(by_url.values())
    # step_accept expects engine as string
    for h in hits:
        h["engine"] = "+".join(h.get("engines") or [h.get("engine") or "unknown"])

    (out_dir / "search_merged.json").write_text(
        json.dumps({"by_engine": by_engine, "merged_unique": len(hits), "hits": hits}, indent=2)
    )
    if not hits:
        raise RuntimeError("All engines returned 0 usable hits")
    print(f"  OK merged unique URLs: {len(hits)} (from {by_engine})")
    emit(events, out_dir, "SearchMerged", unique=len(hits), by_engine=by_engine)
    return hits


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
        )
        G.add_edge(seed_id, pid, kind="ACCEPTED_IN", face_similarity=a.get("face_similarity"))
        handle = extract_handle(a["url"])
        if handle:
            hid = f"handle:{handle}"
            if hid not in G:
                G.add_node(hid, kind="Handle", handle=handle)
            G.add_edge(hid, pid, kind="AUTHORED_OR_APPEARS")

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
) -> list[dict]:
    """One gated hop: from best social accept, search name/handle on the open web."""
    print("\n[S3c] Smart expand (gated)…")
    social = [a for a in accepted if a.get("social") and (a.get("face_similarity") or 0) >= 0.20]
    if not social:
        emit(events, out_dir, "ExpandSkipped", reason="no_social_above_floor")
        print("  skip: no social hit with face_sim >= 0.20")
        return []

    best = max(social, key=lambda a: a.get("face_similarity") or 0)
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
    emit(events, out_dir, "ExpandRequested", query=q, from_url=best["url"], handle=handle)

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

    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if args:
        sample = Path(args[0]).expanduser().resolve()
    else:
        matches = list((ROOT / "samples").glob("Screenshot*.png"))
        sample = matches[0] if matches else ROOT / "samples" / "elon_musk.jpg"
    if not sample.exists():
        raise SystemExit(f"Image not found: {sample}")
    print(f"IMAGE {sample}")

    results = []
    try:
        face = base.step_face(sample, out_dir, require_insightface=True)
        results.append(("S0_face", face["backend"]))
        emit(events, out_dir, "FaceDetected", **{k: face[k] for k in ("backend", "det_score", "embedding_sha256")})
        seed_emb = np.load(face["embedding_path"])

        hosted = base.step_host(Path(face["crop_path"]), env["IMGBB_API_KEY"], out_dir)
        results.append(("S1_host", hosted))
        emit(events, out_dir, "ImageHosted", url=hosted)

        hits = step_multi_search(hosted, env["SERPAPI_API_KEY"], out_dir, events)
        results.append(("S2_multi", f"{len(hits)} unique"))

        accepted = base.step_accept(
            hits,
            out_dir,
            seed_emb,
            top_k=5,
            min_face_sim=0.25,  # slightly softer; product mirrors often score low
        )
        results.append(("S3_face_rank", accepted[0]["url"][:60]))
        emit(
            events,
            out_dir,
            "PostAccepted",
            count=len(accepted),
            top_sim=accepted[0].get("face_similarity"),
        )

        expand = step_smart_expand(accepted, env["SERPAPI_API_KEY"], out_dir, events, seed_emb)
        final = merge_accept_expand(accepted, expand, top_k=5)
        (out_dir / "accepted_final.json").write_text(json.dumps(final, indent=2))

        build_graph(face, hits, final, out_dir, events, expand)

        # merkle over face-ranked accepts primarily (expand may lack content image hash quality)
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
        "image": str(sample),
        "steps": results,
        "events": len(events),
        "attest": json.loads((out_dir / "attest.json").read_text()),
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
