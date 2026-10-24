import {spawnSync} from "node:child_process";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {describe, expect, it} from "vitest";
const {ROOT, parser, babel, facts, passes, hash, encode, observe, runPass, nodes, record, witnesses} = await import(pathToFileURL(join(import.meta.dirname, "..", "runtime-name-fixtures.ts")).href);

type Row = {id: string; source: string; answer?: unknown; throws?: string};
function preserve(name: string, pass: string, rows: Row[]): any[] {
  const results = rows.map(row => ({...row, before: observe(row.source), ...runPass(pass, row.source)}));
  const observations = results.map(row => ({id: row.id, before: row.before, after: observe(row.code), code: row.code}));
  record(name, observations);
  for (const row of results) {
    expect(row.before.completion.kind, row.id + " source completion").toBe(row.throws ? "throw" : "normal");
    if (row.throws) expect(row.before.completion.name, row.id).toBe(row.throws);
    if (Object.hasOwn(row, "answer")) expect(row.before.globals.answer, row.id + " source value").toEqual(encode(row.answer));
  }
  expect(observations.map(row => ({id: row.id, outcome: row.after}))).toEqual(observations.map(row => ({id: row.id, outcome: row.before})));
  return results;
}
const proxy = (callee: string, prefix = "", suffix = ""): string => `function probe(local){${prefix}var ops={call:function(fn,code){return fn(code);}};ops.call(${callee},"local=42");globalThis.answer=local;${suffix}}probe(1);`;
const bareEvalCalls = (ast: any): number => nodes(ast, "CallExpression").filter((node: any) => !node.optional && node.callee.type === "Identifier" && node.callee.name === "eval").length;

describe("runtime name resolution", () => {
  it.each(witnesses as Array<{id: string; source: string; sha256: string; pass: string; answer: unknown}>)("$id preserves the isolated pass observation", (row: any) => {
    expect(hash(row.source)).toBe(row.sha256);
    preserve(row.id, row.pass, [{id: row.id, source: row.source, answer: row.answer === "undefined" ? undefined : row.answer}]);
    if (row.id === "clean-sibling") {
      expect(nodes(runPass(row.pass, row.source).ast, "VariableDeclarator").some((node: any) => node.id.name === "_0xlen")).toBe(false);
    }
  });

  it("fact queries distinguish linked owners from same-spelled foreign bindings", () => {
    const ast = parser.parse('function left(){var linked=0;{function linked(){}}return linked;}function right(){var linked=1;return linked;}');
    const bindings: Record<string, any> = {};
    babel.traverse(ast, {FunctionDeclaration(path: any) {if (["left", "right"].includes(path.node.id?.name)) bindings[path.node.id.name] = path.scope.getBinding("linked");}});
    expect(bindings.left).toBeDefined(); expect(bindings.right).toBeDefined();
    expect(bindings.left).not.toBe(bindings.right);
    const linked = facts.runtimeNameFacts(ast).linked;
    expect(linked.has(bindings.left)).toBe(true); expect(linked.has(bindings.right)).toBe(false);
    const owners = facts.runtimeNameFacts(ast).owners.get("linked");
    expect([...owners].map((owner: any) => owner.node.id.name)).toEqual(["left"]);
  });

  it("exposed fact answers survive attempted result mutation", () => {
    const ast = parser.parse('function owner(){var linked=0;{function linked(){}}return linked;}');
    const linked = facts.runtimeNameFacts(ast).linked;
    const owners = facts.runtimeNameFacts(ast).owners;
    const members = [...linked], ownerMembers = [...owners.get("linked")];
    expect(members.length).toBe(1); expect(ownerMembers.length).toBe(1);
    const attempts: any[] = [];
    for (const target of [linked, owners.get("linked"), owners]) {
      try {target.clear?.(); attempts.push("returned");} catch (error: any) {attempts.push(error.name);}
    }
    record("fact-mutation", {attempts, linkedAfter: linked.size, ownersAfter: owners.size});
    expect([...linked]).toEqual(members);
    expect([...owners.get("linked") ?? []]).toEqual(ownerMembers);
    expect([...facts.runtimeNameFacts(ast).linked]).toEqual(members);
  });

  it("P-R3-02 exposes only the unified runtime-name fact surface", () => {
    expect(facts.runtimeNameFacts).toBeTypeOf("function");
    expect("annexBLinkedBindings" in facts).toBe(false);
    expect("annexBRetainedFunctionOwners" in facts).toBe(false);
  });
  it("direct eval protects reachable ancestors, strict writes and nonliteral source", () => {
    preserve("eval-reachability", "constantPropagate", [
      {id:"parenthesized",source:'function probe(){var value=1;(eval)("value=42");answer=value;}probe();',answer:42},
      {id:"child",source:'function probe(){var value=1;function child(){eval("value=42");}child();answer=value;}probe();',answer:42},
      {id:"intrinsic-parameter",source:'(function(eval){var value=1;eval("value=42");answer=value;})(eval);',answer:42},
      {id:"strict-nonliteral",source:'function probe(code){"use strict";var value=1;eval(code);globalThis.answer=[value,typeof introduced];}probe("value=42;var introduced=7");',answer:[42,"undefined"]},
    ]);
  });

  it("proven ordinary eval permits useful local propagation", () => {
    const source='function probe(){const eval=function(code){return code;};var value=1;eval("value=42");answer=value;}probe();';
    const rows=preserve("ordinary-eval", "constantPropagate", [{id:"ordinary",source,answer:1}]);
    expect(nodes(rows[0].ast,"AssignmentExpression").find((node: any) => node.left.name === "answer").right.type).toBe("NumericLiteral");
  });

  it("rename destinations retain absent eval names and with lookup sites", () => {
    const sources=[
      'function probe(){var _0xa=1;eval("var value=7");answer=_0xa;}probe();',
      'function probe(){var _0xa=1;with({value:7}){answer=_0xa;}}probe();',
    ];
    preserve("rename-destinations", "astRename", sources.map((source,id) => ({id:String(id),source,answer:1})));
  });

  it("semantic rename preserves destination capture and globally observed names", () => {
    preserve("semantic-destination", "semanticRename", [{id:"with-len",source:'function probe(){var _0xa=[1].length;with({len:7}){answer=_0xa;}}probe();',answer:1},
      {id:"global-property",source:'var _0xlen=[1].length;answer=globalThis._0xlen;',answer:1}]);
  });

  it("with retains writes, getter effects, captured closures and unscopables lookup", () => {
    preserve("with-sites", "constantPropagate", [
      {id:"write",source:'function probe(){var value=1;with({}){value=2;}answer=value;}probe();',answer:2},
      {id:"getter",source:'function probe(){var value=1;with({get value(){events.push("get");return 7;}}){answer=value;}}probe();',answer:7},
      {id:"closure",source:'function probe(){var value=1,read;with({value:7}){read=function(){return value;};}answer=read();}probe();',answer:7},
      {id:"inherited-unscopables",source:'function probe(){var value=1;var object=Object.create({value:7});with(object){events.push(value);}object[Symbol.unscopables]={value:true};with(object){answer=value;}}probe();',answer:1},
    ]);
  });

  it("literal folding under recovered with parsing remains useful", () => {
    const source='with({}){answer=1+2;}'; const parsed=parser.parseWithDiagnostics(source);
    expect(parsed.completeness).toBe("whole");
    expect(parsed.warnings.some((warning: string) => warning.includes("'with' in strict mode"))).toBe(true);
    const rows=preserve("with-literal", "constantFold", [{id:"literal",source,answer:3}]);
    expect(nodes(rows[0].ast,"BinaryExpression")).toHaveLength(0);
  });

  it("indirect eval and constructed functions preserve exposed global environments", () => {
    const actions=[
      '(0,eval)("_0xv=2")','globalThis.eval("_0xv=2")','eval?.("_0xv=2")',
      'const alias=eval;alias("_0xv=2")','Function("_0xv=2")()',
      '(new Function("_0xv=2"))()','const Constructor=Function;const run=Constructor("_0xv=2");run()',
      'const run=Function("_0xv=2");[run].forEach(fn=>fn())',
    ];
    const rows=actions.map((action,id) => ({id:String(id),source:`let _0xv=1;${action};answer=_0xv;`,answer:2}));
    preserve("global-dynamic", "constantPropagate", rows);
  });

  it("global roots retain literal, computed, escaped, reassigned and update effects", () => {
    const actions=[
      'this._0xv=2','(()=>{this._0xv=2})()','const root=globalThis;const alias=root;alias._0xv=2',
      'globalThis[chooseKey()]=2','const root=globalThis;consume(root)',
      'globalThis._0xv++','delete globalThis._0xv',
      'globalThis={_0xv:9};this._0xv=2',
    ];
    preserve("global-roots", "constantPropagate", actions.map((action,id) => ({id:String(id),source:`var _0xv=1;${action};answer=typeof _0xv==="undefined"?"absent":_0xv;`,answer:id===6?1:2})));
  });

  it("global-only observers preserve useful independent locals and lexical property controls", () => {
    const rows=preserve("bounded-globals", "constantPropagate", [
      {id:"caller-local",source:'var _0xv=1;function probe(){var _0xv=7;(0,eval)("_0xv=2");answer=_0xv;}probe();',answer:7},
      {id:"lexical-property",source:'let _0xv=1;globalThis._0xv=2;answer=_0xv;',answer:1},
      {id:"shadow-root",source:'function probe(globalThis){var _0xv=7;globalThis._0xv=2;answer=_0xv;}probe({});',answer:7},
      {id:"other-object",source:'var _0xv=1;const object={};object._0xv=2;answer=_0xv;',answer:1},
    ]);
    for (const row of rows) expect(nodes(row.ast,"AssignmentExpression").find((node: any) => node.left.name === "answer").right.type,row.id).toBe("NumericLiteral");
  });

  it("module locals and undefined top-level this remain independent of global code", () => {
    for (const action of ['globalThis._0xv=2','(0,eval)("_0xv=2")']) {
      const source=`var _0xv=1;${action};globalThis.answer=[_0xv,this===undefined];export{};`;
      const output=runPass("constantPropagate",source);
      const execute=(code: string) => spawnSync(process.execPath,["--input-type=module","--eval",code+';process.stdout.write(JSON.stringify(globalThis.answer));'],{cwd:ROOT,encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:10000});
      const before=execute(source),after=execute(output.code);
      expect(before.status).toBe(0); expect(before.stdout).toBe('[1,true]');
      expect({exit:after.status,stdout:after.stdout,stderr:after.stderr}).toEqual({exit:before.status,stdout:before.stdout,stderr:before.stderr});
      expect(nodes(output.ast,"AssignmentExpression").find((node: any) => node.left.property?.name === "answer").right.elements[0].type).toBe("NumericLiteral");
    }
  });

  it("undefined emission respects catch, block TDZ, with and sloppy eval supply", () => {
    preserve("undefined-emission", "constantFold", [
      {id:"catch",source:'try{throw 7;}catch(undefined){answer=void 0;}',answer:undefined},
      {id:"block-tdz",source:'{answer=void 0;let undefined=7;}',answer:undefined},
      {id:"with",source:'with({undefined:7}){answer=void 0;}',answer:undefined},
      {id:"eval-introduced",source:'function probe(){eval("var undefined=7");answer=void 0;}probe();',answer:undefined},
    ]);
  });

  it("undefined interpretation preserves unary, binary, logical and conditional values", () => {
    preserve("undefined-interpretation", "constantFold", [{id:"parameter",source:'(function(undefined){answer=[typeof undefined,undefined===7,undefined||3,undefined?1:2];})(7);',answer:["number",true,7,1]}]);
  });

  it("propagation preserves initializer and destination resolution across literal, array and alias paths", () => {
    preserve("propagation-destinations", "constantPropagate", [
      {id:"literal",source:'const value=undefined;function probe(undefined){answer=value;}probe(7);',answer:undefined},
      {id:"array",source:'const values=[undefined];function probe(undefined){answer=values[0];}probe(7);',answer:undefined},
      {id:"alias-write",source:'function probe(){var original=function(){return 1;};const alias=original;eval("original=function(){return 42;}");answer=alias();}probe();',answer:1},
      {id:"array-write",source:'function probe(){const values=[1];eval("values[0]=42");answer=values[0];}probe();',answer:42},
      {id:"with-destination",source:'const value=undefined;with({undefined:7}){answer=value;}',answer:undefined},
    ]);
  });

  it("cross-branch typeof rejects shadowed undefined classes and meaningful initializers", () => {
    preserve("propagation-typeof", "constantPropagate", [
      {id:"rhs-shadow",source:'function probe(undefined,flag){var value;if(flag){value=undefined;}else{value=undefined;}answer=typeof value;}probe(7,true);',answer:"number"},
      {id:"initializer-shadow",source:'function probe(undefined,flag){var value=undefined;answer=typeof value;if(flag){value="a";}else{value="b";}return value;}probe(7,true);',answer:"number"},
    ]);
  });

  it("intrinsic-spelled DCE initializers preserve TDZ throws and with getters", () => {
    const rows: Row[]=[];
    for (const name of ["undefined","NaN","Infinity"]) {
      rows.push({id:name+"-tdz",source:`function probe(){var unused=${name};let ${name}=7;answer=1;}probe();`,throws:"ReferenceError"});
      rows.push({id:name+"-getter",source:`function probe(){with({get ${name}(){events.push("${name}");return 7;}}){var unused=${name};}answer=1;}probe();`,answer:1});
    }
    preserve("dce-intrinsic-purity", "deadCodeEliminate", rows);
  });

  it("safe intrinsic folding and harmless DCE reads retain useful transformations", () => {
    const folded=preserve("safe-intrinsic", "constantFold", [{id:"unbound",source:'answer=[void 0,typeof undefined,1+2];',answer:[undefined,"undefined",3]}])[0];
    expect(nodes(folded.ast,"UnaryExpression")).toHaveLength(0);expect(nodes(folded.ast,"BinaryExpression")).toHaveLength(0);
    const removed=preserve("safe-intrinsic-dce", "deadCodeEliminate", [{id:"pure",source:'function probe(){var a=undefined,b=NaN,c=Infinity;answer=1;}probe();',answer:1}])[0];
    expect(nodes(removed.ast,"VariableDeclarator")).toHaveLength(0);
  });

  it("proxy replacement preserves bare and parenthesized possible intrinsic eval indirectness", () => {
    const results=[["bare",proxy("eval")],["parenthesized",proxy("(eval)")],["parameter",'(function(eval,local){var ops={call:function(fn,code){return fn(code);}};ops.call(eval,"local=42");answer=local;})(eval,1);']].map(([id,source]) => {
      const output=runPass("controlFlowObject",source);
      return {id,source,output:output.code,before:observe(source),after:observe(output.code),bareCalls:bareEvalCalls(output.ast)};
    });
    record("proxy-negative",results);
    expect(results.map(row => row.before.globals.answer)).toEqual(results.map(() => encode(1)));
    expect(results.map(row => row.after)).toEqual(results.map(row => row.before));
    expect(results.map(row => row.bareCalls)).toEqual([0,0,0]);
  });

  it("eligible indirect and proven ordinary proxy calls still inline", () => {
    const rows=[
      {id:"sequence",source:proxy("(0,eval)")}, {id:"member",source:proxy("globalThis.eval")},
      {id:"alias",source:proxy("alias","const alias=eval;")},
      {id:"ordinary-eval",source:proxy("eval","const eval=function(code){return code;};")},
      {id:"unrelated-argument",source:'function probe(){var ops={call:function(fn,value,ignored){return fn(value);}};answer=ops.call(function(value){return value+1;},1,eval);}probe();'},
    ];
    const outputs=preserve("proxy-positive", "controlFlowObject", rows);
    for (const row of outputs) expect(nodes(row.ast,"CallExpression").filter((node: any) => node.callee.type === "MemberExpression" && node.callee.object.name === "ops"),row.id).toHaveLength(0);
  });

  it("existing optional eval remains optional and indirect", () => {
    const source='function probe(local){eval?.("local=42");answer=local;}probe(1);';
    const rows=preserve("optional-eval", "controlFlowObject", [{id:"optional",source,answer:1}]);
    expect(nodes(rows[0].ast,"OptionalCallExpression")).toHaveLength(1);
  });

  it("alias propagation cannot create a direct intrinsic eval call", () => {
    const source='(function(eval,local){const alias=eval;alias("local=42");answer=local;})(eval,1);';
    const output=runPass("constantPropagate",source);
    record("propagation-eval-callee",{source,code:output.code,before:observe(source),after:observe(output.code)});
    expect(observe(source).globals.answer).toEqual(encode(1)); expect(observe(output.code)).toEqual(observe(source));
    expect(bareEvalCalls(output.ast)).toBe(0);
  });

  it("DCE retains dynamic-only variables and contaminated branch decisions", () => {
    preserve("dce-dynamic", "deadCodeEliminate", [
      {id:"variable",source:'function probe(){var hidden=42;eval("answer=hidden");}probe();',answer:42},
      {id:"global-property",source:'var _0xv=42;answer=globalThis._0xv;',answer:42},
      {id:"global-dynamic",source:'let _0xv=42;answer=(0,eval)("_0xv");',answer:42},
      {id:"branch-ternary",source:'function probe(){var value=0;eval("value=1");if(value){events.push("yes");}else{events.push("no");}answer=value?42:1;}probe();',answer:42},
    ]);
  });

  it("literal-only DCE branches remain eligible beside a dynamic observer", () => {
    const source='function probe(){eval("side=1");if(true){answer=1;}else{answer=2;}}probe();';
    const rows=preserve("dce-literal", "deadCodeEliminate", [{id:"literal",source,answer:1}]);
    expect(nodes(rows[0].ast,"IfStatement")).toHaveLength(0);
  });

  it("CFO retains dynamically observed storage after substitutions and recrawl", () => {
    const source='function probe(){var ops={text:"x"};events.push(ops.text);eval("answer=ops.text");}probe();';
    preserve("cfo-storage", "controlFlowObject", [{id:"storage-read",source,answer:"x"},
      {id:"storage-write",source:'function probe(){var ops={text:"x"};eval("ops.text=String(7)");answer=ops.text;}probe();',answer:"7"}]);
  });

  it("Annex B implicit writes remain live dependencies of DCE evaluation", () => {
    preserve("annex-b-evaluation", "deadCodeEliminate", [{id:"implicit-write",source:'function probe(){var value=0;{function value(){return 7;}}answer=value?42:1;}probe();',answer:42}]);
  });

  it.each(["same File", "reparsed File"])("fresh observers replace old binding facts on %s", (shape: string) => {
    const clean='function probe(){var value=1;answer=value;}probe();';
    const hazardous='function probe(){var value=1;eval("value=2");answer=value;}probe();';
    let ast=parser.parse(clean); passes.constantPropagate.run(ast,clean);
    expect(observe(parser.generate(ast)).globals.answer).toEqual(encode(1));
    const oldBindings: any[]=[];babel.traverse(ast,{FunctionDeclaration(path: any){oldBindings.push(path.scope.getBinding("value"));}});
    if(shape==="same File") ast.program.body=parser.parse(hazardous).program.body;
    else ast=parser.parse(hazardous);
    babel.traverse(ast,{Program(path: any){path.scope.crawl();}});
    const newBindings: any[]=[];babel.traverse(ast,{FunctionDeclaration(path: any){newBindings.push(path.scope.getBinding("value"));}});
    expect(newBindings[0]).not.toBe(oldBindings[0]);
    passes.constantPropagate.run(ast,clean);
    const observed=observe(parser.generate(ast));record("fresh-"+shape.replaceAll(" ","-"),{shape,code:parser.generate(ast),observed});
    ast.program.body=parser.parse(clean).program.body;babel.traverse(ast,{Program(path: any){path.scope.crawl();}});
    passes.constantPropagate.run(ast,hazardous);
    expect(observe(parser.generate(ast))).toEqual(observe(clean));
    expect(nodes(ast,"AssignmentExpression").find((node: any) => node.left.name === "answer").right.type).toBe("NumericLiteral");
    expect(observed).toEqual(observe(hazardous));
  });

  it("a real predecessor transform and CFO internal recrawl keep current storage facts", () => {
    const source='function probe(){var ops={text:"x"};events.push(ops["te"+"xt"]);eval("answer=ops.text");}probe();';
    const ast=parser.parse(source);passes.constantFold.run(ast,source);
    expect(nodes(ast,"BinaryExpression")).toHaveLength(0);
    passes.controlFlowObject.run(ast,source);
    const code=parser.generate(ast);record("predecessor-storage",{source,code,before:observe(source),after:observe(code)});
    expect(observe(code)).toEqual(observe(source));
  });
});

import vm from "node:vm";

function observeRuntimeFrame(source: string, frame: string): any {
  const effects: any[] = [];
  const context: any = vm.createContext({});
  const root = vm.runInContext("globalThis", context);
  if (frame === "consume") context.consume = (target: any) => {
    effects.push("consume");
    target.Function("value=2")();
  };
  if (frame === "iterator") Object.defineProperty(context, Symbol.iterator, {
    value: function* () {
      effects.push("iterator", encode(root._0xlen));
      root.Function("value=2")();
      yield root._0xlen;
    },
    enumerable: false,
  });
  if (frame === "external") context.external = {root, Ctor: root.Function};
  let completion: any = {kind: "normal"};
  try {new vm.Script(source).runInContext(context, {timeout: 1000});}
  catch (error: any) {completion = {kind: "throw", name: error.name, message: error.message};}
  return {completion, globals: {answer: Object.hasOwn(context, "answer") ? encode(context.answer) : {type: "absent"}}, effects};
}

function expectRuntimePostcondition(ast: any, post: string): void {
  const declarations = nodes(ast, "VariableDeclarator");
  if (post === "numeric") {
    const answer = nodes(ast, "AssignmentExpression").find((node: any) => node.left.name === "answer" || node.left.property?.name === "answer");
    expect(answer?.right.type).toBe("NumericLiteral");
  } else if (post.startsWith("rename:")) {
    expect(declarations.some((node: any) => node.id.name === post.slice(7))).toBe(false);
  } else if (post === "no-if") {
    expect(nodes(ast, "IfStatement")).toHaveLength(0);
  } else if (post === "no-conditional" || post === "optional-selected") {
    expect(nodes(ast, "ConditionalExpression")).toHaveLength(0);
    if (post === "optional-selected") expect(nodes(ast, "OptionalCallExpression")).toHaveLength(1);
  } else if (post === "indirect-conditional") {
    expect(nodes(ast, "ConditionalExpression")).toHaveLength(1);
    expect(bareEvalCalls(ast)).toBe(0);
  } else if (post === "no-ops-call") {
    expect(nodes(ast, "CallExpression").filter((node: any) => node.callee.type === "MemberExpression" && node.callee.object.name === "ops")).toHaveLength(0);
  } else if (post === "no-storage") {
    expect(declarations.some((node: any) => node.id.name === "ops")).toBe(false);
    expect(nodes(ast, "MemberExpression").filter((node: any) => node.object.name === "ops")).toHaveLength(0);
  } else if (post === "clean-hidden") {
    expect(declarations.some((node: any) => node.id.name === "hidden")).toBe(false);
  } else if (post === "clean-tail") {
    expect(nodes(ast, "StringLiteral").some((node: any) => node.value === "unreachable")).toBe(false);
  } else if (post === "function-hidden") {
    expect(nodes(ast, "FunctionDeclaration").some((node: any) => node.id?.name === "hidden")).toBe(true);
  } else {
    throw new Error("Unknown test postcondition: " + post);
  }
}

const runtimeBindingCases: any[] = [
  {"partition":"P-R2-01","id":"exact-hoist-return","pass":"deadCodeEliminate","source":"function probe(){\"use strict\";eval(\"hidden=42\");globalThis.answer=hidden;return;var hidden;}probe();","answer":{"type":"number","value":42}},
  {"partition":"P-R2-01","id":"hoist-return-init","pass":"deadCodeEliminate","source":"function probe(){\"use strict\";eval(\"hidden=42\");globalThis.answer=hidden;return;var hidden=events.push(\"unreachable\");}probe();","answer":{"type":"number","value":42}},
  {"partition":"P-R2-01","id":"hoist-throw","pass":"deadCodeEliminate","source":"function probe(){\"use strict\";try{eval(\"hidden=42\");globalThis.answer=hidden;throw 0;var hidden;}catch(error){events.push(error);}}probe();","answer":{"type":"number","value":42},"events":{"type":"array","values":[{"type":"number","value":0}]}},
  {"partition":"P-R2-01","id":"hoist-break","pass":"deadCodeEliminate","source":"function probe(){\"use strict\";while(true){eval(\"hidden=42\");globalThis.answer=hidden;break;var hidden;}}probe();","answer":{"type":"number","value":42}},
  {"partition":"P-R2-01","id":"hoist-continue","pass":"deadCodeEliminate","source":"function probe(){\"use strict\";for(let count=0;count<1;count++){eval(\"hidden=42\");globalThis.answer=hidden;continue;var hidden;}}probe();","answer":{"type":"number","value":42}},
  {"partition":"P-R2-01","id":"hoist-destructure","pass":"deadCodeEliminate","source":"function probe(){\"use strict\";eval(\"hidden=42\");globalThis.answer=hidden;return;var {hidden}=events.push(\"unreachable\");}probe();","answer":{"type":"number","value":42}},
  {"partition":"P-R2-01","id":"hoist-block","pass":"deadCodeEliminate","source":"function probe(){\"use strict\";eval(\"hidden=42\");globalThis.answer=hidden;return;{var hidden;}}probe();","answer":{"type":"number","value":42}},
  {"partition":"P-R2-01","id":"hoist-for","pass":"deadCodeEliminate","source":"function probe(){\"use strict\";eval(\"hidden=42\");globalThis.answer=hidden;return;for(var hidden of [1]){}}probe();","answer":{"type":"number","value":42}},
  {"partition":"P-R2-01","id":"hoist-annex-b","pass":"deadCodeEliminate","source":"function probe(){eval(\"\\\"use strict\\\";hidden=42\");globalThis.answer=hidden;return;{function hidden(){}}}probe();","answer":{"type":"number","value":42}},
  {"partition":"P-R2-01","id":"hoist-function-control","pass":"deadCodeEliminate","source":"function probe(){\"use strict\";eval(\"globalThis.answer=hidden()\");return;function hidden(){return 7;}}probe();","answer":{"type":"number","value":7},"post":"function-hidden"},
  {"partition":"P-R2-01","id":"hoist-ordinary-unreachable","pass":"deadCodeEliminate","source":"function probe(){\"use strict\";globalThis.answer=42;return;events.push(\"unreachable\");var unused;}probe();","answer":{"type":"number","value":42},"post":"clean-tail"},
  {"partition":"P-R2-01","id":"let-dynamic-tdz","pass":"deadCodeEliminate","source":"function probe(){\"use strict\";globalThis.answer=eval(\"typeof hidden\");return;let hidden;}probe();","answer":{"type":"absent"},"error":"ReferenceError"},
  {"partition":"P-R2-01","id":"class-dynamic-tdz","pass":"deadCodeEliminate","source":"function probe(){\"use strict\";globalThis.answer=eval(\"typeof hidden\");return;class hidden{}}probe();","answer":{"type":"absent"},"error":"ReferenceError"},
  {"partition":"P-R2-01","id":"branch-else-hoist","pass":"deadCodeEliminate","source":"function probe(){\"use strict\";eval(\"hidden=42\");globalThis.answer=hidden;if(true){events.push(\"selected\");}else{var hidden;}}probe();","answer":{"type":"number","value":42},"events":{"type":"array","values":[{"type":"string","value":"selected"}]}},
  {"partition":"P-R2-01","id":"branch-consequent-hoist","pass":"deadCodeEliminate","source":"function probe(){\"use strict\";eval(\"hidden=42\");globalThis.answer=hidden;if(false){var hidden;}else{events.push(\"selected\");}}probe();","answer":{"type":"number","value":42},"events":{"type":"array","values":[{"type":"string","value":"selected"}]}},
  {"partition":"P-R2-01","id":"block-lexical-clean","pass":"deadCodeEliminate","source":"function probe(){\"use strict\";globalThis.answer=eval(\"typeof hidden\");return;{let hidden;}}probe();","answer":{"type":"string","value":"undefined"},"post":"clean-hidden"},
  {"partition":"P-R2-01","id":"function-var-clean","pass":"deadCodeEliminate","source":"function probe(){\"use strict\";globalThis.answer=eval(\"typeof hidden\");return;function inner(){var hidden;}events.push(\"unreachable\");}probe();","answer":{"type":"string","value":"undefined"},"post":"clean-tail"},
  {"partition":"P-R2-02","id":"nonintrinsic-zero-constant-propagate","pass":"constantPropagate","source":"function probe(){const eval=0;var value=1;try{eval(\"value=42\");}catch(error){events.push(error.name);}answer=value;}probe();","answer":{"type":"number","value":1},"events":{"type":"array","values":[{"type":"string","value":"TypeError"}]},"post":"numeric"},
  {"partition":"P-R2-02","id":"nonintrinsic-zero-ast-rename","pass":"astRename","source":"function probe(){const eval=0;var _0xv=1;try{eval(\"_0xv=42\");}catch(error){events.push(error.name);}answer=_0xv;}probe();","answer":{"type":"number","value":1},"events":{"type":"array","values":[{"type":"string","value":"TypeError"}]},"post":"rename:_0xv"},
  {"partition":"P-R2-02","id":"nonintrinsic-zero-semantic-rename","pass":"semanticRename","source":"function probe(){const eval=0;var _0xlen=[1].length;try{eval(\"_0xlen=42\");}catch(error){events.push(error.name);}answer=_0xlen;}probe();","answer":{"type":"number","value":1},"events":{"type":"array","values":[{"type":"string","value":"TypeError"}]},"post":"rename:_0xlen"},
  {"partition":"P-R2-02","id":"nonintrinsic-zero-dead-code-eliminate","pass":"deadCodeEliminate","source":"function probe(){const eval=0;var value=1;try{eval(\"value=42\");}catch(e){events.push(e.name);}if(value){answer=42;}else{answer=1;}}probe();","answer":{"type":"number","value":42},"events":{"type":"array","values":[{"type":"string","value":"TypeError"}]},"post":"no-if"},
  {"partition":"P-R2-02","id":"nonintrinsic-zero-constant-fold","pass":"constantFold","source":"function probe(){const eval=0;try{(true?eval:function(){})(\"ignored\");}catch(e){events.push(e.name);}answer=1;}probe();","answer":{"type":"number","value":1},"events":{"type":"array","values":[{"type":"string","value":"TypeError"}]},"post":"no-conditional"},
  {"partition":"P-R2-02","id":"nonintrinsic-zero-control-flow-object","pass":"controlFlowObject","source":"function probe(){const eval=0;var ops={call:function(f,s){return f(s);}};try{ops.call(eval,\"ignored\");}catch(e){events.push(e.name);}answer=1;}probe();","answer":{"type":"number","value":1},"events":{"type":"array","values":[{"type":"string","value":"TypeError"}]},"post":"no-ops-call"},
  {"partition":"P-R2-03","id":"discard-eval-constant-propagate","pass":"constantPropagate","source":"var value=1;void eval;answer=value;","answer":{"type":"number","value":1},"post":"numeric"},
  {"partition":"P-R2-03","id":"discard-eval-semantic-rename","pass":"semanticRename","source":"var _0xlen=[1].length;void eval;answer=_0xlen;","answer":{"type":"number","value":1},"post":"rename:_0xlen"},
  {"partition":"P-R2-03","id":"discard-eval-dead-code-eliminate","pass":"deadCodeEliminate","source":"var hidden=42;void eval;answer=1;","answer":{"type":"number","value":1},"post":"clean-hidden"},
  {"partition":"P-R2-03","id":"discard-eval-control-flow-object","pass":"controlFlowObject","source":"var ops={text:\"x\"};void eval;answer=ops.text;","answer":{"type":"string","value":"x"},"post":"no-storage"},
  {"partition":"P-R2-03","id":"discard-Function-constant-propagate","pass":"constantPropagate","source":"var value=1;void Function;answer=value;","answer":{"type":"number","value":1},"post":"numeric"},
  {"partition":"P-R2-03","id":"discard-Function-semantic-rename","pass":"semanticRename","source":"var _0xlen=[1].length;void Function;answer=_0xlen;","answer":{"type":"number","value":1},"post":"rename:_0xlen"},
  {"partition":"P-R2-03","id":"discard-Function-dead-code-eliminate","pass":"deadCodeEliminate","source":"var hidden=42;void Function;answer=1;","answer":{"type":"number","value":1},"post":"clean-hidden"},
  {"partition":"P-R2-03","id":"discard-Function-control-flow-object","pass":"controlFlowObject","source":"var ops={text:\"x\"};void Function;answer=ops.text;","answer":{"type":"string","value":"x"},"post":"no-storage"},
  {"partition":"P-R3-01","id":"bare-eval-constant-propagate","pass":"constantPropagate","source":"var value=1;eval;answer=value;","answer":{"type":"number","value":1},"post":"numeric"},
  {"partition":"P-R3-01","id":"bare-eval-semantic-rename","pass":"semanticRename","source":"var _0xlen=[1].length;eval;answer=_0xlen;","answer":{"type":"number","value":1},"post":"rename:_0xlen"},
  {"partition":"P-R3-01","id":"bare-eval-dead-code-eliminate","pass":"deadCodeEliminate","source":"var hidden=42;eval;answer=1;","answer":{"type":"number","value":1},"post":"clean-hidden"},
  {"partition":"P-R3-01","id":"bare-eval-control-flow-object","pass":"controlFlowObject","source":"var ops={text:\"x\"};eval;answer=ops.text;","answer":{"type":"string","value":"x"},"post":"no-storage"},
  {"partition":"P-R3-01","id":"bare-Function-constant-propagate","pass":"constantPropagate","source":"var value=1;Function;answer=value;","answer":{"type":"number","value":1},"post":"numeric"},
  {"partition":"P-R3-01","id":"bare-Function-semantic-rename","pass":"semanticRename","source":"var _0xlen=[1].length;Function;answer=_0xlen;","answer":{"type":"number","value":1},"post":"rename:_0xlen"},
  {"partition":"P-R3-01","id":"bare-Function-dead-code-eliminate","pass":"deadCodeEliminate","source":"var hidden=42;Function;answer=1;","answer":{"type":"number","value":1},"post":"clean-hidden"},
  {"partition":"P-R3-01","id":"bare-Function-control-flow-object","pass":"controlFlowObject","source":"var ops={text:\"x\"};Function;answer=ops.text;","answer":{"type":"string","value":"x"},"post":"no-storage"},
  {"partition":"P-R2-03","id":"invoked-eval","pass":"constantPropagate","source":"var value=1;(0,eval)(\"value=2\");answer=value;","answer":{"type":"number","value":2}},
  {"partition":"P-R2-03","id":"escaped-eval","pass":"constantPropagate","source":"var value=1;[ eval ].forEach(fn=>fn(\"value=2\"));answer=value;","answer":{"type":"number","value":2}},
  {"partition":"P-R2-03","id":"invoked-Function","pass":"constantPropagate","source":"var value=1;Function(\"value=2\")();answer=value;","answer":{"type":"number","value":2}},
  {"partition":"P-R2-03","id":"escaped-Function","pass":"constantPropagate","source":"var value=1;[ Function ].forEach(fn=>fn(\"value=2\")());answer=value;","answer":{"type":"number","value":2}},
  {"partition":"P-R2-04","id":"before-init:constant-propagate","pass":"constantPropagate","source":"let value=1;eval(\"value=42\");answer=value;var eval=function(code){return code;};","answer":{"type":"number","value":42}},
  {"partition":"P-R2-04","id":"before-init:constant-fold","pass":"constantFold","source":"function probe(){eval(\"var undefined=7\");answer=void 0;}probe();var eval=function(code){return code;};","answer":{"type":"undefined"}},
  {"partition":"P-R2-04","id":"block-order:constant-propagate","pass":"constantPropagate","source":"const saved=globalThis.eval;var eval=function(code){return code;};globalThis.eval=saved;{let value=1;eval(\"value=42\");answer=value;}","answer":{"type":"number","value":42}},
  {"partition":"P-R2-04","id":"compound-final:constant-propagate","pass":"constantPropagate","source":"const saved=globalThis.eval;var eval=function(code){return code;};globalThis.eval=saved;function probe(){var value=1;eval(\"value=42\");answer=value;}probe();","answer":{"type":"number","value":42}},
  {"partition":"P-R2-04","id":"constructor:constant-propagate","pass":"constantPropagate","source":"const actual=(function(){}).constructor;var Function=function(){return function(){};};let value=1;install(actual);Function(\"value=2\")();answer=value;function install(Constructor){globalThis.Function=Constructor;}","answer":{"type":"number","value":2}},
  {"partition":"P-R2-04","id":"immutable-callee-control","pass":"controlFlowObject","source":"const eval=function(code){return 1;};function probe(){const ops={call:function(f,s){return f(s);}};consume(globalThis);answer=ops.call(eval,\"ignored\");}probe();","answer":{"type":"number","value":1},"post":"no-ops-call","frame":"consume","effects":["consume"]},
  {"partition":"P-R2-05","id":"constant-fold:conditional","pass":"constantFold","source":"function probe(local){(true?eval:function(code){return code;})(\"local=42\");answer=local;}probe(1);","answer":{"type":"number","value":1},"post":"indirect-conditional"},
  {"partition":"P-R2-05","id":"constant-fold:grouped","pass":"constantFold","source":"function probe(local){((false?function(code){return code;}:(eval)))(\"local=42\");answer=local;}probe(1);","answer":{"type":"number","value":1},"post":"indirect-conditional"},
  {"partition":"P-R2-05","id":"constant-fold:parameter","pass":"constantFold","source":"(function(eval,local){(true?eval:function(code){return code;})(\"local=42\");answer=local;})(eval,1);","answer":{"type":"number","value":1},"post":"indirect-conditional"},
  {"partition":"P-R2-05","id":"constant-fold:ordinary","pass":"constantFold","source":"function probe(local){const eval=function(code){return code;};(true?eval:function(code){return code;})(\"local=42\");answer=local;}probe(1);","answer":{"type":"number","value":1},"post":"no-conditional"},
  {"partition":"P-R2-05","id":"constant-fold:optional","pass":"constantFold","source":"function probe(local){(true?eval:function(code){return code;})?.(\"local=42\");answer=local;}probe(1);","answer":{"type":"number","value":1},"post":"optional-selected"},
  {"partition":"P-R2-05","id":"dead-code-eliminate:conditional","pass":"deadCodeEliminate","source":"function probe(local){(true?eval:function(code){return code;})(\"local=42\");answer=local;}probe(1);","answer":{"type":"number","value":1},"post":"indirect-conditional"},
  {"partition":"P-R2-05","id":"dead-code-eliminate:grouped","pass":"deadCodeEliminate","source":"function probe(local){((false?function(code){return code;}:(eval)))(\"local=42\");answer=local;}probe(1);","answer":{"type":"number","value":1},"post":"indirect-conditional"},
  {"partition":"P-R2-05","id":"dead-code-eliminate:parameter","pass":"deadCodeEliminate","source":"(function(eval,local){(true?eval:function(code){return code;})(\"local=42\");answer=local;})(eval,1);","answer":{"type":"number","value":1},"post":"indirect-conditional"},
  {"partition":"P-R2-05","id":"dead-code-eliminate:ordinary","pass":"deadCodeEliminate","source":"function probe(local){const eval=function(code){return code;};(true?eval:function(code){return code;})(\"local=42\");answer=local;}probe(1);","answer":{"type":"number","value":1},"post":"no-conditional"},
  {"partition":"P-R2-05","id":"dead-code-eliminate:optional","pass":"deadCodeEliminate","source":"function probe(local){(true?eval:function(code){return code;})?.(\"local=42\");answer=local;}probe(1);","answer":{"type":"number","value":1},"post":"optional-selected"},
  {"partition":"P-R2-06","id":"with-initializer","pass":"constantPropagate","source":"function probe(){with({value:2}){var value=1;}answer=value;}probe();","answer":{"type":"undefined"}},
  {"partition":"P-R2-06","id":"with-setter","pass":"deadCodeEliminate","source":"function probe(){with({set value(x){events.push(x);}}){var value=7;}answer=1;}probe();","answer":{"type":"number","value":1},"events":{"type":"array","values":[{"type":"number","value":7}]}},
  {"partition":"P-R2-06","id":"global-pattern","pass":"constantPropagate","source":"var value=1;({x:globalThis.value}={x:2});answer=value;","answer":{"type":"number","value":2}},
  {"partition":"P-R2-06","id":"global-iteration","pass":"constantPropagate","source":"var value=1;for(globalThis.value of [2]){}answer=value;","answer":{"type":"number","value":2}},
  {"partition":"P-R2-06","id":"global-array-alias","pass":"constantPropagate","source":"const values=[1];var alias=values;globalThis.alias[0]=2;answer=values[0];","answer":{"type":"number","value":2}},
  {"partition":"P-R2-06","id":"global-storage","pass":"controlFlowObject","source":"var ops={text:\"x\"};globalThis.ops.text=\"y\";answer=ops.text;","answer":{"type":"string","value":"y"}},
  {"partition":"P-R2-06","id":"global-write-control:update","pass":"constantPropagate","source":"function chooseKey(){return \"value\";}globalThis.value=0;let value=1;globalThis[chooseKey()]++;answer=value;","answer":{"type":"number","value":1},"post":"numeric"},
  {"partition":"P-R2-07","id":"literal-pattern","pass":"semanticRename","source":"var _0xlen=[1].length;const {_0xlen:copy}=globalThis;answer=copy;","answer":{"type":"number","value":1}},
  {"partition":"P-R2-07","id":"rest-pattern","pass":"semanticRename","source":"var _0xlen=[1].length;const {...copy}=globalThis;answer=copy._0xlen;","answer":{"type":"number","value":1}},
  {"partition":"P-R2-07","id":"nested-pattern","pass":"semanticRename","source":"var _0xlen=[1].length;const {globalThis:{_0xlen:copy}}=globalThis;answer=copy;","answer":{"type":"number","value":1}},
  {"partition":"P-R2-07","id":"declaration-pattern","pass":"deadCodeEliminate","source":"var hidden=42;const {hidden:copy}=globalThis;answer=copy;","answer":{"type":"number","value":42}},
  {"partition":"P-R2-07","id":"storage-pattern","pass":"controlFlowObject","source":"var ops={text:\"x\"};const {ops:alias}=globalThis;answer=ops.text+alias.text;","answer":{"type":"string","value":"xx"}},
  {"partition":"P-R2-07","id":"pattern-value-alias","pass":"constantPropagate","source":"var values=[1];const {values:alias}=globalThis;alias[0]=2;answer=values[0];","answer":{"type":"number","value":2}},
  {"partition":"P-R2-07","id":"constructor-assignment","pass":"constantPropagate","source":"let value=1;var Constructor;({Function:Constructor}=globalThis);Constructor(\"value=2\")();answer=value;","answer":{"type":"number","value":2}},
  {"partition":"P-R2-07","id":"literal-sibling-control","pass":"constantPropagate","source":"var observed=1;var safe=2;const {observed:copy}=globalThis;answer=safe;","answer":{"type":"number","value":2},"post":"numeric"},
  {"partition":"P-R2-07","id":"lexical-control","pass":"constantPropagate","source":"let value=1;const {value:copy}=globalThis;answer=value;","answer":{"type":"number","value":1},"post":"numeric"},
  {"partition":"P-R2-07","id":"eval-setter","pass":"constantPropagate","source":"let value=1;const sink={set apply(run){run(\"value=2\");}};({eval:sink.apply}=globalThis);answer=value;","answer":{"type":"number","value":2}},
  {"partition":"P-R2-07","id":"escaped-code","pass":"constantPropagate","source":"let value=1;consume(globalThis);answer=value;","answer":{"type":"number","value":2},"frame":"consume","effects":["consume"]},
  {"partition":"P-R2-07","id":"iterator-code","pass":"constantPropagate","source":"let value=1;const [copy]=globalThis;answer=value;","answer":{"type":"number","value":2},"frame":"iterator","effects":["iterator",{"type":"undefined"}]},
  {"partition":"P-R2-07","id":"duplicate-root","pass":"constantPropagate","source":"let value=1;var {fake:root,globalThis:root}=globalThis;root.Function(\"value=2\")();answer=value;","answer":{"type":"number","value":2}},
  {"partition":"P-R2-07","id":"escaped-local-control","pass":"constantPropagate","source":"function probe(){let value=1;consume(globalThis);answer=value;}probe();","answer":{"type":"number","value":1},"post":"numeric","frame":"consume","effects":["consume"]},
  {"partition":"P-R2-07","id":"global-this-before-init","pass":"constantPropagate","source":"var value=1;globalThis.value=2;answer=value;var globalThis=function(){};","answer":{"type":"number","value":2}},
  {"partition":"P-R2-07","id":"global-this-no-init","pass":"constantPropagate","source":"var value=1;var globalThis;globalThis.value=2;answer=value;","answer":{"type":"number","value":2}},
  {"partition":"P-R2-07","id":"with-supplied-constructor","pass":"constantPropagate","source":"let value=1;with(external){Ctor(\"value=2\")();}answer=value;","answer":{"type":"number","value":2},"frame":"external","effects":[]},
  {"partition":"P-R2-07","id":"with-lexical-root-control","pass":"constantPropagate","source":"var value=1;with(external){const globalThis={};globalThis.value=2;}answer=value;","answer":{"type":"number","value":1},"post":"numeric","frame":"external","effects":[]},
  {"partition":"P-R2-08","id":"strict-value","pass":"astRename","source":"function outer(){var _0xlong=7;function child(_0xlong){\"use strict\";globalThis.answer=eval(\"typeof value\");}child(0);}outer();","answer":{"type":"string","value":"undefined"}},
  {"partition":"P-R2-08","id":"strict-len","pass":"semanticRename","source":"function outer(){var _0xlong=[1].length;function child(_0xlong){\"use strict\";globalThis.answer=eval(\"typeof len\");}child(0);}outer();","answer":{"type":"string","value":"undefined"}},
  {"partition":"P-R2-08","id":"hidden-candidate-control","pass":"semanticRename","source":"function outer(){var _0xlong=[1].length;function child(_0xlong,len){\"use strict\";globalThis.answer=eval(\"typeof len\");}child(0,9);}outer();","answer":{"type":"string","value":"number"},"post":"rename:_0xlong"},
  {"partition":"P-R2-09","id":"initializer-shadow","pass":"constantPropagate","source":"function probe(undefined){const value=undefined;answer=value;}probe(7);","answer":{"type":"number","value":7}},
  {"partition":"P-R4-01","id":"inherited-constructor-computed","pass":"constantPropagate","source":"var value=1;(function(){})[\"constructor\"](\"value=2\")();answer=value;","answer":{"type":"number","value":2}},
  {"partition":"P-R4-01","id":"inherited-constructor-arrow","pass":"constantPropagate","source":"var value=1;(()=>{}).constructor(\"value=2\")();answer=value;","answer":{"type":"number","value":2}},
  {"partition":"P-R4-01","id":"inherited-constructor-class","pass":"constantPropagate","source":"var value=1;(class{}).constructor(\"value=2\")();answer=value;","answer":{"type":"number","value":2}},
  {"partition":"P-R4-01","id":"inherited-constructor-shadowed-Function","pass":"constantPropagate","source":"var Function=function(){return function(){};};var value=1;(function(){}).constructor(\"value=2\")();answer=value;","answer":{"type":"number","value":2}},
  {"partition":"P-R4-01","id":"inherited-constructor-async","pass":"constantPropagate","source":"var value=1;(async function(){}).constructor(\"value=2\")();answer=value;","answer":{"type":"number","value":2}},
  {"partition":"P-R4-01","id":"inherited-constructor-generator","pass":"constantPropagate","source":"var value=1;(function*(){}).constructor(\"value=2\")().next();answer=value;","answer":{"type":"number","value":2}},
  {"partition":"P-R4-02","id":"own-function-constructor-control","pass":"constantPropagate","source":"const fn=function(){};fn.constructor=function(){return function(){};};var value=1;fn.constructor(\"value=2\")();answer=value;","answer":{"type":"number","value":1},"post":"numeric"},
  {"partition":"P-R4-02","id":"object-constructor-control","pass":"constantPropagate","source":"var value=1;({constructor:function(){return function(){}}}).constructor(\"value=2\")();answer=value;","answer":{"type":"number","value":1},"post":"numeric"},
];

describe("runtime name resolution additions", () => {
  it.each(runtimeBindingCases)("$partition $id preserves semantics and useful transforms", (row: any) => {
    const before = row.frame ? observeRuntimeFrame(row.source, row.frame) : observe(row.source);
    const output = runPass(row.pass, row.source);
    const after = row.frame ? observeRuntimeFrame(output.code, row.frame) : observe(output.code);
    record("addition-" + row.partition + "-" + row.id.replaceAll(":", "-"), {source: row.source, code: output.code, before, after, post: row.post});
    expect(before.completion.kind, "source completion").toBe(row.error ? "throw" : "normal");
    if (row.error) expect(before.completion.name, "source abrupt completion").toBe(row.error);
    expect(before.globals.answer, "source answer presence and value").toEqual(row.answer);
    if (row.frame) expect(before.effects, "source effects").toEqual(row.effects);
    else {
      expect(before.globals.events, "source effects").toEqual(row.events ?? encode([]));
      expect(before.stdout).toBe(""); expect(before.stderr).toBe("");
    }
    expect(after).toEqual(before);
    if (row.post) expectRuntimePostcondition(output.ast, row.post);
  });

  it.each([{"id":"import","source":"globalThis.answer=eval(\"typeof hidden\");throw new Error(\"sentinel\");import {sep as hidden} from \"node:path\";","answer":{"type":"string","value":"string"}},{"id":"export-var","source":"eval(\"hidden=42\");globalThis.answer=hidden;throw new Error(\"sentinel\");export var hidden;","answer":{"type":"number","value":42}},{"id":"export-function","source":"globalThis.answer=eval(\"hidden()\");throw new Error(\"sentinel\");export function hidden(){return 42;}","answer":{"type":"number","value":42}},{"id":"export-default-named-function","source":"globalThis.answer=eval(\"hidden()\");throw new Error(\"sentinel\");export default function hidden(){return 42;}","answer":{"type":"number","value":42}}] as any[])("P-R2-01 module $id retains instantiated bindings", (row: any) => {
    const execute = (code: string): any => {
      const prefix = 'globalThis.events=[];process.on("uncaughtException",error=>{process.stdout.write(JSON.stringify({completion:{name:error.name,message:error.message},answer:Object.hasOwn(globalThis,"answer")?{type:typeof globalThis.answer,value:globalThis.answer}:{type:"absent"},events:globalThis.events}));});';
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", prefix + code], {cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000});
      expect(result.error).toBeUndefined(); expect(result.signal).toBe(null); expect(result.status).toBe(0); expect(result.stderr).toBe("");
      return JSON.parse(result.stdout);
    };
    const output = runPass("deadCodeEliminate", row.source);
    const before = execute(row.source), after = execute(output.code);
    record("addition-module-" + row.id, {source: row.source, code: output.code, before, after});
    expect(before).toEqual({completion: {name: "Error", message: "sentinel"}, answer: row.answer, events: []});
    expect(after).toEqual(before);
  });
});
