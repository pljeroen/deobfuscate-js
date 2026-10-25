import { traverse, t } from "../babel.js";
import type { File } from "@babel/types";

/** Runtime name relations for one current tree. No mutable collections escape. */
export type RuntimeNameFacts = Readonly<{
  linked: ReadonlySet<unknown>;
  owners: ReadonlyMap<string, ReadonlySet<object>>;
  observed(binding: any): boolean;
  written(binding: any): boolean;
  dynamicLookup(site: any, name: string): boolean;
  intrinsicAt(site: any, name: string): boolean;
  intrinsicReadsSafe(site: any): boolean;
  evaluationSafe(site: any): boolean;
  renameUnavailable(binding: any, name: string): boolean;
  possibleDirectEval(callee: t.Node, site: any): boolean;
  wouldCreateDirectEval(replacement: t.Node, site: any): boolean;
}>;

function readonlySet<T>(values: Iterable<T>): ReadonlySet<T> {
  const data = new Set(values);
  const result: ReadonlySet<T> = Object.freeze({
    get size() { return data.size; },
    has: (value: T) => data.has(value),
    entries: () => data.entries(), keys: () => data.keys(), values: () => data.values(),
    [Symbol.iterator]: () => data.values(),
    forEach: (callback: (value: T, key: T, set: ReadonlySet<T>) => void, receiver?: unknown) => {
      data.forEach(value => callback.call(receiver, value, value, result));
    },
  });
  return result;
}

function readonlyMap<K, V>(values: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const data = new Map(values);
  const result: ReadonlyMap<K, V> = Object.freeze({
    get size() { return data.size; },
    has: (key: K) => data.has(key), get: (key: K) => data.get(key),
    entries: () => data.entries(), keys: () => data.keys(), values: () => data.values(),
    [Symbol.iterator]: () => data.entries(),
    forEach: (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, receiver?: unknown) => {
      data.forEach((value, key) => callback.call(receiver, value, key, result));
    },
  });
  return result;
}

/** Derive afresh after reparse or scope.crawl; binding identities belong to this snapshot. */
export function runtimeNameFacts(ast: File): RuntimeNameFacts {
  const linked = new Set<unknown>();
  const owners = new Map<string, Set<object>>();
  const observed = new Set<unknown>();
  const written = new Set<unknown>();
  const cellWrites = new Set<unknown>();
  const introduced = new Set<any>();
  const directScopes = new Set<any>();
  const paths: any[] = [];
  const codeValues: { node: any; site: any }[] = [];
  let program: any;
  traverse(ast, { enter(path: any) { paths.push(path); if (path.isProgram()) program = path; } });
  const script = ast.program.sourceType !== "module" || ((ast as any).errors?.length ?? 0) > 0;
  const mark = (binding: any, write = true): void => {
    if (!binding) return;
    observed.add(binding);
    if (write) {
      written.add(binding);
      if (binding.kind !== "const") cellWrites.add(binding);
    }
  };
  const under = (site: any, ancestor: any): boolean => {
    for (let p = site; p; p = p.parentPath) if (p === ancestor) return true;
    return false;
  };
  const withLookup = (site: any, name: string, resolutionScope = site.scope.getBinding(name)?.scope): boolean => {
    for (let p = site; p?.parentPath; p = p.parentPath) {
      if (!p.parentPath.isWithStatement() || p.key !== "body") continue;
      // Lexical declarations/parameters inside the body precede the object environment.
      if (!resolutionScope || !under(resolutionScope.path, p)) return true;
    }
    return false;
  };
  const dynamicLookup = (site: any, name: string): boolean => {
    if (withLookup(site, name)) return true;
    const binding = site.scope.getBinding(name);
    for (let scope = site.scope; scope; scope = scope.parent) {
      if (introduced.has(scope)) return true;
      if (binding?.scope === scope) return false;
    }
    return false;
  };
  const intrinsicAt = (site: any, name: string): boolean =>
    !site.scope.getBinding(name) && !dynamicLookup(site, name);

  // One Annex B discovery, retaining the owner and resolved-binding distinctions.
  for (const path of paths) {
    if (!path.isFunctionDeclaration()) continue;
    const { node, parentPath } = path;
    if (!node.id || node.async || node.generator || path.isInStrictMode()) continue;
    const owner = path.getFunctionParent() ?? program;
    const boundary = parentPath.isSwitchCase()
      || (parentPath.isBlockStatement() && (!owner.isFunction() || parentPath.node !== owner.node.body));
    if (!boundary) continue;
    if (!owners.has(node.id.name)) owners.set(node.id.name, new Set());
    owners.get(node.id.name)!.add(owner);
    const binding = owner.scope.getBinding(node.id.name);
    if (!binding) continue;
    if (binding.scope === owner.scope && !["var", "hoisted", "local"].includes(binding.kind)) continue;
    linked.add(binding);
    mark(binding);
  }

  const isWriteTarget = (site: any): boolean => {
    let position = site;
    for (let parent = position.parentPath; parent; parent = position.parentPath) {
      if ((parent.isAssignmentExpression() && parent.node.left === position.node)
        || (parent.isUpdateExpression() && parent.node.argument === position.node)
        || (parent.isUnaryExpression({ operator: "delete" }) && parent.node.argument === position.node)
        || ((parent.isForInStatement() || parent.isForOfStatement()) && parent.node.left === position.node)) return true;
      const transparent = parent.isParenthesizedExpression() || parent.isObjectPattern() || parent.isArrayPattern()
        || (parent.isObjectProperty() && parent.parentPath?.isObjectPattern() && parent.node.value === position.node)
        || (parent.isAssignmentPattern() && parent.node.left === position.node)
        || (parent.isRestElement() && parent.node.argument === position.node);
      if (!transparent) return false;
      position = parent;
    }
    return false;
  };
  const mutatesValue = (site: any): boolean => {
    let position = site;
    while ((position.parentPath?.isMemberExpression() || position.parentPath?.isOptionalMemberExpression())
      && position.parentPath.node.object === position.node) position = position.parentPath;
    return position !== site && isWriteTarget(position);
  };
  const markValueMutation = (binding: any, seen = new Set<any>()): void => {
    if (!binding || seen.has(binding)) return;
    seen.add(binding);
    const init = binding.path.isVariableDeclarator() ? binding.path.node.init : null;
    if (t.isNumericLiteral(init) || t.isStringLiteral(init) || t.isBooleanLiteral(init) || t.isNullLiteral(init)) return;
    written.add(binding);
    if (t.isIdentifier(init)) markValueMutation(binding.path.scope.getBinding(init.name), seen);
    for (const violation of binding.constantViolations) {
      if (violation.isAssignmentExpression() && t.isIdentifier(violation.node.right))
        markValueMutation(violation.scope.getBinding(violation.node.right.name), seen);
    }
  };
  const patternSources = (pattern: any, value: any): [any, any][] => {
    if (t.isIdentifier(pattern)) return [[pattern, value]];
    if (t.isAssignmentPattern(pattern))
      return patternSources(pattern.left, t.logicalExpression("??", t.cloneNode(value), t.cloneNode(pattern.right)));
    if (t.isObjectPattern(pattern)) {
      return pattern.properties.flatMap((property: any) => t.isObjectProperty(property)
        ? patternSources(property.value, t.memberExpression(t.cloneNode(value), t.cloneNode(property.key), property.computed || !t.isIdentifier(property.key)))
        : []);
    }
    if (t.isArrayPattern(pattern)) {
      return pattern.elements.flatMap((element: any, index: number) =>
        patternSources(element, t.memberExpression(t.cloneNode(value), t.numericLiteral(index), true)));
    }
    return [];
  };
  const propertyName = (key: any, computed: boolean): string | null =>
    !computed && t.isIdentifier(key) ? key.name : t.isStringLiteral(key) ? key.value : null;

  // A may-origin relation, including reassigned aliases: uncertainty never proves independence.
  const EVAL = 1, CONSTRUCTOR = 2, ROOT = 4, CREATED = 8, CALLABLE = 16;
  const hasOwnConstructorOverride = (node: any, lookupSite: any, accessSite = lookupSite,
    seen = new Set<any>()): boolean => {
    if (!t.isIdentifier(node)) return false;
    const binding = lookupSite.scope.getBinding(node.name);
    if (!binding || seen.has(binding)) return false;
    const accessStart = accessSite.node.start;
    for (const reference of binding.referencePaths) {
      const member = reference.parentPath;
      if (!(member?.isMemberExpression() || member?.isOptionalMemberExpression())
        || member.node.object !== reference.node
        || propertyName(member.node.property, member.node.computed) !== "constructor"
        || !isWriteTarget(member)) continue;
      if (typeof member.node.end !== "number" || typeof accessStart !== "number"
        || member.node.end <= accessStart) return true;
    }
    if (!binding.path.isVariableDeclarator() || !binding.path.node.init) return false;
    const next = new Set(seen); next.add(binding);
    return hasOwnConstructorOverride(binding.path.node.init, binding.path, accessSite, next);
  };
  const origin = (node: any, site: any, seen = new Set<any>()): number => {
    if (!node) return 0;
    if (t.isParenthesizedExpression(node)) return origin(node.expression, site, seen);
    if (t.isSequenceExpression(node)) return origin(node.expressions.at(-1), site, seen);
    if (t.isConditionalExpression(node)) return origin(node.consequent, site, seen) | origin(node.alternate, site, seen);
    if (t.isLogicalExpression(node)) return origin(node.left, site, seen) | origin(node.right, site, seen);
    if (t.isAssignmentExpression(node)) return origin(node.right, site, seen);
    if (t.isThisExpression(node)) {
      const owner = site.findParent((p: any) => p.isFunction() && !p.isArrowFunctionExpression());
      return script && !owner ? ROOT : 0;
    }
    if (t.isIdentifier(node)) {
      const binding = site.scope.getBinding(node.name);
      const named = node.name === "eval" ? EVAL : node.name === "Function" ? CONSTRUCTOR : 0;
      if (dynamicLookup(site, node.name)) return EVAL | CONSTRUCTOR | ROOT | CREATED;
      if (!binding) return named | (node.name === "globalThis" ? ROOT : 0);
      const rootSlot = node.name === "globalThis" && script && binding.scope === program.scope
        && (binding.kind === "var" || binding.kind === "hoisted");
      if (seen.has(binding)) return named | (rootSlot ? ROOT : 0);
      const next = new Set(seen); next.add(binding);
      let value = 0;
      if (binding.path.isVariableDeclarator() && binding.path.node.init) {
        const declaration = binding.path.node;
        const initializers = t.isIdentifier(declaration.id) ? [[declaration.id, declaration.init]]
          : patternSources(declaration.id, declaration.init);
        for (const [target, initializer] of initializers)
          if (binding.path.scope.getBinding(target.name) === binding) value |= origin(initializer, binding.path, next);
      }
      for (const violation of binding.constantViolations) {
        if (violation.isAssignmentExpression()) value |= origin(violation.node.right, violation, next);
        else value |= named;
      }
      const initialized = !(script && binding.kind === "var" && binding.scope === program.scope)
        || (!site.getFunctionParent() && binding.path.parentPath?.parentPath?.isProgram()
          && typeof binding.path.node.end === "number" && typeof site.node.start === "number"
          && binding.path.node.end <= site.node.start);
      const stable = initialized && binding.constant && !cellWrites.has(binding) && !dynamicLookup(site, node.name);
      const ordinary = stable && (binding.path.isFunctionDeclaration() || (binding.path.isVariableDeclarator()
        && (t.isFunctionExpression(binding.path.node.init) || t.isArrowFunctionExpression(binding.path.node.init))));
      const init = binding.path.isVariableDeclarator() ? binding.path.node.init : null;
      const callable = stable && (binding.path.isFunctionDeclaration() || t.isFunctionExpression(init)
        || t.isArrowFunctionExpression(init) || (t.isIdentifier(init) && !!(value & CALLABLE)));
      const distinctRoot = initialized && binding.constant && !cellWrites.has(binding)
        && (binding.path.isFunctionDeclaration() || t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)
          || t.isObjectExpression(init) || t.isArrayExpression(init) || t.isClassExpression(init)
          || t.isLiteral(init) || t.isTemplateLiteral(init));
      return (value & ~CALLABLE) | (callable ? CALLABLE : 0) | (ordinary || distinctRoot ? 0 : named)
        | (rootSlot && !distinctRoot ? ROOT : 0);
    }
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      const key = propertyName(node.property, node.computed);
      if (key === "constructor" && (t.isFunctionExpression(node.object)
        || t.isArrowFunctionExpression(node.object) || t.isClassExpression(node.object))) return CONSTRUCTOR;
      const objectOrigin = origin(node.object, site, seen);
      if (key === "constructor" && (objectOrigin & CALLABLE)
        && !hasOwnConstructorOverride(node.object, site)) return CONSTRUCTOR;
      if (!(objectOrigin & ROOT)) return 0;
      return key === "eval" ? EVAL : key === "Function" ? CONSTRUCTOR : key === "globalThis" ? ROOT
        : key === null ? EVAL | CONSTRUCTOR | ROOT : 0;
    }
    if ((t.isCallExpression(node) || t.isNewExpression(node)) && (origin(node.callee, site, seen) & CONSTRUCTOR)) return CREATED;
    return 0;
  };
  const possibleDirectEval = (callee: t.Node, site: any): boolean => {
    let node = callee;
    while (t.isParenthesizedExpression(node)) node = node.expression;
    return t.isIdentifier(node, { name: "eval" }) && !!(origin(node, site) & EVAL);
  };
  const wouldCreateDirectEval = (replacement: t.Node, site: any): boolean => {
    let position = site;
    while (position.parentPath?.isParenthesizedExpression()) position = position.parentPath;
    const call = position.parentPath;
    return !!call?.isCallExpression() && !call.node.optional && call.node.callee === position.node
      && possibleDirectEval(replacement, site);
  };
  let globalDynamic = false;
  const objectBinding = (binding: any): boolean => script && binding.scope === program.scope
    && (binding.kind === "var" || binding.kind === "hoisted");
  const markGlobal = (name: string | null, write: boolean, throughValue = false): void => {
    if (!script) return;
    for (const [key, binding] of Object.entries(program.scope.bindings) as [string, any][]) {
      if ((name === null || name === key) && objectBinding(binding)) {
        mark(binding, write);
        if (throughValue) markValueMutation(binding);
      }
    }
  };
  const registerRead = (node: any, site: any): void => {
    // Discarding a value cannot invoke or expose its code capability. Inspect only
    // the read itself: an intrinsic used inside void f(...) is still invoked.
    let position = site;
    while (position.parentPath?.isParenthesizedExpression()) position = position.parentPath;
    const parent = position.parentPath;
    const discarded = !!parent && ((parent.isUnaryExpression({ operator: "void" })
      && parent.node.argument === position.node)
      || (parent.isExpressionStatement() && parent.node.expression === position.node));
    if (node === site.node && discarded) return;
    codeValues.push({ node, site });
    if (origin(node, site) & (EVAL | CONSTRUCTOR | CREATED)) globalDynamic = true;
  };
  const escapeRoot = (): void => {
    markGlobal(null, true, true);
    // An unknown receiver of the root can also obtain its realm's code intrinsics.
    globalDynamic = true;
  };
  const observePattern = (pattern: any, value: any, site: any): void => {
    if (t.isAssignmentPattern(pattern)) {
      observePattern(pattern.left, value, site);
      return;
    }
    if (!(origin(value, site) & ROOT)) return;
    if (t.isArrayPattern(pattern)) { escapeRoot(); return; }
    if (!t.isObjectPattern(pattern)) return;
    for (const property of pattern.properties) {
      if (t.isRestElement(property)) { markGlobal(null, false, true); continue; }
      if (!t.isObjectProperty(property)) continue;
      const key = propertyName(property.key, property.computed);
      markGlobal(key, key === null, true);
      const member = t.memberExpression(t.cloneNode(value), t.cloneNode(property.key), property.computed || !t.isIdentifier(property.key));
      registerRead(member, site);
      observePattern(property.value, member, site);
    }
  };
  for (const path of paths) {
    if (path.isReferencedIdentifier()) {
      registerRead(path.node, path);
      if (withLookup(path, path.node.name)) mark(path.scope.getBinding(path.node.name));
    }
    if (path.isVariableDeclarator() && path.node.init && !t.isIdentifier(path.node.id))
      observePattern(path.node.id, path.node.init, path);
    if (path.isAssignmentExpression({ operator: "=" }) && (t.isObjectPattern(path.node.left) || t.isArrayPattern(path.node.left)))
      observePattern(path.node.left, path.node.right, path);
    if ((path.isVariableDeclarator() && path.node.init) || path.isForInStatement() || path.isForOfStatement()) {
      const target = path.isVariableDeclarator() ? path.get("id") : path.get("left");
      for (const name of Object.keys(t.getBindingIdentifiers(target.node)))
        if (withLookup(target, name)) mark(target.scope.getBinding(name));
    }
    if (path.isAssignmentExpression() || path.isUpdateExpression()) {
      const left = path.get(path.isAssignmentExpression() ? "left" : "argument");
      const ids = t.getBindingIdentifiers(left.node);
      for (const name of Object.keys(ids)) if (withLookup(left, name)) mark(left.scope.getBinding(name));
    }
    if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
      const write = isWriteTarget(path);
      if (!(origin(path.node.object, path) & ROOT)) {
        if (!write && (origin(path.node, path) & CONSTRUCTOR)) registerRead(path.node, path);
        continue;
      }
      const key = propertyName(path.node.property, path.node.computed);
      const parent = path.parentPath;
      markGlobal(key, write || key === null, mutatesValue(path) || !write);
      if (!write) registerRead(path.node, path);
    }
    if (!(path.isReferencedIdentifier() || path.isThisExpression())) continue;
    if (!(origin(path.node, path) & ROOT)) continue;
    const parent = path.parentPath;
    if ((parent.isMemberExpression() || parent.isOptionalMemberExpression()) && parent.node.object === path.node) continue;
    // An alias declaration is inspected through its own references; all other escapes are unknown.
    if (parent.isVariableDeclarator() && parent.node.init === path.node) continue;
    if (parent.isAssignmentExpression({ operator: "=" }) && parent.node.right === path.node
      && (t.isObjectPattern(parent.node.left) || t.isArrayPattern(parent.node.left))) continue;
    escapeRoot();
  }
  // Reachability may invalidate a previous ordinary-value proof. Iterate to a fixed point.
  let changed = true;
  while (changed) {
    const size = observed.size + written.size + cellWrites.size + introduced.size + directScopes.size;
    for (const { node, site } of codeValues) if (origin(node, site) & (EVAL | CONSTRUCTOR | CREATED)) globalDynamic = true;
    for (const path of paths) {
      if (!path.isCallExpression() || path.node.optional || !possibleDirectEval(path.node.callee, path)) continue;
      directScopes.add(path.scope);
      const seenNames = new Set<string>();
      for (let scope = path.scope; scope; scope = scope.parent) {
        for (const [name, binding] of Object.entries(scope.bindings)) {
          if (!seenNames.has(name)) mark(binding);
          seenNames.add(name);
        }
      }
      if (!path.isInStrictMode()) introduced.add(path.scope.getFunctionParent() ?? path.scope.getProgramParent());
      globalDynamic = true;
    }
    if (globalDynamic && script) for (const binding of Object.values(program.scope.bindings)) mark(binding);
    changed = size !== observed.size + written.size + cellWrites.size + introduced.size + directScopes.size;
  }
  const visitReads = (site: any, check: (path: any) => boolean): boolean => {
    let safe = true;
    if (site.isReferencedIdentifier() && !check(site)) return false;
    site.traverse({
      Function(path: any) { path.skip(); },
      ReferencedIdentifier(path: any) { if (!check(path)) { safe = false; path.stop(); } },
    });
    return safe;
  };
  const intrinsicReadsSafe = (site: any): boolean => visitReads(site, (path: any) =>
    !["undefined", "NaN", "Infinity"].includes(path.node.name) || intrinsicAt(path, path.node.name));
  const evaluationSafe = (site: any, seen = new Set<any>()): boolean => visitReads(site, (path: any) => {
    const name = path.node.name;
    if (dynamicLookup(path, name)) return false;
    if (["undefined", "NaN", "Infinity"].includes(name) && !intrinsicAt(path, name)) return false;
    const binding = path.scope.getBinding(name);
    if (!binding) return true;
    if (written.has(binding)) return false;
    if (seen.has(binding)) return true;
    if (!binding.path.isVariableDeclarator() || !binding.path.node.init) return true;
    const next = new Set(seen); next.add(binding);
    return evaluationSafe(binding.path.get("init"), next);
  });
  const renameUnavailable = (binding: any, name: string): boolean => {
    if (observed.has(binding) || linked.has(binding)) return true;
    // A hidden original name can become visible after renaming in an ancestor.
    for (const observer of directScopes) {
      for (let scope = observer; scope; scope = scope.parent) {
        if (scope === binding.scope) return true;
        if (scope.hasOwnBinding(name)) break;
      }
    }
    const retained = owners.get(name);
    for (const site of [binding.path, ...binding.referencePaths, ...binding.constantViolations]) {
      if (withLookup(site, name, binding.scope)) return true;
      for (let scope = site.scope; scope && scope !== binding.scope; scope = scope.parent) {
        if (introduced.has(scope)) return true;
      }
      if (retained) for (const owner of retained) if (under(site, owner)) return true;
    }
    return false;
  };
  return Object.freeze({
    linked: readonlySet(linked),
    owners: readonlyMap([...owners].map(([name, values]) => [name, readonlySet(values)] as const)),
    observed: (binding: any) => observed.has(binding), written: (binding: any) => written.has(binding),
    dynamicLookup, intrinsicAt, intrinsicReadsSafe, evaluationSafe, renameUnavailable, possibleDirectEval, wouldCreateDirectEval,
  });
}
