#!/usr/bin/env node
/**
 * Batch complexity analyzer for JsDeObsBench evaluation.
 * Processes all records in a JSONL file in-process (no subprocess overhead).
 * Outputs pre-computed metrics as JSONL to stdout.
 */

const fs = require('fs');
const path = require('path');

const ESCOMPLEX_DIR = path.join(__dirname, '..', 'benchmarks', 'jsdeobsbench', 'evaluators', 'escomplex');
const escomplex = require(path.join(ESCOMPLEX_DIR, 'src', 'index'));
const defaultOpts = require(path.join(ESCOMPLEX_DIR, 'src', 'config')).parserOptions;
defaultOpts.sourceType = 'module';
const typhonjs = require(path.join(ESCOMPLEX_DIR, 'node_modules', 'typhonjs-escomplex'));

function analyzeCode(code) {
  if (!code || !code.trim()) return null;
  try {
    const r1 = escomplex.analyse(code, defaultOpts);
    const r2 = typhonjs.analyzeModule(code);
    return {
      logical_loc: r1.aggregate.sloc.logical,
      maintainability: r1.maintainability,
      cyclomatic: r2.aggregate.cyclomatic,
      halstead_length: r2.aggregate.halstead.length,
      halstead_effort: r2.aggregate.halstead.effort,
    };
  } catch (e) {
    return null;
  }
}

// Main — syntax + complexity analysis only (execution tests done in Python)
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: node batch-analyze.cjs <input.jsonl>');
  process.exit(1);
}

const inputFile = args[0];
const lines = fs.readFileSync(inputFile, 'utf8').split('\n').filter(l => l.trim());
const total = lines.length;

for (let i = 0; i < total; i++) {
  const record = JSON.parse(lines[i]);
  const original = record.original || '';
  const obfuscated = record.obfuscated || '';
  const deobfuscated = record.deobfuscated || '';

  const oriMetrics = analyzeCode(original);
  const obfMetrics = analyzeCode(obfuscated);
  const deobfMetrics = analyzeCode(deobfuscated);

  const out = {
    idx: i,
    ori_valid: oriMetrics !== null,
    obf_valid: obfMetrics !== null,
    syntax_valid: deobfMetrics !== null,
    ori_metrics: oriMetrics,
    obf_metrics: obfMetrics,
    deobf_metrics: deobfMetrics,
  };

  process.stdout.write(JSON.stringify(out) + '\n');

  if ((i + 1) % 50 === 0 || i + 1 === total) {
    process.stderr.write(`  ${i + 1}/${total} analyzed\n`);
  }
}
