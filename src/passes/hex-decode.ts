/**
 * Hex/unicode string decoding pass — replaces encoded escape sequences
 * in string literals with their decoded equivalents.
 *
 * Handles: \xHH, \uHHHH, \u{HHHH} escape sequences.
 * Preserves: \n, \t, \r, \\, \', \" and other standard escapes.
 */

import { traverse } from "../babel.js";
import type { File } from "@babel/types";
import type { ASTPass } from "../types.js";

const HEX_ESCAPE = /\\x[0-9a-fA-F]{2}/;
const UNICODE_ESCAPE = /\\u[0-9a-fA-F]{4}/;
const UNICODE_CODEPOINT_ESCAPE = /\\u\{[0-9a-fA-F]+\}/;

export const hexDecodePass: ASTPass = {
  name: "hex-decode",
  description: "Decode hex and unicode escape sequences in string literals",

  run(ast: File): File {
    traverse(ast, {
      StringLiteral(path) {
        const raw = path.node.extra?.raw as string | undefined;
        if (!raw) return;

        // Check if the raw string contains hex/unicode escapes
        if (!HEX_ESCAPE.test(raw) && !UNICODE_ESCAPE.test(raw) && !UNICODE_CODEPOINT_ESCAPE.test(raw)) {
          return;
        }

        // The node.value already has escapes resolved by the parser.
        // We just need to ensure the generator outputs the decoded form.
        // Remove extra.raw so Babel regenerates from the decoded value.
        delete path.node.extra;
      },
    });

    return ast;
  },
};
