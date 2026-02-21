#!/usr/bin/env bash
# Download and extract JsDeObsBench dataset from Zenodo.
# Usage: bash scripts/bench-setup.sh
#
# Downloads ~121MB ZIP, verifies MD5, extracts to benchmarks/jsdeobsbench/.
# Idempotent: skips download if dataset already present.

set -euo pipefail

ZENODO_URL="https://zenodo.org/records/15511002/files/JsDeObsBench-main.zip?download=1"
EXPECTED_MD5="2e805505503e2c850d820f3d0d55cbd5"
BENCH_DIR="benchmarks"
EXTRACT_DIR="$BENCH_DIR/jsdeobsbench"
ZIP_FILE="$BENCH_DIR/JsDeObsBench-main.zip"

# Individual transformation datasets
TRANSFORMATIONS=(
  code-compact
  control-flow-flattening
  deadcode-injection
  debug-protection
  name-obfuscation
  self-defending
  string-obfuscation
)

# Check if already extracted
if [ -d "$EXTRACT_DIR/build_dataset" ]; then
  echo "Dataset already present at $EXTRACT_DIR/"
  echo ""
  echo "Available transformation datasets:"
  for t in "${TRANSFORMATIONS[@]}"; do
    dataset="$EXTRACT_DIR/build_dataset/codenet_dataset_$t/Project_CodeNet_selected.jsonl"
    if [ -f "$dataset" ]; then
      lines=$(wc -l < "$dataset")
      echo "  $t: $lines samples"
    else
      echo "  $t: NOT FOUND"
    fi
  done
  exit 0
fi

mkdir -p "$BENCH_DIR"

# Download
if [ ! -f "$ZIP_FILE" ]; then
  echo "Downloading JsDeObsBench dataset (~121MB)..."
  if command -v curl &>/dev/null; then
    curl -L -o "$ZIP_FILE" "$ZENODO_URL"
  elif command -v wget &>/dev/null; then
    wget -O "$ZIP_FILE" "$ZENODO_URL"
  else
    echo "Error: neither curl nor wget found" >&2
    exit 1
  fi
else
  echo "ZIP already downloaded: $ZIP_FILE"
fi

# Verify MD5
echo "Verifying MD5 checksum..."
if command -v md5sum &>/dev/null; then
  actual_md5=$(md5sum "$ZIP_FILE" | awk '{print $1}')
elif command -v md5 &>/dev/null; then
  actual_md5=$(md5 -q "$ZIP_FILE")
else
  echo "Warning: no md5sum or md5 command found, skipping checksum" >&2
  actual_md5="$EXPECTED_MD5"
fi

if [ "$actual_md5" != "$EXPECTED_MD5" ]; then
  echo "Error: MD5 mismatch" >&2
  echo "  Expected: $EXPECTED_MD5" >&2
  echo "  Got:      $actual_md5" >&2
  echo "  Deleting corrupted download." >&2
  rm -f "$ZIP_FILE"
  exit 1
fi
echo "MD5 OK: $actual_md5"

# Extract
echo "Extracting to $EXTRACT_DIR/..."
mkdir -p "$EXTRACT_DIR"
unzip -q -o "$ZIP_FILE" -d "$EXTRACT_DIR"

# The ZIP contains a top-level JsDeObsBench-main/ directory — flatten it
if [ -d "$EXTRACT_DIR/JsDeObsBench-main" ] && [ ! -d "$EXTRACT_DIR/build_dataset" ]; then
  mv "$EXTRACT_DIR/JsDeObsBench-main"/* "$EXTRACT_DIR/" 2>/dev/null || true
  mv "$EXTRACT_DIR/JsDeObsBench-main"/.* "$EXTRACT_DIR/" 2>/dev/null || true
  rmdir "$EXTRACT_DIR/JsDeObsBench-main" 2>/dev/null || true
fi

echo ""
echo "Available transformation datasets:"
for t in "${TRANSFORMATIONS[@]}"; do
  dataset="$EXTRACT_DIR/build_dataset/codenet_dataset_$t/Project_CodeNet_selected.jsonl"
  if [ -f "$dataset" ]; then
    lines=$(wc -l < "$dataset")
    echo "  $t: $lines samples"
  else
    echo "  $t: NOT FOUND"
  fi
done

echo ""
echo "Done. Run 'bash scripts/bench-run.sh' to benchmark."
