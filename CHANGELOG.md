# Changelog

## [Unreleased]

### Added
- String array resolution pass: detects and resolves javascript-obfuscator's
  string array obfuscation (array + rotation IIFE + decoder function)
- Process-isolated sandbox execution for safe decoder function evaluation
- Support for rotation with offset, base64 encoding, self-overwriting decoders,
  and custom decoding logic
- Control flow object inlining pass: detects and inlines javascript-obfuscator's
  control flow storage objects (binary/logical proxy functions, call delegation,
  string literals)
- Support for transformObjectKeys pattern (empty object + sequential assignments)
- 44 new tests for string array + control flow passes (238 total)

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
