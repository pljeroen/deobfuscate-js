/**
 * De-obfuscation pipeline — runs a sequence of passes over the source code.
 */

import { DeobfuscationPass } from "./types.js";

export function runPipeline(source: string, passes: DeobfuscationPass[]): string {
  let result = source;
  for (const pass of passes) {
    result = pass.run(result);
  }
  return result;
}
