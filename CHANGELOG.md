# Changelog

## [Unreleased]

### Added
- Iterative convergence pipeline: AST passes repeat until output stabilizes
  or max iterations reached (fixpoint detection via string comparison)
- Obfuscator fingerprinting: pattern-based detection of javascript-obfuscator
  (hex identifiers, string array + decoder, control flow flattening)
- Semantic variable renaming: context-aware naming for obfuscated variables
  (loop counters → i/j/k, .length → len, error-first callbacks → err)
- Safe/unsafe pass classification: `safety` field on ASTPass interface,
  `filterSafePasses()` utility, stringArrayPass marked as unsafe
- Multi-parser fallback: errorRecovery + sourceType fallback + line truncation
  for malformed JavaScript input
- Control flow unflattening pass: reconstructs linear control flow from
  while/switch dispatch pattern (javascript-obfuscator's controlFlowFlattening)
- Bundler unpacking pass: detects and extracts modules from webpack 4/5
  and browserify bundles
- String array resolution pass: detects and resolves javascript-obfuscator's
  string array obfuscation (array + rotation IIFE + decoder function)
- Process-isolated sandbox execution for safe decoder function evaluation
- Support for rotation with offset, base64 encoding, self-overwriting decoders,
  and custom decoding logic
- Control flow object inlining pass: detects and inlines javascript-obfuscator's
  control flow storage objects (binary/logical proxy functions, call delegation,
  string literals)
- Support for transformObjectKeys pattern (empty object + sequential assignments)
- 24 new tests for pipeline intelligence (281 total)

## [0.2.0] - 2026-02-19

### Added
- AST-based deobfuscation pipeline using Babel
- Constant folding pass (arithmetic, string concat, boolean, typeof, void 0)
- Constant propagation pass (single-assignment literal inlining)
- Dead code elimination pass (unreachable branches, unused variables)
- Hex/unicode string decoding pass
- AST simplification pass (comma splitting, computed-to-dot member access)
- Scope-aware renaming pass (Babel scope analysis)
- Dual-mode pipeline (AST transforms + token-level formatting)

## [0.1.0] - 2026-02-19

### Added
- Token-level JavaScript deobfuscation toolkit
- Custom tokenizer (from-scratch JS lexer)
- Format pass (indentation, spacing, line breaks)
- Simplify pass (token-level)
- Rename pass (token-level)
- CLI entry point
