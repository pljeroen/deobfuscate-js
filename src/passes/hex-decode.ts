/**
 * Hex/unicode decoding pass — normalizes encoded representations to readable form.
 *
 * Strings: \xHH, \uHHHH, \u{HHHH} escape sequences → decoded characters.
 * Numbers: 0xFF hex literals → 255 decimal form.
 * Preserves: \n, \t, \r, \\, \', \" and other standard escapes.
 */

import { traverse } from "../babel.js";
import type { File } from "@babel/types";
import type { ASTPass } from "../types.js";

const HEX_ESCAPE = /\\x[0-9a-fA-F]{2}/;
const UNICODE_ESCAPE = /\\u[0-9a-fA-F]{4}/;
const UNICODE_CODEPOINT_ESCAPE = /\\u\{[0-9a-fA-F]+\}/;
const HEX_NUMERIC = /^0[xX]/;

export const hexDecodePass: ASTPass = {
  name: "hex-decode",
  description: "Decode hex and unicode escape sequences in strings and numeric literals",

  run(ast: File): File {
    traverse(ast, {
      StringLiteral(path) {
        const raw = path.node.extra?.raw as string | undefined;
        if (!raw) return;

        if (!HEX_ESCAPE.test(raw) && !UNICODE_ESCAPE.test(raw) && !UNICODE_CODEPOINT_ESCAPE.test(raw)) {
          return;
        }

        // Remove extra.raw so Babel regenerates from the decoded value.
        delete path.node.extra;
      },

      NumericLiteral(path) {
        const raw = path.node.extra?.raw as string | undefined;
        if (!raw || !HEX_NUMERIC.test(raw)) return;

        // Remove extra.raw so Babel outputs decimal instead of hex.
        delete path.node.extra;
      },
    });

    return ast;
  },
};
