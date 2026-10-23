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
    const linked = facts.annexBLinkedBindings(ast);
    expect(linked.has(bindings.left)).toBe(true); expect(linked.has(bindings.right)).toBe(false);
    const owners = facts.annexBRetainedFunctionOwners(ast).get("linked");
    expect([...owners].map((owner: any) => owner.node.id.name)).toEqual(["left"]);
  });

  it("exposed fact answers survive attempted result mutation", () => {
    const ast = parser.parse('function owner(){var linked=0;{function linked(){}}return linked;}');
    const linked = facts.annexBLinkedBindings(ast);
    const owners = facts.annexBRetainedFunctionOwners(ast);
    const members = [...linked], ownerMembers = [...owners.get("linked")];
    expect(members.length).toBe(1); expect(ownerMembers.length).toBe(1);
    const attempts: any[] = [];
    for (const target of [linked, owners.get("linked"), owners]) {
      try {target.clear?.(); attempts.push("returned");} catch (error: any) {attempts.push(error.name);}
    }
    record("fact-mutation", {attempts, linkedAfter: linked.size, ownersAfter: owners.size});
    expect([...linked]).toEqual(members);
    expect([...owners.get("linked") ?? []]).toEqual(ownerMembers);
    expect([...facts.annexBLinkedBindings(ast)]).toEqual(members);
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
