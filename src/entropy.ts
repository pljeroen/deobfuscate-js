/**
 * Shannon entropy calculator for JavaScript identifier distributions.
 * Measures the information content of identifier names in an AST.
 * Higher entropy = more diverse/random names (typical of obfuscation).
 * Lower entropy = more repetitive/readable names.
 */

import type { File } from "@babel/types";
import { traverse } from "./babel.js";

/**
 * Compute Shannon entropy of identifier name frequencies in an AST.
 * Returns entropy in bits: 0 = single unique name, log2(N) = all names equally frequent.
 */
export function identifierEntropy(ast: File): number {
  const freq = new Map<string, number>();
  let total = 0;

  traverse(ast, {
    Identifier(path) {
      const name = path.node.name;
      freq.set(name, (freq.get(name) ?? 0) + 1);
      total++;
    },
  });

  if (total === 0 || freq.size <= 1) return 0;

  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / total;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  return entropy;
}
