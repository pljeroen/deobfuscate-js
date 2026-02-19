# Changelog

## [Unreleased]

### Added
- Control flow object inlining pass: detects and inlines javascript-obfuscator's
  control flow storage objects (binary/logical proxy functions, call delegation,
  string literals)
- Support for transformObjectKeys pattern (empty object + sequential assignments)
- 22 new tests for control flow object inlining (216 total)

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
