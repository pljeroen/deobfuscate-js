import {spawnSync} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
const {ROOT, parser, load, hash, observe, nodes, record, productionFixtures} = await import(pathToFileURL(join(import.meta.dirname, "runtime-name-fixtures.ts")).href);
const {fingerprint} = await load("src/fingerprint.ts");
const NOTICE="WARNING: Unsafe mode enabled — string-array pass will execute untrusted code";
const modes=["default","unsafe"] as const;
const directory=mkdtempSync(join(tmpdir(),"runtime-name-"));
const cli: Record<string, any>={};
const runners: Record<string, any>={};
const input=join(directory,"fixtures.jsonl");
const dataset=productionFixtures.map((fixture: any) => ({filename:fixture.id,original:fixture.source,obfuscated:fixture.source,language:"javascript",test_cases:[],fixture_sha256:hash(fixture.source)}));
const inputBytes=dataset.map((row: any) => JSON.stringify(row)).join("\n")+"\n";
const warnings=(stderr: string): string[] => stderr.split(/[\r\n]+/).filter(line => line.startsWith("WARNING:") && line!==NOTICE).map(line => line.slice("WARNING: ".length));
function execute(argv: string[]): any {
  const result=spawnSync(process.execPath,argv,{cwd:ROOT,encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:60000,maxBuffer:10*1024*1024});
  return {argv:[process.execPath,...argv],cwd:ROOT,exit:result.status,signal:result.signal,error:result.error?.message,stdout:result.stdout,stderr:result.stderr};
}

beforeAll(() => {
  writeFileSync(input,inputBytes);
  for (const mode of modes) {
    for (const fixture of productionFixtures) {
      const source=join(directory,fixture.id+".js"),output=join(directory,fixture.id+"-"+mode+".js");
      writeFileSync(source,fixture.source);
      const result=execute(["--import","tsx","src/index.ts",...(mode==="unsafe"?["--unsafe"]:[]),source,output]);
      const code=existsSync(output)?readFileSync(output,"utf8"):null;
      cli[mode+":"+fixture.id]={...result,source_sha256:hash(fixture.source),output_sha256:code===null?null:hash(code),code};
    }
    for (const runner of ["bench-jsdeobsbench","bench-batch"]) {
      const output=join(directory,runner+"-"+mode+".jsonl");
      const args=runner==="bench-jsdeobsbench"?["--input",input,"--output",output]:[input,output];
      const result=execute(["--import","tsx","scripts/"+runner+".ts",...args,...(mode==="unsafe"?["--unsafe"]:[])]);
      const text=existsSync(output)?readFileSync(output,"utf8"):"";
      runners[mode+":"+runner]={...result,input_sha256:hash(inputBytes),output_sha256:hash(text),rows:text.trim()?text.trim().split("\n").map((line: string) => JSON.parse(line)):[]};
    }
  }
  record("production-executions",{input_sha256:hash(inputBytes),dataset,cli,runners});
},180000);
afterAll(() => rmSync(directory,{recursive:true,force:true}));

for (const mode of modes) describe(mode+" production composition", () => {
  it.each(productionFixtures as Array<{id: string; source: string}>)("$id preserves runtime observation through the real CLI", (fixture: any) => {
    const result=cli[mode+":"+fixture.id];
    expect(result.error).toBeUndefined();expect(result.exit).toBe(0);expect(result.signal).toBe(null);
    expect(typeof result.code).toBe("string");expect(result.code.length).toBeGreaterThan(0);
    const lines=result.stderr.split(/[\r\n]+/).filter(Boolean);
    expect(lines.filter((line: string) => line===NOTICE)).toHaveLength(mode==="unsafe"?1:0);
    const before=observe(fixture.source),after=observe(result.code);
    expect(before.completion.kind).toBe("normal");
    expect(after).toEqual(before);
    const messages=warnings(result.stderr);
    expect(messages).toEqual(fixture.expectedWarnings ?? []);
    expect(lines.filter((line: string) => !line.startsWith("WARNING:"))).toEqual([]);
    if(fixture.id==="clean-sibling") expect(nodes(parser.parse(result.code),"VariableDeclarator").some((node: any) => node.id.name==="_0xlen")).toBe(false);
    if(fixture.id.startsWith("proxy-")) {
      const fp=fingerprint(parser.parse(fixture.source));
      expect(fp.obfuscator).toBe(fixture.id==="proxy-inactive"?null:"javascript-obfuscator");
      expect(nodes(parser.parse(result.code),"CallExpression").filter((node: any) => !node.optional && node.callee.type==="Identifier" && node.callee.name==="eval")).toHaveLength(0);
    }
  });

  it.each(["bench-jsdeobsbench","bench-batch"])("%s public invocation retains exact per-mode CLI parity", (runner: string) => {
    const result=runners[mode+":"+runner];
    expect(result.error).toBeUndefined();expect(result.exit).toBe(0);expect(result.signal).toBe(null);
    expect(result.rows.map((row: any) => row.filename)).toEqual(dataset.map((row: any) => row.filename));
    const expectedWarnings: string[]=[];
    for (let index=0;index<dataset.length;index++) {
      const expected=dataset[index],actual=result.rows[index];
      const {deobfuscated,task_id,task_type,...fields}=actual;
      expect(fields).toEqual(expected);
      expect(deobfuscated).toBe(cli[mode+":"+expected.filename].code);
      expectedWarnings.push(...warnings(cli[mode+":"+expected.filename].stderr).map(message => "Warning on "+expected.filename+": "+message));
      if(runner==="bench-batch") {expect(task_id).toBe(index);expect(task_type).toBe("deobfuscation");}
    }
    const lines=result.stderr.split(/[\r\n]+/).filter(Boolean);
    expect(lines.filter((line: string) => line.startsWith("Warning on "))).toEqual(expectedWarnings);
    expect(lines.filter((line: string) => line.startsWith("Error on "))).toEqual([]);
    expect(lines.filter((line: string) => line===NOTICE)).toEqual([]);
  });
});
