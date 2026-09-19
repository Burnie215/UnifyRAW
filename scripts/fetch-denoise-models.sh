#!/usr/bin/env bash
# Fetch AI-denoise ONNX model weights into public/models/denoise/.
# Models are gitignored; run this once after clone, and once per CI build.
# Each file's SHA-256 is verified against the registry in
# src/engine/ai/denoise/modelStore.ts.
set -euo pipefail

DEST="$(dirname "$0")/../public/models/denoise"
mkdir -p "$DEST"

declare -a MODELS=(
  # filename                       sha256                                                              url
  "scunet-psnr.v1.onnx             b0f8c12f1575bb49e39a85924152f1c6d4b527a4aae0432c9e5c7397123465e3    https://huggingface.co/deepghs/image_restoration/resolve/main/SCUNet-PSNR.onnx"
)

for entry in "${MODELS[@]}"; do
  read -r name sha url <<<"$entry"
  out="$DEST/$name"
  if [[ -f "$out" ]]; then
    actual="$(sha256sum "$out" | awk '{print $1}')"
    if [[ "$actual" == "$sha" ]]; then
      echo "[ok]   $name (cached)"
      continue
    fi
    echo "[warn] $name exists with wrong hash, re-downloading"
    rm -f "$out"
  fi
  echo "[get]  $name <- $url"
  curl -fL --progress-bar -o "$out" "$url?download=true"
  actual="$(sha256sum "$out" | awk '{print $1}')"
  if [[ "$actual" != "$sha" ]]; then
    echo "[fail] $name hash mismatch: expected $sha, got $actual" >&2
    exit 1
  fi
  echo "[ok]   $name"
done

echo "All models ready in $DEST"
