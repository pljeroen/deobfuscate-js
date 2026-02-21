#!/usr/bin/env bash
# Run deobfuscate-js against JsDeObsBench transformation datasets.
# Usage: bash scripts/bench-run.sh [--combinations] [--unsafe] [--transformation <name>]
#
# Outputs results to benchmarks/results/codenet_javascript-obfuscator_{config}/deobfuscate-js.jsonl
# Compatible with JsDeObsBench eval.py.

set -euo pipefail

BENCH_DIR="benchmarks"
DATASET_DIR="$BENCH_DIR/jsdeobsbench/build_dataset"
RESULTS_DIR="$BENCH_DIR/results"
ADAPTER="npx tsx scripts/bench-jsdeobsbench.ts"

# Individual transformations (7)
TRANSFORMATIONS=(
  code-compact
  control-flow-flattening
  deadcode-injection
  debug-protection
  name-obfuscation
  self-defending
  string-obfuscation
)

# Parse args
run_combinations=false
unsafe_flag=""
single_transformation=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --combinations) run_combinations=true; shift ;;
    --unsafe) unsafe_flag="--unsafe"; shift ;;
    --transformation) single_transformation="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# Verify dataset exists
if [ ! -d "$DATASET_DIR" ]; then
  echo "Error: dataset not found at $DATASET_DIR" >&2
  echo "Run 'bash scripts/bench-setup.sh' first." >&2
  exit 1
fi

# Build list of transformations to run
if [ -n "$single_transformation" ]; then
  targets=("$single_transformation")
else
  targets=("${TRANSFORMATIONS[@]}")
fi

total_samples=0
total_failures=0
summary_lines=()

for t in "${targets[@]}"; do
  input="$DATASET_DIR/codenet_dataset_$t/Project_CodeNet_selected.jsonl"
  if [ ! -f "$input" ]; then
    echo "Warning: dataset not found for $t, skipping" >&2
    continue
  fi

  output_dir="$RESULTS_DIR/codenet_javascript-obfuscator_$t"
  mkdir -p "$output_dir"
  output="$output_dir/deobfuscate-js.jsonl"

  if [ -f "$output" ]; then
    echo "[$t] Already exists: $output (skipping, delete to re-run)"
    continue
  fi

  samples=$(wc -l < "$input")
  echo "[$t] Running on $samples samples..."

  $ADAPTER --input "$input" --output "$output" $unsafe_flag 2>&1

  # Count failures in output (records with empty deobfuscated field)
  failures=$(grep -c '"deobfuscated":""' "$output" 2>/dev/null || echo "0")

  total_samples=$((total_samples + samples))
  total_failures=$((total_failures + failures))
  summary_lines+=("  $t: $samples samples, $failures failures ($(( (failures * 100) / (samples > 0 ? samples : 1) ))%)")

  echo ""
done

# Combinations (C77-0 = all 7 combined)
if [ "$run_combinations" = true ]; then
  combo_input="$DATASET_DIR/codenet_dataset_combinations/C77-0/Project_CodeNet_selected.jsonl"
  if [ -f "$combo_input" ]; then
    output_dir="$RESULTS_DIR/codenet_javascript-obfuscator_combinations/C77-0"
    mkdir -p "$output_dir"
    output="$output_dir/deobfuscate-js.jsonl"

    if [ -f "$output" ]; then
      echo "[C77-0] Already exists: $output (skipping)"
    else
      samples=$(wc -l < "$combo_input")
      echo "[C77-0] Running on $samples samples (all 7 combined)..."

      $ADAPTER --input "$combo_input" --output "$output" $unsafe_flag 2>&1

      failures=$(grep -c '"deobfuscated":""' "$output" 2>/dev/null || echo "0")

      total_samples=$((total_samples + samples))
      total_failures=$((total_failures + failures))
      summary_lines+=("  C77-0 (all combined): $samples samples, $failures failures ($(( (failures * 100) / (samples > 0 ? samples : 1) ))%)")

      echo ""
    fi
  else
    echo "Warning: C77-0 dataset not found at $combo_input" >&2
  fi
fi

echo "===== Summary ====="
echo "Total: $total_samples samples, $total_failures failures"
for line in "${summary_lines[@]}"; do
  echo "$line"
done
echo ""
echo "Results in: $RESULTS_DIR/"
echo "Run JsDeObsBench eval.py to compute metrics (syntax, execution, decomplexity, similarity)."
