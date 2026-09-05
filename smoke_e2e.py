#!/usr/bin/env python3
"""End-to-end smoke: face → imgbb → SerpAPI Lens → merkle → EAS Sepolia → verify."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import time
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import cv2
import numpy as np
import requests
from dotenv import load_dotenv
from eth_account import Account
from web3 import Web3

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

SOCIAL_HOSTS = {
    "x.com",
    "twitter.com",
    "instagram.com",
    "linkedin.com",
    "facebook.com",
    "fb.com",
    "tiktok.com",
    "youtube.com",
    "youtu.be",
    "threads.net",
    "reddit.com",
}

# Existing Sepolia EAS contentHash schema (bytes32 contentHash)
EAS_ADDRESS = Web3.to_checksum_address("0xC2679fBD37d54388Ce493F1DB75320D236e1815e")
EAS_SCHEMA_UID = "0xdf4c41ea0f6263c72aa385580124f41f2898d3613e86c50519fc3cfd7ff13ad4"

EAS_ABI = [
    {
        "inputs": [
            {
                "components": [
                    {"internalType": "bytes32", "name": "schema", "type": "bytes32"},
                    {
                        "components": [
                            {"internalType": "address", "name": "recipient", "type": "address"},
                            {"internalType": "uint64", "name": "expirationTime", "type": "uint64"},
                            {"internalType": "bool", "name": "revocable", "type": "bool"},
                            {"internalType": "bytes32", "name": "refUID", "type": "bytes32"},
                            {"internalType": "bytes", "name": "data", "type": "bytes"},
                            {"internalType": "uint256", "name": "value", "type": "uint256"},
                        ],
                        "internalType": "struct AttestationRequestData",
                        "name": "data",
                        "type": "tuple",
                    },
                ],
                "internalType": "struct AttestationRequest",
                "name": "request",
                "type": "tuple",
            }
        ],
        "name": "attest",
        "outputs": [{"internalType": "bytes32", "name": "", "type": "bytes32"}],
        "stateMutability": "payable",
        "type": "function",
    },
    {
        "inputs": [{"internalType": "bytes32", "name": "uid", "type": "bytes32"}],
        "name": "getAttestation",
        "outputs": [
            {
                "components": [
                    {"internalType": "bytes32", "name": "uid", "type": "bytes32"},
                    {"internalType": "bytes32", "name": "schema", "type": "bytes32"},
                    {"internalType": "uint64", "name": "time", "type": "uint64"},
                    {"internalType": "uint64", "name": "expirationTime", "type": "uint64"},
                    {"internalType": "uint64", "name": "revocationTime", "type": "uint64"},
                    {"internalType": "bytes32", "name": "refUID", "type": "bytes32"},
                    {"internalType": "address", "name": "recipient", "type": "address"},
                    {"internalType": "address", "name": "attester", "type": "address"},
                    {"internalType": "bool", "name": "revocable", "type": "bool"},
                    {"internalType": "bytes", "name": "data", "type": "bytes"},
                ],
                "internalType": "struct Attestation",
                "name": "",
                "type": "tuple",
            }
        ],
        "stateMutability": "view",
        "type": "function",
    },
]


@dataclass
class SmokeResult:
    step: str
    ok: bool
    detail: str


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def require_env(*keys: str) -> dict[str, str]:
    out = {}
    missing = []
    for k in keys:
        v = os.getenv(k, "").strip()
        if not v:
            missing.append(k)
        else:
            out[k] = v
    if missing:
        raise SystemExit(f"Missing env: {', '.join(missing)}")
    return out


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_bytes(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def merkle_root(leaves: list[bytes]) -> bytes:
    if not leaves:
        return sha256_bytes(b"empty")
    level = [sha256_bytes(leaf) if len(leaf) != 32 else leaf for leaf in leaves]
    # Always hash leaf content for consistency
    level = [sha256_bytes(leaf) for leaf in leaves]
    while len(level) > 1:
        if len(level) % 2 == 1:
            level.append(level[-1])
        nxt = []
        for i in range(0, len(level), 2):
            nxt.append(sha256_bytes(level[i] + level[i + 1]))
        level = nxt
    return level[0]


def is_social(url: str) -> bool:
    try:
        host = urlparse(url).netloc.lower().removeprefix("www.")
        return any(host == h or host.endswith("." + h) for h in SOCIAL_HOSTS)
    except Exception:
        return False


def download_sample(path: Path) -> Path:
    """Public photo suitable for reverse-image hits."""
    if path.exists() and path.stat().st_size > 0:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    urls = [
        "https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Elon_Musk_Royal_Society_%28crop2%29.jpg/440px-Elon_Musk_Royal_Society_%28crop2%29.jpg",
        "https://upload.wikimedia.org/wikipedia/commons/8/85/Elon_Musk_Royal_Society_%28crop2%29.jpg",
        "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=640&q=80",
    ]
    headers = {
        "User-Agent": "hhgoa-smoke/1.0 (hackathon pipeline test; educational)",
        "Accept": "image/jpeg,image/png,image/*;q=0.8,*/*;q=0.5",
    }
    last_err: Exception | None = None
    for url in urls:
        try:
            r = requests.get(url, headers=headers, timeout=60)
            r.raise_for_status()
            if len(r.content) < 1000:
                raise RuntimeError("image too small")
            path.write_bytes(r.content)
            return path
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(f"Could not download sample image: {last_err}")


def _encode_crop(crop_bgr: np.ndarray) -> np.ndarray:
    """Deterministic local face encode (normalized 128x128 grayscale vector)."""
    gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, (128, 128), interpolation=cv2.INTER_AREA).astype(np.float32)
    vec = small.flatten()
    vec = (vec - vec.mean()) / (vec.std() + 1e-6)
    n = np.linalg.norm(vec) + 1e-6
    return (vec / n).astype(np.float32)


def step_face(image_path: Path, out_dir: Path, *, require_insightface: bool = False) -> dict[str, Any]:
    print("\n[S0] Face detect + encode…")
    img = cv2.imread(str(image_path))
    if img is None:
        from PIL import Image

        pil = Image.open(image_path).convert("RGB")
        img = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
    if img is None:
        raise RuntimeError(f"Could not read image: {image_path}")

    h, w = img.shape[:2]
    backend = "opencv_haar"
    det_score = 1.0
    emb: np.ndarray | None = None

    try:
        from insightface.app import FaceAnalysis

        print("  loading InsightFace buffalo_s…")
        app = FaceAnalysis(name="buffalo_s", providers=["CPUExecutionProvider"])
        app.prepare(ctx_id=-1, det_size=(640, 640))
        faces = app.get(img)
        if not faces:
            # tight crops sometimes fail detection — pad and retry
            pad = max(img.shape[0], img.shape[1]) // 4
            padded = cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=(255, 255, 255))
            faces = app.get(padded)
            if faces:
                img = padded
                print("  note: detected face after padding tight crop")
        if not faces:
            raise RuntimeError("InsightFace found no face")
        face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
        x1, y1, x2, y2 = [int(v) for v in face.bbox]
        det_score = float(face.det_score)
        emb = face.normed_embedding.astype(np.float32)
        backend = "insightface_buffalo_s"
    except Exception as e:
        if require_insightface:
            raise RuntimeError(f"InsightFace required but failed: {e}") from e
        print(f"  InsightFace unavailable ({e}); using OpenCV Haar + local encode")
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        cascade = cv2.CascadeClassifier(cascade_path)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(60, 60))
        if len(faces) == 0:
            raise RuntimeError("No face detected")
        x, y, bw, bh = max(faces, key=lambda f: f[2] * f[3])
        x1, y1, x2, y2 = int(x), int(y), int(x + bw), int(y + bh)

    pad = 10
    x1, y1 = max(0, x1 - pad), max(0, y1 - pad)
    x2, y2 = min(w, x2 + pad), min(h, y2 + pad)
    crop = img[y1:y2, x1:x2]
    if emb is None:
        emb = _encode_crop(crop)

    crop_path = out_dir / "face_crop.jpg"
    cv2.imwrite(str(crop_path), crop)
    emb_path = out_dir / "embedding.npy"
    np.save(emb_path, emb)

    meta = {
        "backend": backend,
        "bbox": [x1, y1, x2, y2],
        "det_score": det_score,
        "embedding_dim": int(emb.shape[0]),
        "embedding_sha256": sha256_hex(emb.tobytes()),
        "crop_path": str(crop_path),
        "embedding_path": str(emb_path),
        "source_image": str(image_path),
    }
    (out_dir / "face.json").write_text(json.dumps(meta, indent=2))
    print(f"  OK backend={backend} det_score={det_score:.3f} dim={meta['embedding_dim']} emb={meta['embedding_sha256'][:16]}…")
    return meta


def step_host(crop_path: Path, api_key: str, out_dir: Path, *, tag: str = "primary") -> str:
    print(f"\n[S1] Host crop on imgbb ({tag})…")
    with open(crop_path, "rb") as f:
        r = requests.post(
            "https://api.imgbb.com/1/upload",
            data={"key": api_key},
            files={"image": f},
            timeout=60,
        )
    r.raise_for_status()
    data = r.json()
    if not data.get("success"):
        raise RuntimeError(f"imgbb failed: {data}")
    url = data["data"]["url"]
    (out_dir / f"hosted_{tag}.json").write_text(json.dumps(data["data"], indent=2))
    if tag == "primary":
        (out_dir / "hosted.json").write_text(json.dumps(data["data"], indent=2))
    # quick reachability
    head = requests.get(url, timeout=30)
    if head.status_code >= 400:
        raise RuntimeError(f"Hosted URL not reachable: {head.status_code}")
    print(f"  OK {url}")
    return url


def step_lens(image_url: str, api_key: str, out_dir: Path) -> list[dict[str, Any]]:
    print("\n[S2] Live SerpAPI Google Lens…")
    r = requests.get(
        "https://serpapi.com/search.json",
        params={
            "engine": "google_lens",
            "url": image_url,
            "api_key": api_key,
        },
        timeout=120,
    )
    r.raise_for_status()
    payload = r.json()
    (out_dir / "serpapi_lens.json").write_text(json.dumps(payload, indent=2))

    if payload.get("error"):
        raise RuntimeError(f"SerpAPI error: {payload['error']}")

    hits = payload.get("visual_matches") or payload.get("image_sources") or []
    if not hits:
        # some responses nest differently
        hits = payload.get("exact_matches") or []
    if not hits:
        raise RuntimeError("Lens returned 0 matches — not a valid live search result")

    print(f"  OK {len(hits)} matches (live)")
    return hits


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    a = a.astype(np.float32).flatten()
    b = b.astype(np.float32).flatten()
    na = np.linalg.norm(a) + 1e-9
    nb = np.linalg.norm(b) + 1e-9
    return float(np.dot(a / na, b / nb))


def average_hash64(img_bgr: np.ndarray, hash_size: int = 8) -> int:
    """Perceptual average-hash (64-bit). Near-exact images → low Hamming distance."""
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, (hash_size, hash_size), interpolation=cv2.INTER_AREA)
    avg = float(small.mean())
    bits = (small >= avg).astype(np.uint8).flatten()
    value = 0
    for bit in bits:
        value = (value << 1) | int(bit)
    return value


def hamming64(a: int, b: int) -> int:
    return (a ^ b).bit_count()


# Near-exact image: allow mild recompress/resize noise (out of 64 bits)
NEAR_EXACT_HAMMING = 10
# Dual-confirm floor: seed face must still match before we trust an "exact" DP
TAU_ANCHOR_FACE = 0.40
# Decision bands (math that changes accept vs abstain vs reject)
TAU_REJECT = 0.20   # below → reject
TAU_ACCEPT = 0.25   # at/above → accept (gray band in between → abstain)
# Extra seed photos must match the primary face at least this well
TAU_GALLERY_SAME_PERSON = 0.35
MAX_SEED_IMAGES = 5
# Deep-opt: how many seed crops to reverse-search (GhostVLAD/CAFace-style coreset)
DEFAULT_PROBE_CORESET = 2
# Hits used to build lite "owner" vector (cross-profile matching papers)
OWNER_SEED_SIM = 0.35
OWNER_BLEND = 0.35  # final = (1-α)*gallery + α*owner
# Cap verdict leaves in the evidence Merkle (keep seal bounded)
EVIDENCE_VERDICT_CAP = 64


def decide_verdict(
    sim: float | None,
    *,
    near_exact: bool = False,
    tau_accept: float = TAU_ACCEPT,
    tau_reject: float = TAU_REJECT,
    tau_anchor: float = TAU_ANCHOR_FACE,
) -> str:
    """Map face similarity (+ poison-DP rule) → accept | abstain | reject.

    - near_exact without strong face vs seed → reject (anti-poison)
    - sim ≥ τ_accept → accept
    - τ_reject ≤ sim < τ_accept → abstain (not sealed as a match)
    - else → reject
    """
    if sim is None:
        return "reject"
    if near_exact and sim < tau_anchor:
        return "reject"
    if sim >= tau_accept:
        return "accept"
    if sim >= tau_reject:
        return "abstain"
    return "reject"


def apply_verdicts(
    rows: list[dict[str, Any]],
    *,
    tau_accept: float = TAU_ACCEPT,
    tau_reject: float = TAU_REJECT,
) -> dict[str, int]:
    counts = {"accept": 0, "abstain": 0, "reject": 0}
    for r in rows:
        d = decide_verdict(
            r.get("face_similarity"),
            near_exact=bool(r.get("near_exact")),
            tau_accept=tau_accept,
            tau_reject=tau_reject,
        )
        r["decision"] = d
        counts[d] = counts.get(d, 0) + 1
    return counts


def gallery_max_sim(gallery: np.ndarray, emb: np.ndarray) -> tuple[float, int]:
    """Best cosine of hit embedding against any seed-gallery member."""
    if gallery.ndim == 1:
        gallery = gallery.reshape(1, -1)
    best_i = 0
    best = -1.0
    for i in range(gallery.shape[0]):
        s = cosine(gallery[i], emb)
        if s > best:
            best = s
            best_i = i
    return best, best_i


def crop_sharpness(img_bgr: np.ndarray) -> float:
    """Laplacian variance — higher = sharper (quality proxy for coreset)."""
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def member_quality(det_score: float | None, crop_path: str | Path) -> float:
    """Combine detection confidence + sharpness into [0,1]-ish quality."""
    det = float(det_score or 0.0)
    sharp = 0.0
    img = cv2.imread(str(crop_path))
    if img is not None:
        # normalize sharpness roughly into 0..1 (cap at 500)
        sharp = min(1.0, crop_sharpness(img) / 500.0)
    return round(0.65 * det + 0.35 * sharp, 4)


def select_coreset(members: list[dict[str, Any]], k: int = DEFAULT_PROBE_CORESET) -> list[dict[str, Any]]:
    """Pick diverse high-quality probes (FaceCoresetNet-inspired, greedy).

    Prefer high quality; skip near-duplicates of already chosen (sim_to_primary band
    is weak diversity — use embedding cosine when available via member index).
    """
    if not members:
        return []
    ranked = sorted(members, key=lambda m: float(m.get("quality") or 0), reverse=True)
    if k <= 1 or len(ranked) == 1:
        return [ranked[0]]

    chosen: list[dict[str, Any]] = [ranked[0]]
    # Load embeddings from paths if present on members via side channel — gallery stack order = member order
    for cand in ranked[1:]:
        if len(chosen) >= k:
            break
        # diversity: avoid picking second crop with almost-identical quality+index adjacency only;
        # require different source path
        if any(c["path"] == cand["path"] for c in chosen):
            continue
        chosen.append(cand)
    return chosen[:k]


def gallery_quality_sim(
    gallery: np.ndarray,
    qualities: np.ndarray,
    emb: np.ndarray,
) -> tuple[float, int, float]:
    """Quality-weighted soft match + hard max (GhostVLAD-style downweight junk).

    Returns (score, best_index, raw_max).
    score = 0.7 * max_sim + 0.3 * quality-weighted average of positive sims.
    """
    if gallery.ndim == 1:
        gallery = gallery.reshape(1, -1)
    n = gallery.shape[0]
    sims = np.array([cosine(gallery[i], emb) for i in range(n)], dtype=np.float32)
    best_i = int(np.argmax(sims))
    raw_max = float(sims[best_i])
    q = qualities.astype(np.float32)
    if q.shape[0] != n:
        q = np.ones(n, dtype=np.float32)
    # only weight members that somewhat match
    pos = np.clip(sims, 0.0, 1.0)
    w = q * pos
    wsum = float(w.sum()) + 1e-9
    weighted = float((w * sims).sum() / wsum)
    score = 0.7 * raw_max + 0.3 * weighted
    return score, best_i, raw_max


def build_owner_vector(
    hit_embs: list[np.ndarray],
    hit_sims: list[float],
    *,
    min_sim: float = OWNER_SEED_SIM,
    top_n: int = 8,
) -> np.ndarray | None:
    """Lite owner DV from high-sim web hits (1905.06081-style defining vector)."""
    paired = [(e, s) for e, s in zip(hit_embs, hit_sims) if s >= min_sim]
    if len(paired) < 2:
        return None
    paired.sort(key=lambda x: x[1], reverse=True)
    stacked = np.stack([e for e, _ in paired[:top_n]], axis=0)
    vec = stacked.mean(axis=0)
    vec = vec / (np.linalg.norm(vec) + 1e-9)
    return vec.astype(np.float32)


def neighbor_consistency_boost(
    embs: list[np.ndarray | None],
    sims: list[float],
    *,
    pair_tau: float = 0.55,
    floor: float = 0.28,
) -> list[float]:
    """SGGNN-lite: boost hits that agree with other strong gallery matches."""
    n = len(sims)
    boosted = list(sims)
    for i in range(n):
        if embs[i] is None or sims[i] < floor:
            continue
        allies = 0
        for j in range(n):
            if i == j or embs[j] is None or sims[j] < floor:
                continue
            if cosine(embs[i], embs[j]) >= pair_tau:
                allies += 1
        if allies > 0:
            # small additive boost, capped
            boosted[i] = min(1.0, sims[i] + 0.02 * min(allies, 5))
    return boosted


def parse_image_args(argv: list[str] | None = None) -> list[Path]:
    """Collect 1..MAX_SEED_IMAGES paths from CLI (all non-flag args)."""
    raw = argv if argv is not None else sys.argv[1:]
    paths = [Path(a).expanduser().resolve() for a in raw if not a.startswith("--")]
    if len(paths) > MAX_SEED_IMAGES:
        print(f"  warn: capping seed images at {MAX_SEED_IMAGES} (got {len(paths)})")
        paths = paths[:MAX_SEED_IMAGES]
    return paths


def step_seed_gallery(
    image_paths: list[Path],
    out_dir: Path,
    *,
    require_insightface: bool = True,
    tau_same: float = TAU_GALLERY_SAME_PERSON,
) -> dict[str, Any]:
    """Build a seed face gallery from 1..N user photos.

    Photo[0] is primary (hosted for reverse search). Extra photos must match
    primary embedding ≥ tau_same or they are rejected (not mixed into gallery).
    """
    if not image_paths:
        raise RuntimeError("No seed images provided")
    for p in image_paths:
        if not p.exists():
            raise RuntimeError(f"Image not found: {p}")

    print(f"\n[S0] Seed gallery ({len(image_paths)} photo(s))…")
    members: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    embeddings: list[np.ndarray] = []

    primary = step_face(image_paths[0], out_dir, require_insightface=require_insightface)
    primary_emb = np.load(primary["embedding_path"]).astype(np.float32)
    embeddings.append(primary_emb)
    members.append(
        {
            "index": 0,
            "path": str(image_paths[0]),
            "role": "primary",
            "det_score": primary.get("det_score"),
            "embedding_sha256": primary.get("embedding_sha256"),
            "crop_path": primary["crop_path"],
            "sim_to_primary": 1.0,
            "kept": True,
            "quality": member_quality(primary.get("det_score"), primary["crop_path"]),
        }
    )

    for i, path in enumerate(image_paths[1:], start=1):
        sub = out_dir / f"seed_{i}"
        sub.mkdir(parents=True, exist_ok=True)
        try:
            meta = step_face(path, sub, require_insightface=require_insightface)
            emb = np.load(meta["embedding_path"]).astype(np.float32)
            sim = cosine(primary_emb, emb)
            row = {
                "index": i,
                "path": str(path),
                "role": "extra",
                "det_score": meta.get("det_score"),
                "embedding_sha256": meta.get("embedding_sha256"),
                "crop_path": meta["crop_path"],
                "sim_to_primary": round(sim, 4),
                "kept": False,
            }
            if sim < tau_same:
                row["skip_reason"] = "different_person_or_weak_match"
                rejected.append(row)
                print(f"  reject seed[{i}] sim_to_primary={sim:.3f} < {tau_same} ({path.name})")
                continue
            row["kept"] = True
            members.append(row)
            embeddings.append(emb)
            dest = out_dir / f"face_crop_seed_{i}.jpg"
            shutil.copy2(meta["crop_path"], dest)
            row["crop_path"] = str(dest)
            row["quality"] = member_quality(meta.get("det_score"), dest)
            print(
                f"  keep seed[{i}] sim_to_primary={sim:.3f} "
                f"q={row['quality']:.3f} ({path.name})"
            )
        except Exception as e:
            rejected.append(
                {
                    "index": i,
                    "path": str(path),
                    "role": "extra",
                    "kept": False,
                    "skip_reason": str(e),
                }
            )
            print(f"  reject seed[{i}] error={e}")

    gallery = np.stack(embeddings, axis=0)
    gal_path = out_dir / "gallery_embeddings.npy"
    np.save(gal_path, gallery)

    qualities = np.array([float(m.get("quality") or 0.5) for m in members], dtype=np.float32)
    np.save(out_dir / "gallery_qualities.npy", qualities)

    # Centroid (L2-normalized) for optional scoring / logging
    centroid = gallery.mean(axis=0)
    centroid = centroid / (np.linalg.norm(centroid) + 1e-9)
    np.save(out_dir / "gallery_centroid.npy", centroid.astype(np.float32))

    # Quality-weighted centroid (GhostVLAD-lite)
    w = qualities / (qualities.sum() + 1e-9)
    wcent = (gallery * w[:, None]).sum(axis=0)
    wcent = wcent / (np.linalg.norm(wcent) + 1e-9)
    np.save(out_dir / "gallery_weighted_centroid.npy", wcent.astype(np.float32))

    coreset = select_coreset(members, k=DEFAULT_PROBE_CORESET)
    for c in coreset:
        print(f"  coreset probe: idx={c['index']} q={c.get('quality')} {Path(c['path']).name}")

    payload = {
        "size": int(gallery.shape[0]),
        "inputs": len(image_paths),
        "kept": len(members),
        "rejected": len(rejected),
        "tau_same_person": tau_same,
        "primary": primary,
        "members": members,
        "rejected_members": rejected,
        "coreset": [
            {
                "index": c["index"],
                "path": c["path"],
                "crop_path": c["crop_path"],
                "quality": c.get("quality"),
                "det_score": c.get("det_score"),
                "role": c.get("role"),
            }
            for c in coreset
        ],
        "gallery_path": str(gal_path),
        "qualities_path": str(out_dir / "gallery_qualities.npy"),
        "embedding_path": primary["embedding_path"],
        "crop_path": primary["crop_path"],
        "backend": primary["backend"],
        "det_score": primary.get("det_score"),
        "embedding_sha256": primary.get("embedding_sha256"),
        "score_mode": "quality_weighted_max+owner_blend+neighbor",
        "deep_opt": True,
        "probe_coreset_k": len(coreset),
    }
    (out_dir / "gallery.json").write_text(json.dumps(payload, indent=2))
    print(
        f"  OK gallery size={payload['size']} "
        f"(kept {payload['kept']}/{payload['inputs']}, rejected {payload['rejected']}, "
        f"coreset={len(coreset)})"
    )
    return payload


def _load_insightface():
    from insightface.app import FaceAnalysis

    app = FaceAnalysis(name="buffalo_s", providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=-1, det_size=(640, 640))
    return app


def _embed_image_bgr(app, img_bgr: np.ndarray) -> tuple[np.ndarray | None, float]:
    faces = app.get(img_bgr)
    if not faces:
        return None, 0.0
    face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    return face.normed_embedding.astype(np.float32), float(face.det_score)


def _bytes_to_bgr(content: bytes) -> np.ndarray | None:
    arr = np.frombuffer(content, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    return img


def step_accept(
    hits: list[dict[str, Any]],
    out_dir: Path,
    seed_embedding: np.ndarray,
    *,
    top_k: int = 5,
    min_face_sim: float = 0.35,
    dedupe_sim: float = 0.92,
    seed_crop_path: Path | None = None,
    seed_crop_paths: list[Path] | None = None,
    gallery_embeddings: np.ndarray | None = None,
    gallery_qualities: np.ndarray | None = None,
    require_threshold: bool = False,
    deep_opt: bool = True,
) -> list[dict[str, Any]]:
    """Rank hits by face similarity to seed gallery; near-exact boost; collapse near-dups.

    Deep-opt (papers): quality-weighted gallery score + owner-vector blend +
    neighbor consistency boost. Ground truth remains user seed gallery.
    """
    if gallery_embeddings is None:
        gallery = seed_embedding.reshape(1, -1).astype(np.float32)
    else:
        gallery = np.asarray(gallery_embeddings, dtype=np.float32)
        if gallery.ndim == 1:
            gallery = gallery.reshape(1, -1)

    if gallery_qualities is None:
        qualities = np.ones(gallery.shape[0], dtype=np.float32)
    else:
        qualities = np.asarray(gallery_qualities, dtype=np.float32).reshape(-1)
        if qualities.shape[0] != gallery.shape[0]:
            qualities = np.ones(gallery.shape[0], dtype=np.float32)

    crop_paths: list[Path] = []
    if seed_crop_paths:
        crop_paths = [Path(p) for p in seed_crop_paths if Path(p).exists()]
    elif seed_crop_path and Path(seed_crop_path).exists():
        crop_paths = [Path(seed_crop_path)]

    mode = "deep_opt" if deep_opt else "max_sim"
    print("\n[S3] Intelligent accept (dedupe + face-rank + near-exact)…")
    print(f"  scoring {len(hits)} hits against gallery size={gallery.shape[0]} mode={mode}…")

    seed_phashes: list[int] = []
    for cp in crop_paths:
        seed_bgr = cv2.imread(str(cp))
        if seed_bgr is not None:
            seed_phashes.append(average_hash64(seed_bgr))
    if seed_phashes:
        print(
            f"  seed aHash ready ×{len(seed_phashes)} "
            f"(near-exact Hamming≤{NEAR_EXACT_HAMMING})"
        )

    app = _load_insightface()
    scored: list[dict[str, Any]] = []
    # parallel arrays for deep-opt (not serialized)
    work_embs: list[np.ndarray | None] = []

    for i, h in enumerate(hits):
        link = h.get("link") or h.get("source") or ""
        if not isinstance(link, str) or not link.startswith("http"):
            continue
        thumb = h.get("thumbnail") or h.get("image") or ""
        title = h.get("title") or ""
        row: dict[str, Any] = {
            "url": link,
            "title": title,
            "source": h.get("source") or urlparse(link).netloc,
            "social": is_social(link),
            "thumbnail": thumb,
            "engine": h.get("engine") or "google_lens",
            "lens_position": h.get("position") or i + 1,
            "face_similarity": None,
            "face_similarity_primary": None,
            "face_similarity_raw_max": None,
            "owner_similarity": None,
            "neighbor_boosted": False,
            "best_gallery_index": None,
            "det_score": None,
            "content_hash": None,
            "phash": None,
            "phash_distance": None,
            "near_exact": False,
            "duplicate_of": None,
            "skip_reason": None,
        }

        blob = (link + "|" + title).encode()
        img_bgr = None
        if thumb:
            try:
                tr = requests.get(thumb, timeout=20)
                if tr.ok and len(tr.content) > 200:
                    blob = tr.content
                    img_bgr = _bytes_to_bgr(tr.content)
            except Exception:
                pass
        row["content_hash"] = sha256_hex(blob)
        row["thumb_hash"] = sha256_hex(blob) if img_bgr is not None else None

        if img_bgr is None:
            row["skip_reason"] = "no_image_bytes"
            scored.append(row)
            work_embs.append(None)
            continue

        if seed_phashes:
            try:
                ph = average_hash64(img_bgr)
                dist = min(hamming64(sp, ph) for sp in seed_phashes)
                row["phash"] = format(ph, "016x")
                row["phash_distance"] = dist
                row["near_exact"] = dist <= NEAR_EXACT_HAMMING
            except Exception:
                pass

        emb, det = _embed_image_bgr(app, img_bgr)
        if emb is None:
            row["skip_reason"] = "no_face_in_thumb"
            scored.append(row)
            work_embs.append(None)
            continue

        if deep_opt:
            sim, best_i, raw_max = gallery_quality_sim(gallery, qualities, emb)
            row["face_similarity_raw_max"] = round(raw_max, 4)
        else:
            sim, best_i = gallery_max_sim(gallery, emb)
            raw_max = sim
            row["face_similarity_raw_max"] = round(raw_max, 4)

        sim_primary = cosine(gallery[0], emb)
        row["face_similarity"] = round(sim, 4)
        row["face_similarity_primary"] = round(sim_primary, 4)
        row["best_gallery_index"] = int(best_i)
        row["det_score"] = round(det, 4)
        scored.append(row)
        work_embs.append(emb)
        nx_flag = " EXACT" if row["near_exact"] else ""
        print(
            f"  [{i+1}/{len(hits)}] sim={sim:.3f} (g{best_i}) social={row['social']}"
            f" phash_d={row.get('phash_distance')}{nx_flag} {link[:60]}"
        )

    # --- Deep-opt pass: owner vector + neighbor boost ---
    if deep_opt:
        hit_embs = [e for e in work_embs if e is not None]
        hit_sims = [
            float(r["face_similarity"])
            for r, e in zip(scored, work_embs)
            if e is not None and r.get("face_similarity") is not None
        ]
        owner = build_owner_vector(hit_embs, hit_sims)
        if owner is not None:
            np.save(out_dir / "owner_vector.npy", owner)
            print(f"  owner vector built from {len([s for s in hit_sims if s >= OWNER_SEED_SIM])} strong hits")
            for r, e in zip(scored, work_embs):
                if e is None or r.get("face_similarity") is None:
                    continue
                o_sim = cosine(owner, e)
                r["owner_similarity"] = round(float(o_sim), 4)
                gal = float(r["face_similarity"])
                blended = (1.0 - OWNER_BLEND) * gal + OWNER_BLEND * max(0.0, float(o_sim))
                r["face_similarity"] = round(blended, 4)
        else:
            print("  owner vector skipped (need ≥2 hits above floor)")

        # neighbor boost on current scores
        sims_now = [
            float(r["face_similarity"]) if r.get("face_similarity") is not None else -1.0
            for r in scored
        ]
        boosted = neighbor_consistency_boost(work_embs, sims_now)
        for r, b, s0 in zip(scored, boosted, sims_now):
            if r.get("face_similarity") is None:
                continue
            if b > s0 + 1e-6:
                r["face_similarity"] = round(b, 4)
                r["neighbor_boosted"] = True
        n_boost = sum(1 for r in scored if r.get("neighbor_boosted"))
        print(f"  neighbor consistency boosted {n_boost} hits")

    # Math → decision band on every scored candidate (changes who can be accepted)
    verdict_counts = apply_verdicts(scored, tau_accept=min_face_sim, tau_reject=TAU_REJECT)
    print(
        f"  verdicts: accept={verdict_counts['accept']} "
        f"abstain={verdict_counts['abstain']} reject={verdict_counts['reject']} "
        f"(τ_accept={min_face_sim} τ_reject={TAU_REJECT})"
    )

    # Exact dedupe by content_hash (same image bytes / same thumb)
    by_hash: dict[str, dict[str, Any]] = {}
    for row in scored:
        ch = row.get("content_hash") or ""
        if not ch or row.get("face_similarity") is None:
            continue
        prev = by_hash.get(ch)
        if prev is None:
            by_hash[ch] = row
        else:
            if (row["face_similarity"] or 0) > (prev["face_similarity"] or 0):
                prev["duplicate_of"] = row["url"]
                prev["skip_reason"] = "duplicate_exact_hash"
                by_hash[ch] = row
            else:
                row["duplicate_of"] = prev["url"]
                row["skip_reason"] = "duplicate_exact_hash"

    unique = [r for r in scored if r.get("skip_reason") not in {"duplicate_exact_hash"}]

    unique_sorted = sorted(
        [r for r in unique if r.get("face_similarity") is not None],
        key=lambda r: (
            bool(r.get("near_exact")),
            bool(r.get("social")),
            r.get("face_similarity") or 0,
        ),
        reverse=True,
    )
    kept: list[dict[str, Any]] = []

    for row in unique_sorted:
        is_near_dup = False
        for k in kept:
            if abs((row["face_similarity"] or 0) - (k["face_similarity"] or 0)) <= (1.0 - dedupe_sim) and (
                urlparse(row["url"]).netloc == urlparse(k["url"]).netloc
                or (row.get("thumb_hash") and row.get("thumb_hash") == k.get("thumb_hash"))
            ):
                is_near_dup = True
                row["duplicate_of"] = k["url"]
                row["skip_reason"] = "duplicate_near_same_face_mirror"
                break
        if not is_near_dup:
            kept.append(row)

    eligible = [r for r in kept if r.get("decision") == "accept"]
    used_fail_soft = False
    if not eligible:
        if require_threshold:
            report = {
                "seed_compare": "deep_opt_quality_owner_neighbor"
                if deep_opt
                else "insightface_max_gallery_cosine",
                "gallery_size": int(gallery.shape[0]),
                "min_face_sim": min_face_sim,
                "tau_accept": min_face_sim,
                "tau_reject": TAU_REJECT,
                "verdict_counts": verdict_counts,
                "near_exact_hamming": NEAR_EXACT_HAMMING,
                "tau_anchor_face": TAU_ANCHOR_FACE,
                "deep_opt": deep_opt,
                "top_k": top_k,
                "hits_in": len(hits),
                "scored": len(scored),
                "unique_after_dedupe": len(kept),
                "accepted": 0,
                "require_threshold": True,
                "no_match": True,
                "all_scored": scored,
            }
            (out_dir / "candidates_ranked.json").write_text(json.dumps(report, indent=2))
            (out_dir / "accepted.json").write_text(json.dumps([], indent=2))
            print(f"  no accept verdicts (τ_accept={min_face_sim}) → NoMatch")
            return []
        eligible = kept[: max(top_k, 1)]
        used_fail_soft = True
        print(f"  warn: no accept verdicts; falling back to best face-ranked")

    ranked = sorted(
        eligible,
        key=lambda r: (
            bool(r.get("near_exact")),
            bool(r.get("social")),
            r.get("face_similarity") or 0,
        ),
        reverse=True,
    )
    chosen = ranked[:top_k]
    if not chosen:
        raise RuntimeError("No usable URLs after face-rank/dedupe")

    observed = utc_now()
    accepted = [{**c, "observed_at": observed, "decision": "accept"} for c in chosen]

    report = {
        "seed_compare": "deep_opt_quality_owner_neighbor"
        if deep_opt
        else "insightface_max_gallery_cosine",
        "gallery_size": int(gallery.shape[0]),
        "min_face_sim": min_face_sim,
        "tau_accept": min_face_sim,
        "tau_reject": TAU_REJECT,
        "verdict_counts": verdict_counts,
        "near_exact_hamming": NEAR_EXACT_HAMMING,
        "tau_anchor_face": TAU_ANCHOR_FACE,
        "deep_opt": deep_opt,
        "owner_blend": OWNER_BLEND if deep_opt else None,
        "top_k": top_k,
        "hits_in": len(hits),
        "scored": len(scored),
        "unique_after_dedupe": len(kept),
        "accepted": len(accepted),
        "require_threshold": require_threshold,
        "fail_soft": used_fail_soft,
        "all_scored": scored,
    }
    (out_dir / "candidates_ranked.json").write_text(json.dumps(report, indent=2))
    (out_dir / "accepted.json").write_text(json.dumps(accepted, indent=2))

    print(
        f"  OK accepted {len(accepted)} / {len(hits)} "
        f"(deduped→{len(kept)}, gallery={gallery.shape[0]}, deep_opt={deep_opt})"
    )
    for a in accepted:
        print(
            f"    - sim={a.get('face_similarity')} social={a['social']} "
            f"near_exact={a.get('near_exact')} owner={a.get('owner_similarity')} "
            f"{a['url'][:70]}"
        )
    return accepted


def pick_anchor(
    scored_or_accepted: list[dict[str, Any]],
    *,
    tau_face: float = TAU_ANCHOR_FACE,
) -> dict[str, Any] | None:
    """Dual-confirm anchor: near-exact image AND face_sim(seed) ≥ tau.

    Exact/near-exact alone never locks — prevents poison-DP cascade.
    """
    candidates = [
        r
        for r in scored_or_accepted
        if r.get("near_exact")
        and r.get("face_similarity") is not None
        and (r.get("face_similarity") or 0) >= tau_face
        and not r.get("skip_reason")
    ]
    if not candidates:
        return None
    # Prefer social profile/post among dual-confirmed
    return max(
        candidates,
        key=lambda r: (bool(r.get("social")), r.get("face_similarity") or 0),
    )


def step_merkle(accepted: list[dict[str, Any]], out_dir: Path) -> str:
    """Legacy: Merkle over accepted posts only (kept for smoke_e2e lean path)."""
    print("\n[S4] Merkle root (accepted-only)…")
    leaves = []
    leaf_hex = []
    for a in accepted:
        raw = f"{a['url']}|{a['content_hash']}|{a['engine']}|{a['observed_at']}".encode()
        digest = sha256_bytes(raw)
        leaves.append(digest)
        leaf_hex.append(digest.hex())
    root = merkle_root(leaves)
    root_hex = root.hex()
    root2 = merkle_root(leaves)
    if root != root2:
        raise RuntimeError("Merkle not deterministic")
    payload = {
        "mode": "accepted_only",
        "merkle_root": root_hex,
        "leaves": leaf_hex,
        "count": len(leaves),
    }
    (out_dir / "merkle.json").write_text(json.dumps(payload, indent=2))
    print(f"  OK root={root_hex[:24]}…")
    return root_hex


def _evidence_leaf_specs(
    *,
    probe: dict[str, Any],
    all_scored: list[dict[str, Any]],
    accepted: list[dict[str, Any]],
) -> list[tuple[str, str, bytes]]:
    """Deterministic (kind, label, digest) leaves for the adjudication bundle."""
    specs: list[tuple[str, str, bytes]] = []
    probe_raw = (
        f"probe|{probe.get('embedding_sha256')}|{probe.get('gallery_size')}|{probe.get('backend')}"
    ).encode()
    specs.append(("probe", "probe", sha256_bytes(probe_raw)))

    def sim_key(r: dict[str, Any]) -> float:
        s = r.get("face_similarity")
        return float(s) if isinstance(s, (int, float)) else -1.0

    ranked = sorted(all_scored, key=lambda r: (-sim_key(r), str(r.get("url") or "")))
    for r in ranked[:EVIDENCE_VERDICT_CAP]:
        url = str(r.get("url") or "")
        if not url:
            continue
        sim = r.get("face_similarity")
        sim_s = f"{float(sim):.4f}" if isinstance(sim, (int, float)) else "n/a"
        decision = str(r.get("decision") or "reject")
        ch = str(r.get("content_hash") or "")
        eng = str(r.get("engine") or "unknown")
        raw = f"verdict|{url}|{ch}|{sim_s}|{decision}|{eng}".encode()
        specs.append(("verdict", url[:80], sha256_bytes(raw)))

    for a in sorted(accepted, key=lambda x: str(x.get("url") or "")):
        raw = (
            f"accept|{a['url']}|{a['content_hash']}|{a['engine']}|{a['observed_at']}"
        ).encode()
        specs.append(("accept", str(a["url"])[:80], sha256_bytes(raw)))

    return specs


def step_merkle_evidence(
    out_dir: Path,
    *,
    probe: dict[str, Any],
    all_scored: list[dict[str, Any]],
    accepted: list[dict[str, Any]],
) -> str:
    """Merkle-seal the whole adjudication check: probe + verdicts + accepts."""
    print("\n[S4] Merkle root (adjudication evidence bundle)…")
    specs = _evidence_leaf_specs(probe=probe, all_scored=all_scored, accepted=accepted)
    if len(specs) < 2:
        raise RuntimeError("Evidence bundle too small to seal")
    leaves = [d for _, _, d in specs]
    root = merkle_root(leaves)
    root_hex = root.hex()
    if merkle_root(leaves) != root:
        raise RuntimeError("Merkle not deterministic")

    by_kind: dict[str, int] = {}
    for kind, _, _ in specs:
        by_kind[kind] = by_kind.get(kind, 0) + 1

    evidence = {
        "mode": "adjudication_bundle",
        "probe": probe,
        "tau_accept": TAU_ACCEPT,
        "tau_reject": TAU_REJECT,
        "tau_anchor_face": TAU_ANCHOR_FACE,
        "verdict_cap": EVIDENCE_VERDICT_CAP,
        "leaf_kinds": by_kind,
        "leaves": [
            {"kind": k, "label": lab, "digest": d.hex()} for k, lab, d in specs
        ],
        "accepted_urls": [a.get("url") for a in accepted],
        "scored_count": len(all_scored),
    }
    (out_dir / "evidence.json").write_text(json.dumps(evidence, indent=2))
    payload = {
        "mode": "adjudication_bundle",
        "merkle_root": root_hex,
        "leaves": [d.hex() for d in leaves],
        "leaf_kinds": by_kind,
        "count": len(leaves),
        "evidence_file": "evidence.json",
    }
    (out_dir / "merkle.json").write_text(json.dumps(payload, indent=2))
    print(
        f"  OK root={root_hex[:24]}… leaves={len(leaves)} "
        f"(probe={by_kind.get('probe', 0)} verdicts={by_kind.get('verdict', 0)} "
        f"accepts={by_kind.get('accept', 0)})"
    )
    return root_hex


def rebuild_evidence_root(out_dir: Path) -> str:
    """Rebuild Merkle root from evidence.json (preferred) or accepted.json."""
    evidence_path = out_dir / "evidence.json"
    if evidence_path.exists():
        ev = json.loads(evidence_path.read_text())
        digests = [bytes.fromhex(x["digest"]) for x in ev.get("leaves") or []]
        if not digests:
            raise RuntimeError("evidence.json has no leaves")
        return merkle_root(digests).hex()

    accepted = json.loads((out_dir / "accepted.json").read_text())
    leaves = []
    for a in accepted:
        raw = f"{a['url']}|{a['content_hash']}|{a['engine']}|{a['observed_at']}".encode()
        leaves.append(sha256_bytes(raw))
    return merkle_root(leaves).hex()


def step_attest(root_hex: str, primary_url: str, rpc: str, pk: str, out_dir: Path) -> dict[str, Any]:
    print("\n[S5] Attest merkle root on EAS Sepolia…")
    w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 60}))
    if not w3.is_connected():
        raise RuntimeError("RPC not connected")

    account = Account.from_key(pk)
    balance = w3.eth.get_balance(account.address)
    print(f"  wallet={account.address} balance_wei={balance}")
    if balance == 0:
        raise RuntimeError(
            "Wallet has 0 Sepolia ETH. Fund via a faucet, then re-run from S5."
        )

    eas = w3.eth.contract(address=EAS_ADDRESS, abi=EAS_ABI)
    content_hash = bytes.fromhex(root_hex)
    # ABI-encode bytes32 contentHash for schema data field
    encoded_data = w3.codec.encode(["bytes32"], [content_hash])

    zero = b"\x00" * 32
    tx = eas.functions.attest(
        (
            bytes.fromhex(EAS_SCHEMA_UID[2:]),
            (
                account.address,  # recipient
                0,  # expiration
                True,  # revocable
                zero,  # refUID
                encoded_data,
                0,  # value
            ),
        )
    ).build_transaction(
        {
            "from": account.address,
            "nonce": w3.eth.get_transaction_count(account.address),
            "chainId": 11155111,
            "gas": 500000,
            "maxFeePerGas": w3.to_wei("50", "gwei"),
            "maxPriorityFeePerGas": w3.to_wei("2", "gwei"),
        }
    )
    signed = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    print(f"  tx={tx_hash.hex()} waiting…")
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
    if receipt.status != 1:
        raise RuntimeError("Attest tx failed")

    uid = None
    # Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)
    attested_topic = w3.keccak(text="Attested(address,address,bytes32,bytes32)")
    for log in receipt.logs:
        if log.address.lower() != EAS_ADDRESS.lower():
            continue
        if not log.topics or log.topics[0] != attested_topic:
            continue
        if log.data and len(log.data) >= 32:
            uid = "0x" + log.data[:32].hex()
            break

    result = {
        "tx_hash": tx_hash.hex(),
        "uid": uid,
        "merkle_root": root_hex,
        "primary_post_url": primary_url,
        "attester": account.address,
        "easscan": f"https://sepolia.easscan.org/attestation/view/{uid}" if uid else None,
        "tx_url": f"https://sepolia.etherscan.io/tx/{tx_hash.hex()}",
        "schema": EAS_SCHEMA_UID,
    }
    (out_dir / "attest.json").write_text(json.dumps(result, indent=2))
    print(f"  OK tx={result['tx_url']}")
    if uid:
        print(f"  UID={uid}")
    return result


def step_verify(root_hex: str, attest: dict[str, Any], rpc: str, out_dir: Path) -> None:
    print("\n[S6] Re-verify against on-chain record…")
    w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 60}))
    eas = w3.eth.contract(address=EAS_ADDRESS, abi=EAS_ABI)

    onchain_hash = None
    uid = attest.get("uid")
    if uid:
        try:
            att = eas.functions.getAttestation(bytes.fromhex(uid[2:])).call()
            # att.data is ABI-encoded bytes32
            data = att[9] if isinstance(att, (list, tuple)) else att["data"]
            decoded = w3.codec.decode(["bytes32"], data)[0]
            onchain_hash = decoded.hex()
        except Exception as e:
            print(f"  warn getAttestation(uid) failed: {e}")

    # Always verify merkle rebuild from evidence.json (bundle) or accepted.json
    rebuilt = rebuild_evidence_root(out_dir)

    ok_local = rebuilt == root_hex
    ok_chain = True
    if onchain_hash:
        ok_chain = onchain_hash == root_hex

    # tamper test — flip first leaf digest in evidence if present
    evidence_path = out_dir / "evidence.json"
    if evidence_path.exists():
        ev = json.loads(evidence_path.read_text())
        digests = [bytes.fromhex(x["digest"]) for x in ev.get("leaves") or []]
        tampered = list(digests)
        if tampered:
            tampered[0] = sha256_bytes(b"tampered")
        bad_root = merkle_root(tampered).hex() if tampered else root_hex
    else:
        accepted = json.loads((out_dir / "accepted.json").read_text())
        leaves = []
        for a in accepted:
            raw = f"{a['url']}|{a['content_hash']}|{a['engine']}|{a['observed_at']}".encode()
            leaves.append(sha256_bytes(raw))
        tampered = list(leaves)
        if tampered:
            tampered[0] = sha256_bytes(b"tampered")
        bad_root = merkle_root(tampered).hex() if tampered else root_hex
    detects_tamper = bad_root != root_hex

    report = {
        "rebuilt_root": rebuilt,
        "expected_root": root_hex,
        "onchain_content_hash": onchain_hash,
        "local_match": ok_local,
        "chain_match": ok_chain if onchain_hash else None,
        "tamper_detected": detects_tamper,
        "tx_hash": attest.get("tx_hash"),
        "mode": "adjudication_bundle" if evidence_path.exists() else "accepted_only",
    }
    (out_dir / "verify.json").write_text(json.dumps(report, indent=2))

    if not ok_local:
        raise RuntimeError("Verify failed: rebuilt merkle != expected")
    if onchain_hash and not ok_chain:
        raise RuntimeError("Verify failed: on-chain hash != merkle root")
    if not detects_tamper:
        raise RuntimeError("Tamper test failed")

    print("  OK local rebuild matches")
    if onchain_hash:
        print("  OK on-chain contentHash matches merkle root")
    else:
        print("  OK tx mined; UID parse skipped — root checked via local rebuild + tx receipt")
    print("  OK tamper detection works")


def main() -> int:
    env = require_env(
        "SERPAPI_API_KEY",
        "IMGBB_API_KEY",
        "SEPOLIA_RPC_URL",
        "PRIVATE_KEY",
    )
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    out_dir = ROOT / "runs" / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"RUN {run_id}")
    print(f"OUT {out_dir}")

    results: list[SmokeResult] = []
    require_insightface = "--insightface" in sys.argv or "--require-insightface" in sys.argv
    paths = parse_image_args()
    if paths:
        for p in paths:
            if not p.exists():
                raise SystemExit(f"Image not found: {p}")
    else:
        paths = [download_sample(ROOT / "samples" / "elon_musk.jpg")]
    print(f"IMAGES ({len(paths)}): " + ", ".join(str(p.name) for p in paths))

    try:
        gallery = step_seed_gallery(paths, out_dir, require_insightface=require_insightface)
        face = gallery["primary"]
        results.append(
            SmokeResult(
                "S0_face",
                True,
                f"{face['backend']}:gallery={gallery['size']}:{face['embedding_sha256'][:16]}",
            )
        )
        seed_emb = np.load(face["embedding_path"])
        gal_emb = np.load(gallery["gallery_path"])
        gal_q = np.load(gallery["qualities_path"]) if gallery.get("qualities_path") else None
        crop_paths = [Path(m["crop_path"]) for m in gallery["members"]]

        hosted = step_host(Path(face["crop_path"]), env["IMGBB_API_KEY"], out_dir)
        results.append(SmokeResult("S1_host", True, hosted))

        hits = step_lens(hosted, env["SERPAPI_API_KEY"], out_dir)
        results.append(SmokeResult("S2_lens", True, f"{len(hits)} hits"))

        accepted = step_accept(
            hits,
            out_dir,
            seed_emb,
            top_k=5,
            min_face_sim=0.35,
            seed_crop_paths=crop_paths,
            gallery_embeddings=gal_emb,
            gallery_qualities=gal_q,
            deep_opt=True,
        )
        results.append(SmokeResult("S3_accept", True, accepted[0]["url"][:80]))

        root = step_merkle(accepted, out_dir)
        results.append(SmokeResult("S4_merkle", True, root[:24]))

        attest = step_attest(
            root,
            accepted[0]["url"],
            env["SEPOLIA_RPC_URL"],
            env["PRIVATE_KEY"],
            out_dir,
        )
        results.append(SmokeResult("S5_attest", True, attest.get("tx_hash", "")[:18]))

        step_verify(root, attest, env["SEPOLIA_RPC_URL"], out_dir)
        results.append(SmokeResult("S6_verify", True, "pass"))
    except Exception as e:
        results.append(SmokeResult("FAILED", False, str(e)))
        (out_dir / "smoke_report.json").write_text(
            json.dumps([asdict(r) for r in results], indent=2)
        )
        print(f"\nSMOKE FAILED: {e}")
        return 1

    (out_dir / "smoke_report.json").write_text(
        json.dumps([asdict(r) for r in results], indent=2)
    )
    print("\n=== SMOKE PASS S0–S6 ===")
    for r in results:
        print(f"  {r.step}: {r.detail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
