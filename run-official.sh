#!/usr/bin/env bash
# Full official benchmark: setup → run → evaluate
# Usage: bash run-official.sh
set -euo pipefail

echo "=== Step 1: Dataset setup ==="
bash scripts/bench-setup.sh

echo ""
echo "=== Step 2: Benchmark run (--unsafe for string-array resolution) ==="
bash scripts/bench-run.sh --unsafe

echo ""
echo "=== Step 3: Evaluation ==="
python3 scripts/bench-eval.py --all

echo ""
echo "=== Done ==="
echo "Results above. Compare with leaderboard at https://jsdeobf.github.io/"
