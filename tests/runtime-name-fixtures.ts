import {createHash} from "node:crypto";
import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {format} from "node:util";
import vm from "node:vm";

export const ROOT = resolve(import.meta.dirname, "..");
export const load = (path: string): Promise<any> => import(pathToFileURL(join(ROOT, path)).href);
export const parser = await load("src/parser.ts");
export const babel = await load("src/babel.ts");
export const facts = await load("src/passes/annex-b-linkage.ts");
export const passes: Record<string, any> = {};
for (const name of ["ast-rename", "semantic-rename", "constant-propagate", "constant-fold", "control-flow-object", "dead-code-eliminate"]) {
  const key = name.replace(/-([a-z])/g, (_match: string, char: string) => char.toUpperCase());
  passes[key] = (await load("src/passes/" + name + ".ts"))[key + "Pass"];
}
export const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

export function encode(value: any): any {
  if (value === undefined) return {type: "undefined"};
  if (value === null) return {type: "null"};
  if (typeof value === "number") return {type: "number", value: Number.isNaN(value) ? "NaN" : value === Infinity ? "+Infinity" : value === -Infinity ? "-Infinity" : Object.is(value, -0) ? "-0" : value};
  if (Array.isArray(value)) return {type: "array", values: Array.from({length: value.length}, (_unused, index) => Object.hasOwn(value, index) ? encode(value[index]) : {type: "hole"})};
  if (typeof value === "object") return {type: "object", entries: Object.keys(value).map(key => [key, encode(value[key])])};
  return {type: typeof value, value: typeof value === "bigint" ? value.toString() : value};
}

export function observe(source: string): any {
  let stdout = "", stderr = "";
  const context = vm.createContext({events: [], chooseKey: () => "_0xv", consume: (root: any) => {root._0xv = 2;},
    console: {log: (...args: any[]) => {stdout += format(...args) + "\n";}, error: (...args: any[]) => {stderr += format(...args) + "\n";}}});
  let completion: any = {kind: "normal"};
  try {new vm.Script(source).runInContext(context, {timeout: 1000});}
  catch (error: any) {completion = {kind: "throw", name: error.name, message: error.message};}
  const globals = Object.fromEntries(["answer", "side", "events"].map(name => [name, Object.hasOwn(context, name) ? encode(context[name]) : {type: "absent"}]));
  return {completion, globals, stdout, stderr};
}

export function runPass(name: string, source: string): {ast: any; code: string} {
  const ast = parser.parse(source);
  return {ast: passes[name].run(ast, source), get code() {return parser.generate(ast);}};
}

export function nodes(ast: any, type: string): any[] {
  const result: any[] = [];
  babel.traverse(ast, {enter(path: any) {if (path.node.type === type) result.push(path.node);}});
  return result;
}

export function record(name: string, data: unknown): void {
  const directory = process.env.RUNTIME_NAME_TEST_EVIDENCE;
  if (directory) {mkdirSync(directory, {recursive: true});writeFileSync(join(directory, name + ".json"), JSON.stringify(data, null, 2) + "\n");}
}

export const witnesses = [
  {
    "id": "ast-eval",
    "pass": "astRename",
    "source": "function _0xm() {\n  function _0xa1() {\n    return 1;\n  }\n  eval(\"_0xa1 = function () { return 42; }\");\n  globalThis.answer = _0xa1();\n}\n_0xm();\n",
    "sha256": "eb36f2898c5154de17da977a80a8b9ea4a56fa03c7fb231dbaaf339e8709c48b",
    "answer": 42
  },
  {
    "id": "fold-shadow",
    "pass": "constantFold",
    "source": "function probe(undefined) {\n  globalThis.answer = void 0;\n}\nprobe(7);\n",
    "sha256": "bc7657eb04c8600d9819ddb8801d56c2ffe90068783e9cec04014e2df65242c2",
    "answer": "undefined"
  },
  {
    "id": "semantic-eval",
    "pass": "semanticRename",
    "source": "function _0xhost() {\n  var _0xlen = [1].length;\n  eval(\"_0xlen = 42\");\n  globalThis.answer = _0xlen;\n}\n_0xhost();\n",
    "sha256": "b0603d62ddab94d9cc5bbc9ba32793c86326fed738eea59425b275499f5c383f",
    "answer": 42
  },
  {
    "id": "propagate-eval",
    "pass": "constantPropagate",
    "source": "function _0xhost() {\n  var _0xv = 1;\n  eval(\"_0xv = 42\");\n  globalThis.answer = _0xv;\n}\n_0xhost();\n",
    "sha256": "98cf7f1fab2aed731753a9c6da65e1907162bbc10659b1865917abc0aa2e2abd",
    "answer": 42
  },
  {
    "id": "dce-eval",
    "pass": "deadCodeEliminate",
    "source": "function _0xhost() {\n  function _0xhidden() {\n    return 42;\n  }\n  eval(\"globalThis.answer = _0xhidden()\");\n}\n_0xhost();\n",
    "sha256": "c36a1e020cd683c77a846d341be3106d0d0f13a8b44c1a86e7aeeb3f6bc88e6a",
    "answer": 42
  },
  {
    "id": "with-read",
    "pass": "constantPropagate",
    "source": "function _0xhost() {\n  var _0xv = 1;\n  with ({ _0xv: 2 }) {\n    globalThis.answer = _0xv;\n  }\n}\n_0xhost();\n",
    "sha256": "fdaa22dfe02ce965366196b9dcc6c13ec4657103c57223d073f816e9481c81fb",
    "answer": 2,
    "expectedWarnings": ["Parse error (recovered): 'with' in strict mode. (3:2)"]
  },
  {
    "id": "global-function",
    "pass": "constantPropagate",
    "source": "var _0xv = 1;\nFunction(\"_0xv = 2\")();\nglobalThis.answer = _0xv;\n",
    "sha256": "0c19dffbc5db71f5e8425d8cae5a81901b0910342c03d9867238d1e4c3890378",
    "answer": 2
  },
  {
    "id": "inherited-function-constructor",
    "pass": "constantPropagate",
    "source": "var value = 1;\n(function () {}).constructor(\"value = 2\")();\nglobalThis.answer = value;\n",
    "sha256": "2de1bd605f1e6e5d4421629c5f867a77b298eff2929ab614c26cdb81603bf08c",
    "answer": 2
  },
  {
    "id": "global-property",
    "pass": "constantPropagate",
    "source": "var _0xv = 1;\nglobalThis._0xv = 2;\nglobalThis.answer = _0xv;\n",
    "sha256": "9eb9aba70fd617391b70094e7c72b72c8b827562df5af96e4ab146a9bdd14cfb",
    "answer": 2
  },
  {
    "id": "clean-sibling",
    "pass": "semanticRename",
    "source": "function _0xhazard() {\n  eval(\"globalThis.side = 1\");\n}\nfunction _0xclean() {\n  var _0xlen = [1].length;\n  globalThis.answer = _0xlen;\n}\n_0xhazard();\n_0xclean();\n",
    "sha256": "afbd747782a0e58b6ccaf251491d9da434a4f7b18b7482b2acb70efd6efcef83",
    "answer": 1
  },
  {
    "id": "proxy-eval",
    "pass": "controlFlowObject",
    "source": "var _0xops = {\n  call: function (_0xfn, _0xcode) {\n    return _0xfn(_0xcode);\n  },\n};\nfunction probe() {\n  var local = 1;\n  _0xops.call(eval, \"local = 42\");\n  globalThis.answer = local;\n}\nprobe();\n",
    "sha256": "1b10f83a95b84b8e359032335aaf16d6e32902813fcce6917852f18bf2234878",
    "answer": 1
  }
] as const;

export const productionFixtures = [
  ...witnesses,
  {id: "proxy-parameter", source: 'var _0xops={call:function(_0xfn,_0xcode){return _0xfn(_0xcode);}};function probe(local){_0xops.call(eval,"local=42");globalThis.answer=local;}probe(1);'},
  {id: "proxy-inactive", source: 'var ops={call:function(fn,code){return fn(code);}};function probe(local){ops.call(eval,"local=42");globalThis.answer=local;}probe(1);'},
  {id: "hoisted-var-after-return", source: 'function probe(){"use strict";eval("hidden=42");globalThis.answer=hidden;return;var hidden;}probe();'},
  {id: "unsafe-class-method-decoder-alias", source: `var _0xa = ["return 1", "log", "ok"];
(function (x) {
  x.push(x.shift());
})(_0xa);
function _0xd(_0xi) {
  return _0xa[_0xi];
}
const a = _0xd;
(function () {}).constructor(_0xd(2))();
class C {
  m() {
    const _0xb = a;
    console[_0xb(0)](_0xb(1));
  }
}
new C().m();
`},
  {id: "inherited-function-expression-alias", source: 'const callable=function(){};var value=1;callable.constructor("value=2")();answer=value;'},
  {id: "inherited-arrow-function-alias", source: 'const callable=()=>{};var value=1;callable.constructor("value=2")();answer=value;'},
  {id: "inherited-function-declaration-alias", source: 'function declared(){}const callable=declared;var value=1;callable.constructor("value=2")();answer=value;'},
  {id: "callable-own-constructor-control", source: 'const callable=function(){};callable.constructor=function(){return function(){}};var value=1;callable.constructor("value=2")();answer=value;'},
  {id: "reassigned-callable-constructor-control", source: 'let callable=function(){};callable={constructor:function(){return function(){}}};var value=1;callable.constructor("value=2")();answer=value;'},
  {id: "ordinary-object-constructor-control", source: 'const ordinary={constructor:function(){return function(){}}};var value=1;ordinary.constructor("value=2")();answer=value;'},
  {id: "callable-uncertain-conditional-own-constructor", source: 'const f=function(){};if(globalThis.flag)f.constructor=function(){return function(){}};var value=1;f.constructor("value=2")();globalThis.answer=value;'},
  {id: "nested-delete-invoked-before-constructor-access", source: 'const f=function(){};function reset(){delete f.constructor;}f.constructor=function(){return function(){}};reset();var value=1;f.constructor("value=2")();globalThis.answer=value;'},
  {id: "object-constructor-route", source: 'var value=1;Object.constructor("value=2")();globalThis.answer=value;'},
  {id: "array-pattern-intrinsic-eval", source: 'function probe(){const [eval]=[globalThis.eval];var value=1;eval("value=42");globalThis.answer=value;}probe();', expectedWarnings: ["Parse error (recovered): Binding 'eval' in strict mode. (1:24)"]},
  {id: "named-sloppy-bare-call", source: 'var value=1;function set(){this.value=2;}set();globalThis.answer=value;'},
  {id: "cfu-current-tree-reorder", source: 'var value=1;var _0xo="0|1".split("|"),_0xi=0;while(!![]){switch(_0xo[_0xi++]){case"1":var globalThis={};continue;case"0":globalThis.value=2;continue;}break;}answer=value;'},
  {id: "ineffective-script-global-undefined-initializer", source: 'var undefined=7;globalThis.answer=undefined;'},
  {id: "script-global-undefined-cross-branch-typeof", source: 'var undefined;var c=[1].length>0;if(c){undefined=1;}else{undefined=2;}globalThis.answer=typeof undefined;'},
  {id: "globalthis-root-write-own-constructor", source: 'var hidden=1;var x={constructor:{}};globalThis.x=function(){};x.constructor("hidden=2")();globalThis.answer=hidden;'},
  {id: "object-computed-constructor-key", source: 'var hidden=1;var k="constructor";Object[k]("hidden=2")();globalThis.answer=hidden;'},
  {id: "destructured-eval-later-spread", source: '(function(){var hidden=1;var src={eval:globalThis.eval};var {eval}={eval:function(s){return s;},...src};eval("hidden=42");globalThis.answer=hidden;})();', expectedWarnings: ["Parse error (recovered): Binding 'eval' in strict mode. (1:61)"]},
  {id: "named-sloppy-optional-call", source: 'var hidden=1;function f(){this.hidden=2;}f?.();globalThis.answer=hidden;'},
  {id: "same-statement-receiver-pass-own-constructor", source: "var hidden=1;let o=function(){};o.constructor=function(){return function(){}};function strip(x){delete x.constructor;}strip(o),o.constructor(\"hidden=2\")();globalThis.answer=hidden;"},
];
