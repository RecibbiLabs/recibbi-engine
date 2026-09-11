#!/usr/bin/env python3
"""Download a complete PaddleOCR-VL-1.6 offline bundle.

Replicated from ../codex-receipt-ocr-paddleocr-downloads/download-paddleocr-vl-1.6.py
and extended with SHA-256 integrity: after building the portable tarball it
writes a SHA256SUMS.txt next to it covering the tarball, and `--verify` re-checks
an existing tarball against that file — matching the integrity model of the
codex `paddleocr-vl-1.6-full-snapshot.tar.gz` distribution.

The official PaddleOCR-VL pipeline is not a single model directory. It uses:

- PaddleOCR-VL-1.6-0.9B for vision-language recognition
- PP-DocLayoutV3 for layout detection
- PP-LCNet_x1_0_doc_ori for document orientation classification
- UVDoc for document unwarping

The VLM is hosted on Hugging Face. The auxiliary PaddleX models are resolved
from ModelScope using the same repository names PaddleX attempts to download
at runtime.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess  # nosec
import sys
from pathlib import Path


VLM_REPO_ID = "PaddlePaddle/PaddleOCR-VL-1.6"
VLM_DIR_NAME = "PaddleOCR-VL-1.6-0.9B"
AUX_MODELS = [
    {
        "name": "PP-DocLayoutV3",
        "repo_id": "PaddlePaddle/PP-DocLayoutV3",
        "role": "layout_detection",
    },
    {
        "name": "PP-LCNet_x1_0_doc_ori",
        "repo_id": "PaddlePaddle/PP-LCNet_x1_0_doc_ori",
        "role": "doc_orientation_classify",
    },
    {
        "name": "UVDoc",
        "repo_id": "PaddlePaddle/UVDoc",
        "role": "doc_unwarping",
    },
]


def run(cmd: list[str]) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, shell=False)


def ensure_package(import_name: str, pip_name: str) -> None:
    try:
        __import__(import_name)
    except ImportError:
        run([sys.executable, "-m", "pip", "install", "-U", pip_name])


def remove_if_requested(path: Path, force: bool) -> None:
    if not path.exists():
        return
    if not force:
        raise SystemExit(f"{path} already exists. Pass --force to replace it.")
    shutil.rmtree(path)


def assert_file(path: Path) -> None:
    if not path.exists():
        raise SystemExit(f"Expected file is missing: {path}")


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_tarball_sha256sums(tarball: Path) -> str:
    """Write a `shasum -a 256 -c`-compatible SHA256SUMS.txt next to the tarball."""
    digest = sha256_of(tarball)
    sums_path = tarball.parent / "SHA256SUMS.txt"
    with open(sums_path, "w", encoding="utf-8") as handle:
        handle.write(f"{digest}  {tarball.name}\n")
    print(f"Wrote {sums_path}")
    print(f"  sha256 {digest}")
    print(f"  verify: (cd {tarball.parent} && shasum -a 256 -c SHA256SUMS.txt)")
    return digest


def verify_tarball(tarball: Path) -> int:
    """Re-check an existing tarball against its sibling SHA256SUMS.txt entry."""
    sums_path = tarball.parent / "SHA256SUMS.txt"
    if not sums_path.exists():
        raise SystemExit(f"No SHA256SUMS.txt next to {tarball}")
    if not tarball.exists():
        raise SystemExit(f"Tarball missing: {tarball}")
    want = None
    with open(sums_path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            digest, _, name = line.partition("  ")
            if name == tarball.name:
                want = digest
                break
    if want is None:
        raise SystemExit(f"{tarball.name} not listed in {sums_path}")
    got = sha256_of(tarball)
    if got != want:
        print(f"CHECKSUM MISMATCH for {tarball.name}")
        print(f"  expected {want}")
        print(f"  got      {got}")
        return 1
    print(f"OK  {tarball.name}  (sha256 {got[:12]}…)")
    return 0


def download_huggingface_snapshot(out_dir: Path, revision: str) -> None:
    ensure_package("huggingface_hub", "huggingface_hub")
    from huggingface_hub import snapshot_download

    token = os.environ.get("HF_TOKEN") or None
    snapshot_download(
        repo_id=VLM_REPO_ID,
        revision=revision,
        local_dir=str(out_dir),
        local_dir_use_symlinks=False,
        token=token,
        resume_download=True,
    )

    assert_file(out_dir / "config.json")
    assert_file(out_dir / "model.safetensors")


def download_modelscope_snapshot(repo_id: str, out_dir: Path, revision: str) -> None:
    ensure_package("modelscope", "modelscope")
    from modelscope.hub.snapshot_download import snapshot_download

    token = os.environ.get("MODELSCOPE_TOKEN") or None
    snapshot_download(
        model_id=repo_id,
        revision=revision,
        local_dir=str(out_dir),
        token=token,
    )

    contents = [path.name for path in out_dir.iterdir()] if out_dir.exists() else []
    if not contents:
        raise SystemExit(f"ModelScope snapshot for {repo_id} produced an empty directory: {out_dir}")


def write_manifest(bundle_dir: Path, revision: str, aux_revision: str) -> None:
    manifest = {
        "bundle": "paddleocr-vl-1.6-full",
        "vlm": {
            "repo_id": VLM_REPO_ID,
            "revision": revision,
            "path": VLM_DIR_NAME,
        },
        "auxiliary_models": [
            {
                "name": model["name"],
                "repo_id": model["repo_id"],
                "revision": aux_revision,
                "role": model["role"],
                "path": model["name"],
            }
            for model in AUX_MODELS
        ],
        "runtime_env": {
            "PADDLEOCR_VL_MODEL_DIR": str(bundle_dir),
            "PADDLEOCR_VL_PIPELINE_VERSION": "v1.6",
            "PADDLEOCR_VL_USE_LAYOUT_DETECTION": "1",
            "PADDLEOCR_VL_USE_DOC_ORIENTATION_CLASSIFY": "1",
            "PADDLEOCR_VL_USE_DOC_UNWARPING": "1",
            "PADDLEOCR_VL_PROMPT_LABEL": "auto",
            "PADDLEOCR_VL_MAX_PIXELS": "auto",
            "PADDLEOCR_VL_MIN_PIXELS": "auto",
            "PADDLEOCR_VL_MAX_NEW_TOKENS": "auto",
        },
    }
    with open(bundle_dir / "bundle-manifest.json", "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, ensure_ascii=True)
        handle.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Download PaddleOCR-VL-1.6 plus auxiliary PaddleX models and package a portable tarball."
    )
    parser.add_argument("--out-dir", default="paddleocr-vl-1.6-full-snapshot")
    parser.add_argument("--revision", default="main", help="Hugging Face VLM revision")
    parser.add_argument("--aux-revision", default="master", help="ModelScope auxiliary model revision")
    parser.add_argument("--tarball", default="paddleocr-vl-1.6-full-snapshot.tar.gz")
    parser.add_argument("--force", action="store_true", help="Replace an existing output directory before download")
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Verify an existing --tarball against its sibling SHA256SUMS.txt and exit (no download).",
    )
    args = parser.parse_args()

    if args.verify:
        return verify_tarball(Path(args.tarball).resolve())

    bundle_dir = Path(args.out_dir).resolve()
    remove_if_requested(bundle_dir, args.force)
    bundle_dir.mkdir(parents=True, exist_ok=True)

    vlm_dir = bundle_dir / VLM_DIR_NAME
    print(f"Downloading VLM {VLM_REPO_ID} -> {vlm_dir}")
    download_huggingface_snapshot(vlm_dir, args.revision)

    for model in AUX_MODELS:
        target_dir = bundle_dir / model["name"]
        print(f"Downloading {model['repo_id']} -> {target_dir}")
        download_modelscope_snapshot(model["repo_id"], target_dir, args.aux_revision)

    write_manifest(bundle_dir, args.revision, args.aux_revision)

    tarball = Path(args.tarball).resolve()
    if tarball.exists() and not args.force:
        raise SystemExit(f"{tarball} already exists. Pass --force to replace it.")
    if tarball.exists():
        tarball.unlink()
    run(["tar", "-C", str(bundle_dir.parent), "-czf", str(tarball), bundle_dir.name])
    print(f"Created {tarball}")
    write_tarball_sha256sums(tarball)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
