/**
 * The deterministic program generator of the format pass's generated-input
 * test (FORMAT-01 R-FM-17; used by tests/passes/format-generated.test.ts).
 * Fixed literal seeds, no dependency; see that test file for the lexical
 * forms and the no-fallback subset.
 */

export const SEEDS = [0x0f01a7e1, 0x5eed0002, 0x00c0ffee] as const;
export const PROGRAMS_PER_SEED = 120;

const BACKSLASH = String.fromCharCode(92);
const LINE_TERMINATORS = {
  LF: "\n",
  CR: "\r",
  CRLF: "\r\n",
  LS: String.fromCharCode(0x2028),
  PS: String.fromCharCode(0x2029),
} as const;
type LtKind = keyof typeof LINE_TERMINATORS;
const LT_KINDS = Object.keys(LINE_TERMINATORS) as LtKind[];

/** mulberry32: a small deterministic generator. */
function randomSource(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n: number): number => Math.floor(next() * n),
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(next() * items.length)];
    },
  };
}
type Rng = ReturnType<typeof randomSource>;

interface Piece {
  text: string;
  forms: string[];
}
type Build = (rng: Rng, id: string) => Piece;

const COMMENT_TEXTS = [" c", " a}b", " x/y", " `t`", " 'q'", " ${z}", " é", ""];
const NONASCII_NAMES = ["é", "ñ", "π", "Ω", "变量", `x${String.fromCharCode(0x301)}`, String.fromCodePoint(0x1d465)];
const SEPARATORS = ["", " ", "\n", "\r\n", "\r", LINE_TERMINATORS.LS, LINE_TERMINATORS.PS, "\t", "\n\n"];

// ---------------------------------------------------------------------------
// comment forms: kind x position x line terminator
// ---------------------------------------------------------------------------

function commentText(rng: Rng, kind: "line" | "block", lt: string): string {
  const text = rng.pick(COMMENT_TEXTS);
  return kind === "line" ? `//${text}${lt}` : `/*${text}${lt}${rng.pick(COMMENT_TEXTS)}*/`;
}

function commentPiece(kind: "line" | "block", position: "statement" | "block" | "expression", ltKind: LtKind): Build {
  const lt = LINE_TERMINATORS[ltKind];
  const form = `comment:${kind}:${position}:${ltKind}`;
  return (rng) => {
    const c = commentText(rng, kind, lt);
    const n = rng.int(9);
    if (position === "statement") return { text: kind === "block" ? `${c}${lt}` : c, forms: [form] };
    if (position === "block") {
      return rng.int(2) === 0
        ? { text: `if (inp.n) { ${c} out.push(${n}); }`, forms: [form] }
        : { text: `if (inp.n) { out.push(${n}); ${c}}`, forms: [form] };
    }
    return kind === "line"
      ? { text: `out.push(${n} + ${c} ${n + 1});`, forms: [form] }
      : { text: `out.push(${n} ${c} + ${n + 1});`, forms: [form] };
  };
}

function endOfInputComment(kind: "line" | "block", ltKind: LtKind): Build {
  const lt = LINE_TERMINATORS[ltKind];
  return (rng) => ({ text: kind === "line" ? commentText(rng, kind, lt) : `${commentText(rng, kind, lt)}${lt}`, forms: [`comment:${kind}:end:${ltKind}`] });
}

// ---------------------------------------------------------------------------
// '/' forms
// ---------------------------------------------------------------------------

const SLASH_PIECES: Record<string, Build> = {
  "div:number": () => ({ text: "out.push(8 / 2);", forms: [] }),
  "div:string": () => ({ text: "out.push('8' / 2);", forms: [] }),
  "div:template": () => ({ text: "out.push(`8` / inp.k);", forms: [] }),
  "div:template-with-substitution": () => ({ text: "out.push(`${8}` / inp.k);", forms: [] }),
  "div:regex": () => ({ text: "out.push(/8/ / 2);", forms: [] }),
  "div:identifier": (_r, id) => ({ text: `var q${id} = 6; out.push(q${id} / 2);`, forms: [] }),
  "div:undefined": () => ({ text: "out.push(undefined / 2);", forms: [] }),
  "div:value-keyword": (r) => ({ text: `out.push(${r.pick(["this", "true", "false", "null"])} / 2);`, forms: [] }),
  "div:property-name": () => ({ text: "out.push(inp.k / 2, inp?.k / 2);", forms: [] }),
  "div:reserved-property-name": (_r, id) => ({ text: `var o${id} = { default: 8, of: 6, if: 4, return: 2 }; out.push(o${id}.default / 2, o${id}.of / 3, o${id}?.if / 2, o${id}.return / 1);`, forms: [] }),
  "div:paren-close": () => ({ text: "out.push((inp.k) / 2, Math.abs(4) / 2);", forms: [] }),
  "div:paren-in-control-body": () => ({ text: "if (inp.n) (inp.k) / 2;", forms: [] }),
  "div:call-of-function-expression": () => ({ text: "out.push(function () { return inp.k * 2; }() / 2);", forms: [] }),
  "div:bracket-close": () => ({ text: "out.push([4][0] / 2);", forms: [] }),
  "div:increment": (_r, id) => ({ text: `var u${id} = 1; out.push(u${id}++ / 2);`, forms: [] }),
  "div:decrement": (_r, id) => ({ text: `var d${id} = 3; out.push(d${id}-- / 2);`, forms: [] }),
  "div:division-assignment": (_r, id) => ({ text: `var z${id} = 8; z${id} /= 2; out.push(z${id});`, forms: [] }),
  "re:paren-open": () => ({ text: "out.push(/a+/.test('aa'));", forms: [] }),
  "re:comma": () => ({ text: "out.push(1, /b/.source);", forms: [] }),
  "re:assign": (_r, id) => ({ text: `var r${id} = /c/g; out.push(r${id}.flags);`, forms: [] }),
  "re:question-colon": () => ({ text: "out.push(inp.n ? /d/.source : /e/.source);", forms: [] }),
  "re:bracket-open": () => ({ text: "out.push([/f/][0].source);", forms: [] }),
  "re:bang": () => ({ text: "out.push(!/g/.test('x'));", forms: [] }),
  "re:logical": () => ({ text: "out.push(inp.n && /h/.source);", forms: [] }),
  "re:binary-operator": () => ({ text: "out.push('a' + /i/.source);", forms: [] }),
  "re:arrow": (_r, id) => ({ text: `var f${id} = () => /aa/.source; out.push(f${id}());`, forms: [] }),
  "re:keyword-return": () => ({ text: "out.push((function () { return /j/.source; })());", forms: [] }),
  "re:keyword-typeof": () => ({ text: "out.push(typeof /k/);", forms: [] }),
  "re:keyword-void": () => ({ text: "out.push(void /l/);", forms: [] }),
  "re:keyword-case": () => ({ text: "switch (inp.n) { case /m/.source.length: out.push('m'); }", forms: [] }),
  "re:keyword-in": () => ({ text: "out.push('source' in /n/);", forms: [] }),
  "re:keyword-throw": (_r, id) => ({ text: `try { throw /o/; } catch (e${id}) { out.push(e${id}.source); }`, forms: [] }),
  "re:keyword-else": () => ({ text: "if (!inp.n) out.push(0); else /p/.test('p') && out.push('p');", forms: [] }),
  "re:keyword-do": () => ({ text: "do /q/.test('q'); while (false);", forms: [] }),
  "re:if-head": () => ({ text: "if (inp.n) /(x) y/.test(inp.x);", forms: [] }),
  "re:while-head": (_r, id) => ({ text: `var w${id} = 1; while (w${id}--) /r/.test('r');`, forms: [] }),
  "re:for-head": (_r, id) => ({ text: `for (var i${id} = 0; i${id} < 1; i${id}++) /s/.test('s');`, forms: [] }),
  "re:for-of-head": (_r, id) => ({ text: `for (var e${id} of [1]) /t/.test('t');`, forms: [] }),
  "re:for-in-head": (_r, id) => ({ text: `for (var k${id} in { a: 1 }) /u/.test('u');`, forms: [] }),
  "re:with-head": () => ({ text: "with (inp) /v/.test(x);", forms: [] }),
  "re:function-declaration-close": (r, id) => ({ text: `function g${id}() { out.push(1); }${r.pick(SEPARATORS)}/w x/.exec(inp.x);`, forms: [] }),
  "re:statement-start": (r) => ({ text: `out.push(0);${r.pick(SEPARATORS)}/y/.test('y');`, forms: [] }),
  "re:block-open": () => ({ text: "{ /z/.test('z'); }", forms: [] }),
};

// ---------------------------------------------------------------------------
// templates, identifiers, numeric separators
// ---------------------------------------------------------------------------

const OTHER_PIECES: Record<string, Build> = {
  "template:nested": () => ({ text: "out.push(`a${`b${inp.b}c`}d`);", forms: [] }),
  "template:string": () => ({ text: "out.push(`a${\"`\"}b${'}'}c`);", forms: [] }),
  "template:regex": () => ({ text: "out.push(`a${/x}/.source}b`);", forms: [] }),
  "template:block-comment": () => ({ text: "out.push(`a${ /* } */ 1}b`);", forms: [] }),
  "template:line-comment": (r) => ({ text: `out.push(\`a\${ // }${LINE_TERMINATORS[r.pick(LT_KINDS)]} 1}b\`);`, forms: [] }),
  "template:braces": () => ({ text: "out.push(`a${ { x: 1 }.x }b${ (function () { return { y: 2 }; })().y }c`);", forms: [] }),
  "template:line-terminator": (r) => ({ text: `out.push(\`a${LINE_TERMINATORS[r.pick(LT_KINDS)]}b\`);`, forms: [] }),
  "identifier:non-ascii-after-keyword": (r, id) => {
    const name = `${r.pick(NONASCII_NAMES)}${id}`;
    return r.pick([
      { text: `function ${name}() { return 1; } out.push(${name}());`, forms: [] },
      { text: `var ${name} = 1; out.push(typeof ${name}, void ${name});`, forms: [] },
      { text: `var ${name} = function () {}; out.push(new ${name}() instanceof ${name});`, forms: [] },
    ]);
  },
  "identifier:non-ascii-before-keyword": (r, id) => {
    const name = `${r.pick(NONASCII_NAMES)}${id}`;
    return { text: `var ${name} = 'a'; out.push(${name} in { a: 1 }, ${name} instanceof Object);`, forms: [] };
  },
  "identifier:escaped-after-keyword": (_r, id) => ({ text: `var ${BACKSLASH}u0061b${id} = 1; out.push(typeof ${BACKSLASH}u0061b${id});`, forms: [] }),
  "identifier:escaped-before-keyword": (_r, id) => ({ text: `var ${BACKSLASH}u{62}c${id} = 'a'; out.push(${BACKSLASH}u0062c${id} in { a: 1 });`, forms: [] }),
  "number:decimal": () => ({ text: "out.push(1_000 + 2);", forms: [] }),
  "number:fraction": () => ({ text: "out.push(1_0.2_5 + .0_5);", forms: [] }),
  "number:exponent": () => ({ text: "out.push(1e1_0 / 1e9, 2.5e-1_0);", forms: [] }),
  "number:binary": () => ({ text: "out.push(0b1_0);", forms: [] }),
  "number:octal": () => ({ text: "out.push(0o1_7);", forms: [] }),
  "number:hex": () => ({ text: "out.push(0xF_F);", forms: [] }),
  "number:bigint": () => ({ text: "out.push(String(1_000n + 0xF_Fn));", forms: [] }),
};

/** Pieces outside the no-fallback subset (AC-17.2 only). */
const OUTSIDE_PIECES: Record<string, Build> = {
  "outside:statements-ended-by-line-breaks": (r, id) => {
    const lt = LINE_TERMINATORS[r.pick(LT_KINDS)];
    return { text: `var a${id} = 1${lt}var b${id} = 2${lt}out.push(a${id} + b${id});`, forms: [] };
  },
  "outside:return-line-break": (r) => ({ text: `out.push((function () { return${LINE_TERMINATORS[r.pick(LT_KINDS)]}1; })());`, forms: [] }),
  "outside:postfix-line-break": (r, id) => {
    const lt = LINE_TERMINATORS[r.pick(LT_KINDS)];
    return { text: `var p${id} = 1, s${id} = 1;${lt}p${id}${lt}++s${id};`, forms: [] };
  },
  "outside:line-comment-ends-statement": (r) => ({ text: `out.push(1) //c${LINE_TERMINATORS[r.pick(LT_KINDS)]}out.push(2);`, forms: [] }),
  "outside:html-open-comment": () => ({ text: "out.push(1); <!-- c\n", forms: [] }),
  "outside:html-close-comment": () => ({ text: "\n--> c\n", forms: [] }),
  "outside:regex-after-if-block": () => ({ text: "if (inp.n) { } /bb/.test('b');", forms: [] }),
  "outside:regex-after-plain-block": () => ({ text: "{ } /cc/.test('c');", forms: [] }),
  "outside:division-after-object-literal": () => ({ text: "out.push({} / 2);", forms: [] }),
  "outside:division-after-function-expression": (_r, id) => ({ text: `var h${id} = function () { return 4; } / 2;`, forms: [] }),
  "outside:division-after-class-expression": () => ({ text: "out.push(class {} / 1);", forms: [] }),
};

/** Every listed lexical form of the no-fallback subset, by name (AC-17.4). */
const SUBSET_BUILDS: Array<readonly [string, Build]> = [];
for (const kind of ["line", "block"] as const) {
  for (const position of ["statement", "block", "expression"] as const) {
    for (const lt of LT_KINDS) SUBSET_BUILDS.push([`comment:${kind}:${position}:${lt}`, commentPiece(kind, position, lt)]);
  }
}
for (const [form, build] of Object.entries({ ...SLASH_PIECES, ...OTHER_PIECES })) SUBSET_BUILDS.push([form, build]);
const END_BUILDS: Array<readonly [string, Build]> = (["line", "block"] as const).flatMap((kind) => LT_KINDS.map((lt) => [`comment:${kind}:end:${lt}`, endOfInputComment(kind, lt)] as const));
const OUTSIDE_BUILDS = Object.entries(OUTSIDE_PIECES);

export const LISTED_FORMS: string[] = [...SUBSET_BUILDS.map(([f]) => f), ...END_BUILDS.map(([f]) => f), "hashbang"];

export interface Program {
  id: string;
  text: string;
  inSubset: boolean;
  forms: string[];
}

function generate(seed: number): Program[] {
  const rng = randomSource(seed);
  const programs: Program[] = [];
  let cursor = rng.int(SUBSET_BUILDS.length);
  let endCursor = 0;
  let hashbangCursor = 0;
  let uid = 0;
  for (let j = 0; j < PROGRAMS_PER_SEED; j++) {
    const inSubset = j % 4 !== 3;
    const forms: string[] = [];
    const parts: string[] = [];
    const count = 3 + rng.int(6);
    for (let p = 0; p < count; p++) {
      const [form, build] = SUBSET_BUILDS[cursor++ % SUBSET_BUILDS.length];
      parts.push(build(rng, `_${uid++}`).text);
      forms.push(form);
    }
    if (!inSubset) {
      for (let p = 0, extra = 1 + rng.int(2); p < extra; p++) {
        const [form, build] = rng.pick(OUTSIDE_BUILDS);
        parts.splice(rng.int(parts.length + 1), 0, build(rng, `_${uid++}`).text);
        forms.push(form);
      }
    }
    let text = parts.map((part, i) => (i === 0 ? part : `${rng.pick(SEPARATORS)}${part}`)).join("");
    if (j % 3 === 0) {
      const [form, build] = END_BUILDS[endCursor++ % END_BUILDS.length];
      text += `${rng.pick(SEPARATORS)}${build(rng, `_${uid++}`).text}`;
      forms.push(form);
    }
    if (j % 5 === 0) {
      text = `#!/usr/bin/env node${LINE_TERMINATORS[LT_KINDS[hashbangCursor++ % LT_KINDS.length]]}${text}`;
      forms.push("hashbang");
    }
    programs.push({ id: `seed ${seed.toString(16)} #${j}`, text, inSubset, forms });
  }
  return programs;
}

export const PROGRAMS: Program[] = SEEDS.flatMap(generate);
export const SUBSET = PROGRAMS.filter((p) => p.inSubset);
