#!/bin/bash
# Quick local score estimation — computes decomplexity (halstead length reduction)
# without Docker. Uses batch-analyze.cjs for complexity metrics.
# Usage: bash scripts/quick-score.sh [transformation]

set -euo pipefail
cd "$(dirname "$0")/.."

RESULTS_DIR="benchmarks/results"
BATCH_ANALYZER="scripts/batch-analyze.cjs"

if [ ! -f "$BATCH_ANALYZER" ]; then
  echo "ERROR: batch-analyze.cjs not found" >&2
  exit 1
fi

transformations=("code-compact" "control-flow-flattening" "deadcode-injection" "debug-protection" "name-obfuscation" "self-defending" "string-obfuscation")

if [ $# -ge 1 ]; then
  transformations=("$1")
fi

printf "\n%-30s %10s %10s %8s\n" "Transformation" "Syntax%" "Decomplex%" "Samples"
printf "%-30s %10s %10s %8s\n" "------------------------------" "----------" "----------" "--------"

total_syntax=0
total_decomplex=0
count=0

for t in "${transformations[@]}"; do
  f="${RESULTS_DIR}/codenet_javascript-obfuscator_${t}/deobfuscate-js.jsonl"
  if [ ! -f "$f" ]; then
    printf "%-30s %10s\n" "$t" "no results"
    continue
  fi

  # Run batch analyzer and compute metrics
  eval $(node "$BATCH_ANALYZER" "$f" 2>/dev/null | node -e "
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin });
    let syntaxPass = 0, total = 0, halstSum = 0, halstCount = 0;
    rl.on('line', line => {
      const r = JSON.parse(line);
      if (!r.ori_valid || !r.obf_valid) return;
      total++;
      if (r.syntax_valid) {
        syntaxPass++;
        if (r.obf_metrics && r.deobf_metrics && r.obf_metrics.halstead_length > 0) {
          halstSum += 1 - r.deobf_metrics.halstead_length / r.obf_metrics.halstead_length;
          halstCount++;
        }
      }
    });
    rl.on('close', () => {
      const syntax = total > 0 ? (syntaxPass / total * 100).toFixed(2) : '0.00';
      const decomplex = halstCount > 0 ? (halstSum / halstCount * 100).toFixed(2) : '0.00';
      console.log('syntax=' + syntax + ' decomplex=' + decomplex + ' samples=' + total);
    });
  ")

  printf "%-30s %9s%% %9s%% %8s\n" "$t" "$syntax" "$decomplex" "$samples"

  total_syntax=$(echo "$total_syntax + $syntax" | bc)
  total_decomplex=$(echo "$total_decomplex + $decomplex" | bc)
  count=$((count + 1))
done

if [ $count -gt 0 ]; then
  avg_syntax=$(echo "scale=2; $total_syntax / $count" | bc)
  avg_decomplex=$(echo "scale=2; $total_decomplex / $count" | bc)
  printf "%-30s %10s %10s\n" "------------------------------" "----------" "----------"
  printf "%-30s %9s%% %9s%%\n" "AVERAGE" "$avg_syntax" "$avg_decomplex"
fi

echo ""
echo "Note: This shows syntax + decomplexity only. For full scoring (exe, codebleu), use official eval."
