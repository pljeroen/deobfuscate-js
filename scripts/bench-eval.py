#!/usr/bin/env python3
"""
Evaluate deobfuscate-js results against JsDeObsBench metrics.

Computes: Syntax pass rate, Execution pass rate, Decomplexity, CodeBLEU.
Phase 1 (Node.js batch): syntax validation + complexity metrics (fast, in-process).
Phase 2 (Python): execution tests + CodeBLEU scoring.

Usage: python3 scripts/bench-eval.py [--transformation <name>] [--all]
"""

import json
import subprocess
import sys
import os
import tempfile
from collections import defaultdict
from pathlib import Path

BENCH_DIR = Path("benchmarks")
RESULTS_DIR = BENCH_DIR / "results"
SCRIPTS_DIR = Path("scripts")
BATCH_ANALYZER = SCRIPTS_DIR / "batch-analyze.cjs"

TRANSFORMATIONS = [
    "code-compact",
    "control-flow-flattening",
    "deadcode-injection",
    "debug-protection",
    "name-obfuscation",
    "self-defending",
    "string-obfuscation",
]


def run_execution_test(code: str, test_cases: list, timeout: int = 2) -> bool:
    """Run code with test cases using Node.js directly. Returns True if all pass."""
    if not code or not code.strip() or not test_cases:
        return False

    for stdin_input, expected_output in test_cases:
        try:
            with tempfile.NamedTemporaryFile(mode="w", suffix=".js", delete=False) as f:
                f.write(code)
                tmp_path = f.name
            try:
                r = subprocess.run(
                    ["node", tmp_path],
                    input=stdin_input,
                    capture_output=True,
                    text=True,
                    timeout=timeout,
                )
                if r.returncode != 0:
                    return False
                if r.stdout.strip() != expected_output.strip():
                    return False
            finally:
                os.unlink(tmp_path)
        except subprocess.TimeoutExpired:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
            return False
        except Exception:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
            return False
    return True


def calc_codebleu_score(reference: str, prediction: str) -> float:
    """Calculate CodeBLEU score between reference and prediction."""
    try:
        from codebleu import calc_codebleu
        result = calc_codebleu(
            references=[reference],
            predictions=[prediction],
            lang="javascript",
            weights=(0.25, 0.25, 0.25, 0.25),
        )
        return result["codebleu"]
    except Exception:
        return 0.0


def evaluate_transformation(transformation: str) -> dict | None:
    """Evaluate results for a single transformation."""
    results_file = RESULTS_DIR / f"codenet_javascript-obfuscator_{transformation}" / "deobfuscate-js.jsonl"
    if not results_file.exists():
        print(f"  [{transformation}] No results file, skipping", file=sys.stderr)
        return None

    # Phase 1: Run batch Node.js analyzer for syntax + complexity
    print(f"  [{transformation}] Phase 1: syntax + complexity (Node.js batch)", file=sys.stderr)
    try:
        proc = subprocess.run(
            ["node", str(BATCH_ANALYZER), str(results_file)],
            capture_output=True, text=True, timeout=600,
        )
    except subprocess.TimeoutExpired:
        print(f"  [{transformation}] Batch analyzer timed out", file=sys.stderr)
        return None

    if proc.returncode != 0:
        print(f"  [{transformation}] Batch analyzer failed: {proc.stderr[:200]}", file=sys.stderr)
        return None

    if proc.stderr:
        for line in proc.stderr.strip().split('\n'):
            print(f"  [{transformation}] {line.strip()}", file=sys.stderr)

    # Parse batch results
    analysis = []
    for line in proc.stdout.strip().split('\n'):
        if line.strip():
            analysis.append(json.loads(line))

    # Load original records for execution tests + CodeBLEU
    records = []
    with open(results_file) as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))

    # Phase 2: Execution tests + CodeBLEU
    print(f"  [{transformation}] Phase 2: execution + CodeBLEU", file=sys.stderr)

    # Filter to records where original and obfuscated are both valid
    valid_indices = []
    for a in analysis:
        if a["ori_valid"] and a["obf_valid"]:
            valid_indices.append(a["idx"])

    total = len(valid_indices)
    if total == 0:
        return None

    syntax_pass = 0
    exe_pass = 0
    codebleu_sum = 0.0
    halstead_len_sum = 0.0
    complexity_count = 0

    for count, idx in enumerate(valid_indices):
        a = analysis[idx]
        r = records[idx]

        if a["syntax_valid"]:
            syntax_pass += 1
        else:
            continue

        # Execution test (Python subprocess — handles /dev/stdin correctly)
        deobfuscated = r.get("deobfuscated", "")
        test_cases = r.get("test_cases", [])
        if test_cases and run_execution_test(deobfuscated, test_cases):
            exe_pass += 1

        # CodeBLEU
        original = r.get("original", "")
        codebleu_sum += calc_codebleu_score(original, deobfuscated)

        # Complexity: decrease_halstead_len
        obf_m = a["obf_metrics"]
        deobf_m = a["deobf_metrics"]
        if obf_m and deobf_m and obf_m["halstead_length"] > 0:
            halstead_len_sum += 1 - deobf_m["halstead_length"] / obf_m["halstead_length"]
            complexity_count += 1

        if (count + 1) % 100 == 0 or count + 1 == total:
            print(f"  [{transformation}] {count+1}/{total} evaluated", file=sys.stderr)

    syntax_rate = syntax_pass / total * 100
    exe_rate = (exe_pass / syntax_pass * 100) if syntax_pass > 0 else 0
    codebleu_avg = (codebleu_sum / syntax_pass * 100) if syntax_pass > 0 else 0
    decomplex_avg = (halstead_len_sum / complexity_count * 100) if complexity_count > 0 else 0
    overall = (syntax_rate + exe_rate + decomplex_avg + codebleu_avg) / 4

    return {
        "transformation": transformation,
        "total": total,
        "syntax_pass": syntax_pass,
        "syntax_rate": round(syntax_rate, 2),
        "exe_rate": round(exe_rate, 2),
        "decomplexity": round(decomplex_avg, 2),
        "codebleu": round(codebleu_avg, 2),
        "overall": round(overall, 2),
    }


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Evaluate JsDeObsBench results")
    parser.add_argument("--transformation", "-t", help="Single transformation to evaluate")
    parser.add_argument("--all", "-a", action="store_true", help="Evaluate all transformations")
    args = parser.parse_args()

    if args.transformation:
        targets = [args.transformation]
    elif args.all:
        targets = TRANSFORMATIONS
    else:
        targets = TRANSFORMATIONS

    results = []
    for t in targets:
        print(f"\nEvaluating: {t}", file=sys.stderr)
        r = evaluate_transformation(t)
        if r:
            results.append(r)

    if not results:
        print("No results to report.")
        return

    # Print summary table
    print("\n" + "=" * 80)
    print(f"{'Transformation':<30} {'Syntax':>8} {'Exe':>8} {'Decomplex':>10} {'CodeBLEU':>10} {'Overall':>8}")
    print("-" * 80)

    totals = defaultdict(float)
    for r in results:
        print(f"{r['transformation']:<30} {r['syntax_rate']:>7.1f}% {r['exe_rate']:>7.1f}% {r['decomplexity']:>9.1f}% {r['codebleu']:>9.1f}% {r['overall']:>7.1f}%")
        totals["syntax"] += r["syntax_rate"]
        totals["exe"] += r["exe_rate"]
        totals["decomplex"] += r["decomplexity"]
        totals["codebleu"] += r["codebleu"]
        totals["overall"] += r["overall"]

    n = len(results)
    print("-" * 80)
    print(f"{'AVERAGE':<30} {totals['syntax']/n:>7.1f}% {totals['exe']/n:>7.1f}% {totals['decomplex']/n:>9.1f}% {totals['codebleu']/n:>9.1f}% {totals['overall']/n:>7.1f}%")
    print("=" * 80)

    # Print comparison with known leaderboard entries
    print("\n--- Leaderboard Comparison (Single Transformations, Overall) ---")
    leaderboard = [
        ("deepseek-chat-20250301", 75.17),
        ("webcrack", 73.99),
        ("GPT-4o", 73.67),
        ("Qwen2.5-Coder-32B", 70.02),
        ("Synchrony", 66.28),
        ("JS-deobfuscator", 58.83),
        ("Mistral-7B", 49.12),
    ]
    our_overall = totals["overall"] / n
    inserted = False
    for name, score in leaderboard:
        if not inserted and our_overall >= score:
            print(f"  >>> deobfuscate-js: {our_overall:.2f}% <<<")
            inserted = True
        print(f"      {name}: {score:.2f}%")
    if not inserted:
        print(f"  >>> deobfuscate-js: {our_overall:.2f}% <<<")


if __name__ == "__main__":
    main()
