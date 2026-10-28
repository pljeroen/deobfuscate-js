import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { t, traverse } from "../../src/babel.js";
import { deadCodeEliminatePass } from "../../src/passes/dead-code-eliminate.js";
import { runtimeNameFacts } from "../../src/passes/annex-b-linkage.js";
import { parse, generate } from "../../src/parser.js";

function dce(code: string): string {
  const ast = parse(code);
  const result = deadCodeEliminatePass.run(ast);
  return generate(result);
}

type GlobalObservation = { present: boolean; value?: unknown };
type ExecutionObservation = {
  completion: "normal" | "throw";
  errorName: string | null;
  globals: Record<string, GlobalObservation>;
};

function present(value: unknown): GlobalObservation {
  return { present: true, value: value === undefined ? "<undefined>" : value };
}

function absent(): GlobalObservation {
  return { present: false };
}

function normal(globals: Record<string, GlobalObservation>): ExecutionObservation {
  return { completion: "normal", errorName: null, globals };
}

function thrown(errorName: string, globals: Record<string, GlobalObservation>): ExecutionObservation {
  return { completion: "throw", errorName, globals };
}

function executeFresh(code: string, names: readonly string[]): ExecutionObservation {
  const context = vm.createContext(Object.create(null));
  const globals = (): Record<string, GlobalObservation> => Object.fromEntries(
    names.map((name) => {
      const isPresent = Object.prototype.hasOwnProperty.call(context, name);
      return [name, isPresent ? present(Reflect.get(context, name)) : absent()];
    }),
  );
  try {
    vm.runInContext(code, context, { timeout: 2_000 });
    return { completion: "normal", errorName: null, globals: globals() };
  } catch (error: unknown) {
    const errorName =
      typeof error === "object" && error !== null && "name" in error
        ? String((error as { name: unknown }).name)
        : typeof error;
    return { completion: "throw", errorName, globals: globals() };
  }
}

function containsPath(path: any, ancestor: any): boolean {
  for (let current = path; current; current = current.parentPath) {
    if (current === ancestor) return true;
  }
  return false;
}

function declarationMatches(path: any, name: string): boolean {
  if (path.isVariableDeclarator()) {
    return Object.prototype.hasOwnProperty.call(t.getBindingIdentifiers(path.node.id), name);
  }
  return (path.isFunctionDeclaration() || path.isClassDeclaration()) && path.node.id?.name === name;
}

function declarationBindingFacts(
  source: string,
  name: string,
  site: "branch" | "tail",
): {
  declarationType: string;
  referencePaths: number;
  constantViolations: number;
  externalReferences: number;
  externalViolations: number;
} {
  const ast = parse(source);
  let declaration: any;
  traverse(ast, {
    enter(path: any) {
      if (!declaration && declarationMatches(path, name)) declaration = path;
    },
  });
  expect(declaration, `declaration ${name}`).toBeDefined();
  const binding = declaration?.scope.getBinding(name);
  expect(binding, `binding ${name}`).toBeDefined();

  let candidate = declaration;
  if (site === "branch") {
    for (let current = declaration; current?.parentPath; current = current.parentPath) {
      const parent = current.parentPath;
      if (!parent.isIfStatement() || !t.isBooleanLiteral(parent.node.test)) continue;
      const discarded = parent.get(parent.node.test.value ? "alternate" : "consequent");
      if (discarded?.node && containsPath(declaration, discarded)) {
        candidate = discarded;
        break;
      }
    }
  } else {
    while (candidate?.parentPath && !candidate.isStatement()) candidate = candidate.parentPath;
  }
  expect(candidate?.node, `deletion candidate for ${name}`).toBeDefined();

  return {
    declarationType: declaration?.node.type,
    referencePaths: binding?.referencePaths.length ?? -1,
    constantViolations: binding?.constantViolations.length ?? -1,
    externalReferences: binding?.referencePaths.filter((path: any) => !containsPath(path, candidate)).length ?? -1,
    externalViolations: binding?.constantViolations.filter((path: any) => !containsPath(path, candidate)).length ?? -1,
  };
}

function declarationCount(code: string, name: string): number {
  let count = 0;
  traverse(parse(code), {
    enter(path: any) {
      if (declarationMatches(path, name)) count += 1;
    },
  });
  return count;
}

function nodeTypeCount(code: string, type: string): number {
  let count = 0;
  traverse(parse(code), {
    enter(path: any) {
      if (path.node.type === type) count += 1;
    },
  });
  return count;
}

let moduleNonce = 0;
async function executeModule(code: string): Promise<ExecutionObservation> {
  const specifier = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}#dce-${moduleNonce++}`;
  try {
    const namespace = await import(specifier);
    return normal({ answer: present(namespace.default) });
  } catch (error: unknown) {
    const errorName =
      typeof error === "object" && error !== null && "name" in error
        ? String((error as { name: unknown }).name)
        : typeof error;
    return thrown(errorName, { answer: absent() });
  }
}

describe("dead code elimination", () => {
  describe("unreachable branches", () => {
    it("removes if(false) block", () => {
      const result = dce("if (false) { console.log('dead'); }");
      expect(result).not.toContain("dead");
    });

    it("simplifies if(true) to consequent only", () => {
      const result = dce("if (true) { console.log('alive'); } else { console.log('dead'); }");
      expect(result).toContain("alive");
      expect(result).not.toContain("dead");
    });

    it("simplifies if(false) with else to alternate only", () => {
      const result = dce("if (false) { console.log('dead'); } else { console.log('alive'); }");
      expect(result).toContain("alive");
      expect(result).not.toContain("dead");
    });

    it("removes if(!true) block", () => {
      const result = dce("if (!true) { console.log('dead'); }");
      expect(result).not.toContain("dead");
    });
  });

  describe("ternary expressions", () => {
    it("simplifies true ? a : b to a", () => {
      const result = dce("console.log(true ? 'yes' : 'no');");
      expect(result).toContain("yes");
      expect(result).not.toContain("no");
    });

    it("simplifies false ? a : b to b", () => {
      const result = dce("console.log(false ? 'yes' : 'no');");
      expect(result).toContain("no");
      expect(result).not.toContain("yes");
    });
  });

  describe("unused variables", () => {
    it("removes unused const declaration", () => {
      const result = dce("const unused = 42; console.log('used');");
      expect(result).not.toContain("unused");
      expect(result).not.toContain("42");
      expect(result).toContain("used");
    });

    it("removes unused var declaration with literal value", () => {
      const result = dce("var unused = 'dead'; var used = 'alive'; console.log(used);");
      expect(result).not.toContain("dead");
      expect(result).toContain("alive");
    });

    it("does not remove variables with side effects in initializer", () => {
      const result = dce("var x = sideEffect(); console.log('ok');");
      // x is unused but sideEffect() may have effects — keep the call
      expect(result).toContain("sideEffect()");
    });

    it("does not remove variables that are referenced", () => {
      const result = dce("const x = 42; console.log(x);");
      expect(result).toContain("42");
    });
  });

  describe("unreachable code after return", () => {
    it("removes statements after return in function", () => {
      const result = dce("function f() { return 1; console.log('dead'); }");
      expect(result).not.toContain("dead");
      expect(result).toContain("return 1");
    });

    it("removes statements after throw", () => {
      const result = dce("function f() { throw new Error(); console.log('dead'); }");
      expect(result).not.toContain("dead");
    });
  });

  describe("preserves live code", () => {
    it("preserves normal if with variable condition", () => {
      const result = dce("if (x) { console.log('maybe'); }");
      expect(result).toContain("maybe");
    });

    it("preserves used variables", () => {
      const result = dce("const x = 1; const y = x + 2; console.log(y);");
      // x is used by y, y is used by console.log — both should stay
      expect(result).toContain("x + 2");
    });
  });

  describe("hoisted function declarations after return", () => {
    it("preserves FunctionDeclaration after return in IIFE", () => {
      const result = dce(`
        (function(data) {
          return data.map(stdev).join("\\n");
          function stdev(scores) {
            return scores.reduce(sum) / scores.length;
          }
          function sum(a, b) {
            return a + b;
          }
        })(input);
      `);
      // FunctionDeclarations are hoisted — must survive even after return
      expect(result).toContain("stdev");
      expect(result).toContain("sum");
    });

    it("still removes non-hoisted statements after return", () => {
      const result = dce(`
        function f() {
          return 1;
          var x = 2;
          console.log("dead");
        }
      `);
      expect(result).not.toContain("dead");
      expect(result).not.toContain("var x");
    });

    it("preserves FunctionDeclaration after throw", () => {
      const result = dce(`
        function f(x) {
          throw new Error(helper(x));
          function helper(v) { return v * 2; }
        }
      `);
      expect(result).toContain("helper");
    });
  });

  describe("declaration-instantiation retention", () => {
    it("preserves the W-DI-01 Annex-B owner binding in a discarded consequent", () => {
      const source = "if(false) function f(){}; globalThis.answer=f;";
      const expected = normal({ answer: present(undefined) });
      const binding = declarationBindingFacts(source, "f", "branch");
      const transformed = dce(source);

      expect(executeFresh(source, ["answer"])).toEqual(expected);
      expect(binding).toEqual({
        declarationType: "FunctionDeclaration",
        referencePaths: 1,
        constantViolations: 0,
        externalReferences: 1,
        externalViolations: 0,
      });
      expect(executeFresh(transformed, ["answer"])).toEqual(expected);
      expect(declarationCount(transformed, "f")).toBe(1);
    });

    const externalReferenceCases = [
      {
        id: "discarded consequent var",
        source: "function probe(){if(false){var branchCell;}globalThis.answer=branchCell;}probe();",
        name: "branchCell",
        site: "branch" as const,
        observed: ["answer"],
        expected: normal({ answer: present(undefined) }),
      },
      {
        id: "discarded alternate var",
        source: "function probe(){if(true){}else{var alternateCell;}globalThis.answer=alternateCell;}probe();",
        name: "alternateCell",
        site: "branch" as const,
        observed: ["answer"],
        expected: normal({ answer: present(undefined) }),
      },
      {
        id: "W-DI-02 return var",
        source: "function probe(){globalThis.answer=hidden;return;var hidden;}probe();",
        name: "hidden",
        site: "tail" as const,
        observed: ["answer"],
        expected: normal({ answer: present(undefined) }),
      },
      {
        id: "throw tail var",
        source: "function probe(){globalThis.answer=hidden;throw new Error('expected');var hidden;}try{probe();}catch(error){globalThis.caught=error.message;}",
        name: "hidden",
        site: "tail" as const,
        observed: ["answer", "caught"],
        expected: normal({ answer: present(undefined), caught: present("expected") }),
      },
      {
        id: "break tail var",
        source: "function probe(){while(true){globalThis.answer=hidden;break;var hidden;}}probe();",
        name: "hidden",
        site: "tail" as const,
        observed: ["answer"],
        expected: normal({ answer: present(undefined) }),
      },
      {
        id: "continue tail var",
        source: "function probe(){for(let count=0;count<1;count++){globalThis.answer=hidden;continue;var hidden;}}probe();",
        name: "hidden",
        site: "tail" as const,
        observed: ["answer"],
        expected: normal({ answer: present(undefined) }),
      },
      {
        id: "destructure tail var",
        source: "function initializer(){globalThis.initializerRan=true;return {hidden:1};}function probe(){globalThis.answer=hidden;return;var {hidden}=initializer();}probe();",
        name: "hidden",
        site: "tail" as const,
        observed: ["answer", "initializerRan"],
        expected: normal({ answer: present(undefined), initializerRan: absent() }),
      },
    ] as const;

    it.each(externalReferenceCases)("external referencePath: $id", ({ source, name, site, observed, expected }) => {
      const binding = declarationBindingFacts(source, name, site);
      const transformed = dce(source);

      expect(executeFresh(source, observed)).toEqual(expected);
      expect(binding.referencePaths).toBe(1);
      expect(binding.constantViolations).toBe(0);
      expect(binding.externalReferences).toBe(1);
      expect(binding.externalViolations).toBe(0);
      expect(executeFresh(transformed, observed)).toEqual(expected);
      expect(declarationCount(transformed, name)).toBe(1);
    });

    const strictExternalWriteCases = [
      {
        id: "branch read/write",
        source: "function probe(){'use strict';if(false){var branchCell;}branchCell=7;globalThis.answer=branchCell;}probe();",
        name: "branchCell",
        site: "branch" as const,
        references: 1,
        answer: 7,
      },
      {
        id: "branch write-only",
        source: "function probe(){'use strict';if(false){var branchCell;}branchCell=7;globalThis.answer=1;}probe();",
        name: "branchCell",
        site: "branch" as const,
        references: 0,
        answer: 1,
      },
      {
        id: "tail read/write",
        source: "function probe(){'use strict';hidden=7;globalThis.answer=hidden;return;var hidden;}probe();",
        name: "hidden",
        site: "tail" as const,
        references: 1,
        answer: 7,
      },
      {
        id: "tail write-only",
        source: "function probe(){'use strict';hidden=7;globalThis.answer=1;return;var hidden;}probe();",
        name: "hidden",
        site: "tail" as const,
        references: 0,
        answer: 1,
      },
    ] as const;

    it.each(strictExternalWriteCases)("external constantViolation: $id", ({ source, name, site, references, answer }) => {
      const expected = normal({ answer: present(answer) });
      const binding = declarationBindingFacts(source, name, site);
      const transformed = dce(source);

      expect(executeFresh(source, ["answer"])).toEqual(expected);
      expect(binding.referencePaths).toBe(references);
      expect(binding.constantViolations).toBe(1);
      expect(binding.externalReferences).toBe(references);
      expect(binding.externalViolations).toBe(1);
      expect(executeFresh(transformed, ["answer"])).toEqual(expected);
      expect(declarationCount(transformed, name)).toBe(1);
    });

    const tdzCases = [
      {
        id: "W-DI-TDZ-LET",
        source: "function probe(){globalThis.answer=typeof hidden;return;let hidden;}probe();",
        name: "hidden",
        declarationType: "VariableDeclarator",
      },
      {
        id: "W-DI-TDZ-CLASS",
        source: "function probe(){globalThis.answer=typeof Hidden;return;class Hidden{}}probe();",
        name: "Hidden",
        declarationType: "ClassDeclaration",
      },
    ] as const;

    it.each(tdzCases)("external TDZ reference: $id", ({ source, name, declarationType }) => {
      const expected = thrown("ReferenceError", { answer: absent() });
      const binding = declarationBindingFacts(source, name, "tail");
      const transformed = dce(source);

      expect(executeFresh(source, ["answer"])).toEqual(expected);
      expect(binding).toEqual({
        declarationType,
        referencePaths: 1,
        constantViolations: 0,
        externalReferences: 1,
        externalViolations: 0,
      });
      expect(executeFresh(transformed, ["answer"])).toEqual(expected);
      expect(declarationCount(transformed, name)).toBe(1);
    });

    it("removes a discarded candidate whose binding edges are internal only", () => {
      const source = "function probe(){if(false){var local;local=1;globalThis.dead=local;}globalThis.answer=42;}probe();";
      const expected = normal({ answer: present(42), dead: absent() });
      const binding = declarationBindingFacts(source, "local", "branch");
      const transformed = dce(source);

      expect(binding.referencePaths).toBe(1);
      expect(binding.constantViolations).toBe(1);
      expect(binding.externalReferences).toBe(0);
      expect(binding.externalViolations).toBe(0);
      expect(executeFresh(source, ["answer", "dead"])).toEqual(expected);
      expect(executeFresh(transformed, ["answer", "dead"])).toEqual(expected);
      expect(declarationCount(transformed, "local")).toBe(0);
      expect(transformed).not.toContain("dead");
    });

    it("keeps the selected var branch correct and flattenable", () => {
      const source = "function probe(){if(true){var selected=7;}globalThis.answer=selected;}probe();";
      const expected = normal({ answer: present(7) });
      const transformed = dce(source);

      expect(executeFresh(source, ["answer"])).toEqual(expected);
      expect(executeFresh(transformed, ["answer"])).toEqual(expected);
      expect(nodeTypeCount(transformed, "IfStatement")).toBe(0);
      expect(declarationCount(transformed, "selected")).toBe(1);
    });

    it("does not synthesize an Annex-B owner for a strict Script block function", () => {
      const source = "function probe(){'use strict';if(false){function local(){}}globalThis.answer=typeof local;}probe();";
      const expected = normal({ answer: present("undefined") });
      const ast = parse(source);
      const facts = runtimeNameFacts(ast);
      const transformed = dce(source);

      expect(facts.owners.get("local")).toBeUndefined();
      expect(executeFresh(source, ["answer"])).toEqual(expected);
      expect(executeFresh(transformed, ["answer"])).toEqual(expected);
      expect(declarationCount(transformed, "local")).toBe(0);
    });

    it("does not synthesize an Annex-B owner for a Module block function", async () => {
      const source = "if(false){function local(){}}export default typeof local;";
      const expected = normal({ answer: present("undefined") });
      const ast = parse(source);
      const facts = runtimeNameFacts(ast);
      const transformed = dce(source);

      expect(ast.program.sourceType).toBe("module");
      expect(facts.owners.get("local")).toBeUndefined();
      expect(await executeModule(source)).toEqual(expected);
      expect(await executeModule(transformed)).toEqual(expected);
      expect(declarationCount(transformed, "local")).toBe(0);
    });

    it.each([
      {
        id: "let",
        source: "function probe(){if(false){let local=1;}globalThis.answer=3;}probe();",
        name: "local",
      },
      {
        id: "class",
        source: "function probe(){if(false){class Local{}}globalThis.answer=3;}probe();",
        name: "Local",
      },
    ])("removes an unobserved discarded $id declaration", ({ source, name }) => {
      const expected = normal({ answer: present(3) });
      const transformed = dce(source);

      expect(executeFresh(source, ["answer"])).toEqual(expected);
      expect(executeFresh(transformed, ["answer"])).toEqual(expected);
      expect(declarationCount(transformed, name)).toBe(0);
    });

    it("removes declaration-free post-return code", () => {
      const source = "function probe(){globalThis.answer=42;return;globalThis.dead=99;}probe();";
      const expected = normal({ answer: present(42), dead: absent() });
      const transformed = dce(source);

      expect(executeFresh(source, ["answer", "dead"])).toEqual(expected);
      expect(executeFresh(transformed, ["answer", "dead"])).toEqual(expected);
      expect(transformed).not.toContain("dead");
    });

    it("keeps Pass 3 external-edge preservation and zero-edge removal load-bearing", () => {
      const source = "function probe(){var used=7;var unused=9;globalThis.answer=used;}probe();";
      const expected = normal({ answer: present(7) });
      const transformed = dce(source);

      expect(executeFresh(source, ["answer"])).toEqual(expected);
      expect(executeFresh(transformed, ["answer"])).toEqual(expected);
      expect(declarationCount(transformed, "used")).toBe(1);
      expect(declarationCount(transformed, "unused")).toBe(0);
    });

    it("keeps Pass 4 external-edge preservation and zero-edge removal load-bearing", () => {
      const source = "function outer(){function used(){return 7;}function unused(){return 9;}globalThis.answer=used();}outer();";
      const expected = normal({ answer: present(7) });
      const transformed = dce(source);

      expect(executeFresh(source, ["answer"])).toEqual(expected);
      expect(executeFresh(transformed, ["answer"])).toEqual(expected);
      expect(declarationCount(transformed, "used")).toBe(1);
      expect(declarationCount(transformed, "unused")).toBe(0);
    });

    it("preserves owner-only Annex-B retention without static edges", () => {
      const name = "ownerOnly";
      const source = "if(false){function ownerOnly(){}}globalThis.answer=1;";
      const ast = parse(source);
      let declaration: any;
      let program: any;
      traverse(ast, {
        Program(path: any) {
          program = path;
        },
        FunctionDeclaration(path: any) {
          if (path.node.id?.name === name) declaration = path;
        },
      });
      expect(declaration, `declaration ${name}`).toBeDefined();
      const binding = declaration?.scope.getBinding(name);
      const owner = declaration?.getFunctionParent() ?? program;
      expect(binding, `binding ${name}`).toBeDefined();
      expect(owner, `owner ${name}`).toBeDefined();

      const facts = runtimeNameFacts(ast);
      expect(binding.referencePaths).toHaveLength(0);
      expect(binding.constantViolations).toHaveLength(0);
      expect(facts.observed(binding)).toBe(false);
      expect(facts.owners.get(name)?.has(owner)).toBe(true);

      const transformed = generate(deadCodeEliminatePass.run(ast));
      expect(declarationCount(transformed, name)).toBe(1);
    });
  });
});
