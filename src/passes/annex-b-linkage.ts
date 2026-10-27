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
  // Synthetic selector nodes are stable within one facts snapshot, so origin
  // fixed-point passes share them instead of continually expanding the graph.
  const patternSourceCache = new WeakMap<object, [any, any][]>();
  const patternBindsEval = (pattern: any): boolean =>
    Object.prototype.hasOwnProperty.call(t.getBindingIdentifiers(pattern), "eval");
  const conservativePatternSource = (pattern: any, fallback: any): any =>
    patternBindsEval(pattern) ? t.identifier("eval") : fallback;
  const patternSources = (pattern: any, value: any): [any, any][] => {
    const cached = patternSourceCache.get(pattern);
    if (cached) return cached;
    let result: [any, any][];
    if (t.isIdentifier(pattern)) result = [[pattern, value]];
    else if (t.isAssignmentPattern(pattern))
      result = patternSources(pattern.left, t.logicalExpression("??", t.cloneNode(value), t.cloneNode(pattern.right)));
    else if (t.isObjectPattern(pattern)) {
      result = pattern.properties.flatMap((property: any) => {
        if (!t.isObjectProperty(property)) return [];
        const name = propertyName(property.key, property.computed);
        let selected: any = null;
        if (t.isObjectExpression(value) && name !== null) {
          for (let index = value.properties.length - 1; index >= 0; index--) {
            const candidate: any = value.properties[index];
            if (t.isSpreadElement(candidate)) break;
            if (!(t.isObjectProperty(candidate) || t.isObjectMethod(candidate))) continue;
            const candidateName = propertyName(candidate.key, candidate.computed);
            if (candidateName === null && candidate.computed) break;
            if (candidateName !== name) continue;
            if ((t.isObjectProperty(candidate) && t.isExpression(candidate.value))
              || (t.isObjectMethod(candidate) && candidate.kind === "method")) selected = candidate;
            break;
          }
        }
        const fallback = t.memberExpression(t.cloneNode(value), t.cloneNode(property.key), property.computed || !t.isIdentifier(property.key));
        const source = selected && t.isObjectProperty(selected) ? selected.value
          : selected && t.isObjectMethod(selected) ? selected
            : conservativePatternSource(property.value, fallback);
        return patternSources(property.value, source);
      });
    } else if (t.isArrayPattern(pattern)) {
      result = pattern.elements.flatMap((element: any, index: number) => {
        if (!element) return [];
        const selected = t.isArrayExpression(value)
          && !value.elements.slice(0, index + 1).some(candidate => t.isSpreadElement(candidate))
          ? value.elements[index] : null;
        const fallback = t.memberExpression(t.cloneNode(value), t.numericLiteral(index), true);
        const source = selected && !t.isSpreadElement(selected)
          ? selected
          : conservativePatternSource(element, fallback);
        return patternSources(element, source);
      });
    } else result = [];
    patternSourceCache.set(pattern, result);
    return result;
  };
  const propertyName = (key: any, computed: boolean): string | null =>
    !computed && t.isIdentifier(key) ? key.name
      : t.isStringLiteral(key) ? key.value
        : t.isNumericLiteral(key) ? String(key.value)
          : t.isBigIntLiteral(key) ? key.value : null;

  // A may-origin relation, including reassigned aliases: uncertainty never proves independence.
  const EVAL = 1, CONSTRUCTOR = 2, ROOT = 4, CREATED = 8, CALLABLE = 16;
  const currentStatement = (path: any): any | null => {
    let position = path;
    while (position?.parentPath && !(position.parentPath.isProgram() || position.parentPath.isBlockStatement()))
      position = position.parentPath;
    return position?.parentPath && (position.parentPath.isProgram() || position.parentPath.isBlockStatement())
      && position.listKey === "body" && typeof position.key === "number" ? position : null;
  };
  const activation = (path: any): any =>
    path.findParent((candidate: any) => candidate.isFunction()
      || candidate.isClassProperty?.() || candidate.isClassPrivateProperty?.()
      || candidate.isClassAccessorProperty?.()) ?? program;
  const sameCurrentList = (leftPath: any, rightPath: any): boolean => {
    const left = currentStatement(leftPath), right = currentStatement(rightPath);
    return !!left && !!right && left.parentPath === right.parentPath
      && activation(leftPath) === activation(rightPath);
  };
  const directOperationStatement = (operation: any): any | null => {
    const statement = operation?.parentPath;
    return statement?.isExpressionStatement() && statement.node.expression === operation.node
      && currentStatement(operation) === statement ? statement : null;
  };
  const initializedAt = (binding: any, site: any): boolean => {
    if (!(script && binding.kind === "var" && binding.scope === program.scope)) return true;
    const declaration = currentStatement(binding.path), access = currentStatement(site);
    return !!declaration && !!access && sameCurrentList(binding.path, site) && declaration.key <= access.key;
  };
  const valueProvedNotFunctionConstructor = (node: any, site: any, seen = new Set<any>()): boolean => {
    if (!node) return false;
    if (t.isParenthesizedExpression(node)) return valueProvedNotFunctionConstructor(node.expression, site, seen);
    if (t.isSequenceExpression(node)) return valueProvedNotFunctionConstructor(node.expressions.at(-1), site, seen);
    if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node) || t.isClassExpression(node)
      || t.isObjectExpression(node) || t.isArrayExpression(node) || t.isLiteral(node)
      || t.isTemplateLiteral(node)) return true;
    if (!t.isIdentifier(node)) return false;
    const binding = site.scope.getBinding(node.name);
    if (!binding || seen.has(binding) || !binding.constant || cellWrites.has(binding)) return false;
    if (binding.path.isFunctionDeclaration() || binding.path.isClassDeclaration()) return true;
    if (!binding.path.isVariableDeclarator() || !binding.path.node.init) return false;
    const next = new Set(seen); next.add(binding);
    return valueProvedNotFunctionConstructor(binding.path.node.init, binding.path, next);
  };
  const objectLiteralOwnConstructorSafe = (node: any, site: any): boolean => {
    if (!t.isObjectExpression(node) || node.properties.some((property: any) =>
      t.isSpreadElement(property) || ((t.isObjectProperty(property) || t.isObjectMethod(property))
        && property.computed && propertyName(property.key, true) === null))) return false;
    const own = node.properties.filter((property: any) =>
      (t.isObjectProperty(property) || t.isObjectMethod(property))
      && propertyName(property.key, property.computed) === "constructor");
    if (own.length !== 1) return false;
    const property: any = own[0];
    return (t.isObjectMethod(property) && property.kind === "method") || (t.isObjectProperty(property)
      && valueProvedNotFunctionConstructor(property.value, site));
  };
  const hasSafeOwnConstructorAt = (node: any, lookupSite: any, accessSite = lookupSite): boolean => {
    if (objectLiteralOwnConstructorSafe(node, lookupSite)) return true;
    if (!t.isIdentifier(node)) return false;
    const binding = lookupSite.scope.getBinding(node.name);
    const access = currentStatement(accessSite);
    if (!binding || !access || !binding.path.isVariableDeclarator()) return false;
    if (!t.isIdentifier(binding.path.node.id) || binding.path.node.id !== binding.identifier) return false;
    if (objectBinding(binding) || linked.has(binding)) return false;
    const owner = activation(accessSite);
    if (activation(binding.path) !== owner) return false;
    if (owner !== program && (owner.node.async || owner.node.generator)) return false;
    // Only direct expression statements in a non-repeating execution region prove order.
    let accessOperation = accessSite;
    while (accessOperation.parentPath?.node.callee === accessOperation.node)
      accessOperation = accessOperation.parentPath;
    if (directOperationStatement(accessOperation) !== access) return false;
    let region = access.parentPath;
    while (region !== owner) {
      if (!region?.isBlockStatement()) return false;
      region = region.parentPath;
    }
    type State = "INHERITED" | "OWN_SAFE" | "UNKNOWN";
    type Operation = { key: number; kind: "VALUE" | "OWN" | "DELETE"; state?: State; fresh?: boolean; reference?: any };
    const operations: Operation[] = [];
    const classifyValue = (value: any, site: any): { state: State; fresh: boolean } => {
      const fresh = t.isFunctionExpression(value) || t.isArrowFunctionExpression(value)
        || t.isClassExpression(value) || t.isObjectExpression(value) || t.isArrayExpression(value);
      return { state: objectLiteralOwnConstructorSafe(value, site) ? "OWN_SAFE"
        : fresh ? "INHERITED" : "UNKNOWN", fresh };
    };
    if (binding.path.node.init) {
      if (!sameCurrentList(binding.path, accessSite)
        || binding.path.parentPath !== currentStatement(binding.path)) return false;
      const initial = classifyValue(binding.path.node.init, binding.path);
      operations.push({ key: currentStatement(binding.path).key, kind: "VALUE", ...initial });
    }
    for (const violation of binding.constantViolations) {
      if (!violation.isAssignmentExpression({ operator: "=" }) || !t.isIdentifier(violation.node.left)) return false;
      const statement = directOperationStatement(violation);
      if (!statement || !sameCurrentList(violation, accessSite)) return false;
      operations.push({ key: statement.key, kind: "VALUE", ...classifyValue(violation.node.right, violation) });
    }
    for (const reference of binding.referencePaths) {
      const member = reference.parentPath;
      if ((member?.isMemberExpression() || member?.isOptionalMemberExpression())
        && member.node.object === reference.node
        && propertyName(member.node.property, member.node.computed) === "constructor") {
        if (member === accessSite || member.node === accessSite.node) continue;
        const operation = member.parentPath;
        const statement = directOperationStatement(operation);
        if (!statement || !sameCurrentList(operation, accessSite)) return false;
        if (operation?.isAssignmentExpression({ operator: "=" }) && operation.node.left === member.node) {
          operations.push({ key: statement.key, kind: "OWN", state: valueProvedNotFunctionConstructor(operation.node.right, operation)
            ? "OWN_SAFE" : "UNKNOWN", reference });
        } else if (operation?.isUnaryExpression({ operator: "delete" }) && operation.node.argument === member.node) {
          operations.push({ key: statement.key, kind: "DELETE", reference });
        } else return false;
        continue;
      }
      const use = reference.parentPath;
      const statement = use.node.arguments?.includes(reference.node) && !use.node.optional
        ? directOperationStatement(use) : directOperationStatement(reference);
      if (!statement || !sameCurrentList(reference, accessSite)) return false;
      operations.push({ key: statement.key, kind: "VALUE", state: "UNKNOWN", fresh: false, reference });
    }
    operations.sort((left, right) => left.key - right.key);
    let state: State = "UNKNOWN";
    let fresh = false;
    for (const operation of operations) {
      if (operation.key === access.key) return false;
      if (operation.key > access.key) continue;
      if (operation.kind === "VALUE") {
        if (operation.reference) { state = "UNKNOWN"; fresh = false; }
        else { state = operation.state!; fresh = operation.fresh!; }
      } else if (operation.kind === "OWN") state = fresh ? operation.state! : "UNKNOWN";
      else state = fresh ? "INHERITED" : "UNKNOWN";
    }
    return state === "OWN_SAFE";
  };
  const receiverlessInvocation = (reference: any): boolean => {
    let position = reference;
    while (position.parentPath?.isParenthesizedExpression()) position = position.parentPath;
    const sequence = position.parentPath;
    if (sequence?.isSequenceExpression() && sequence.node.expressions.at(-1) === position.node) position = sequence;
    const use = position.parentPath;
    return !!use && ((use.isCallExpression() && use.node.callee === position.node && !use.node.optional)
      || (use.isOptionalCallExpression?.() && use.node.callee === position.node)
      || (use.isTaggedTemplateExpression() && use.node.tag === position.node));
  };
  const functionMayReceiveGlobalThis = (owner: any): boolean => {
    if (!script || owner.isInStrictMode() || owner.node.async || owner.node.generator
      || !(owner.isFunctionDeclaration() || owner.isFunctionExpression())) return false;
    const parent = owner.parentPath;
    if (owner.isFunctionExpression() && receiverlessInvocation(owner)) return true;
    let binding: any = null;
    if (owner.isFunctionDeclaration() && owner.node.id)
      binding = owner.parentPath.scope.getBinding(owner.node.id.name);
    else if (parent?.isVariableDeclarator() && t.isIdentifier(parent.node.id))
      binding = parent.scope.getBinding(parent.node.id.name);
    if (!binding) return false;
    const component = new Set<any>();
    const queue = [binding];
    while (queue.length) {
      const current = queue.shift();
      if (!current || component.has(current)) continue;
      component.add(current);
      if (current.path.isVariableDeclarator() && t.isIdentifier(current.path.node.init)
        && current.constant && !cellWrites.has(current))
        queue.push(current.path.scope.getBinding(current.path.node.init.name));
      for (const reference of current.referencePaths) {
        const use = reference.parentPath;
        if (receiverlessInvocation(reference)) return true;
        if (use?.isVariableDeclarator() && use.node.init === reference.node && t.isIdentifier(use.node.id)) {
          const alias = use.scope.getBinding(use.node.id.name);
          if (alias?.constant && !cellWrites.has(alias)) queue.push(alias);
        }
      }
    }
    return false;
  };
  const origin = (rootNode: any, rootSite: any): number => {
    type Entry = { node: any; site: any; value: number; visiting: boolean; done: boolean };
    const byNode = new Map<any, Map<any, Entry>>();
    let changed = false;
    const entryFor = (node: any, site: any): Entry => {
      let bySite = byNode.get(node);
      if (!bySite) { bySite = new Map(); byNode.set(node, bySite); }
      let entry = bySite.get(site);
      if (!entry) { entry = { node, site, value: 0, visiting: false, done: false }; bySite.set(site, entry); }
      return entry;
    };
    const evaluate = (entry: Entry): number => {
      if (entry.done || entry.visiting) return entry.value;
      entry.visiting = true;
      const node = entry.node, site = entry.site;
      const dependency = (value: any, valueSite = site): number => value ? evaluate(entryFor(value, valueSite)) : 0;
      let value = 0;
      if (!node) value = 0;
      else if (t.isParenthesizedExpression(node)) value = dependency(node.expression);
      else if (t.isSequenceExpression(node)) value = dependency(node.expressions.at(-1));
      else if (t.isConditionalExpression(node)) value = dependency(node.consequent) | dependency(node.alternate);
      else if (t.isLogicalExpression(node)) value = dependency(node.left) | dependency(node.right);
      else if (t.isAssignmentExpression(node)) value = dependency(node.right);
      else if (t.isThisExpression(node)) {
        const owner = site.findParent((candidate: any) => candidate.isFunction() && !candidate.isArrowFunctionExpression());
        value = script && (!owner || functionMayReceiveGlobalThis(owner)) ? ROOT : 0;
      } else if (t.isIdentifier(node)) {
        const binding = site.scope.getBinding(node.name);
        const named = node.name === "eval" ? EVAL : node.name === "Function" ? CONSTRUCTOR : 0;
        if (dynamicLookup(site, node.name)) value = EVAL | CONSTRUCTOR | ROOT | CREATED;
        else if (!binding) value = named | (node.name === "globalThis" ? ROOT : 0);
        else {
          const rootSlot = node.name === "globalThis" && script && binding.scope === program.scope
            && (binding.kind === "var" || binding.kind === "hoisted");
          let bindingValue = 0;
          let selectedInit: any = null;
          if (binding.path.isVariableDeclarator() && binding.path.node.init) {
            const declaration = binding.path.node;
            const initializers = t.isIdentifier(declaration.id) ? [[declaration.id, declaration.init]]
              : patternSources(declaration.id, declaration.init);
            for (const [target, initializer] of initializers) {
              if (binding.path.scope.getBinding(target.name) !== binding) continue;
              selectedInit = initializer;
              bindingValue |= dependency(initializer, binding.path);
            }
          }
          for (const violation of binding.constantViolations) {
            if (violation.isAssignmentExpression()) bindingValue |= dependency(violation.node.right, violation);
            else bindingValue |= named;
          }
          const initialized = initializedAt(binding, site);
          const stable = initialized && binding.constant && !cellWrites.has(binding) && !dynamicLookup(site, node.name);
          const ordinary = stable && (binding.path.isFunctionDeclaration()
            || t.isFunctionExpression(selectedInit) || t.isArrowFunctionExpression(selectedInit));
          const callable = stable && (binding.path.isFunctionDeclaration() || t.isFunctionExpression(selectedInit)
            || t.isArrowFunctionExpression(selectedInit) || (t.isIdentifier(selectedInit) && !!(bindingValue & CALLABLE)));
          const distinctRoot = initialized && binding.constant && !cellWrites.has(binding)
            && (binding.path.isFunctionDeclaration() || t.isFunctionExpression(selectedInit)
              || t.isArrowFunctionExpression(selectedInit) || t.isObjectExpression(selectedInit)
              || t.isArrayExpression(selectedInit) || t.isClassExpression(selectedInit)
              || t.isLiteral(selectedInit) || t.isTemplateLiteral(selectedInit));
          value = (bindingValue & ~CALLABLE) | (callable ? CALLABLE : 0) | (ordinary || distinctRoot ? 0 : named)
            | (rootSlot && !distinctRoot ? ROOT : 0);
        }
      } else if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
        const key = propertyName(node.property, node.computed);
        if (key === "constructor" && !hasSafeOwnConstructorAt(node.object, site)) value = CONSTRUCTOR;
        else if (key === "constructor") value = 0;
        else {
          const objectOrigin = dependency(node.object);
          const computedConstructor = key === null ? CONSTRUCTOR : 0;
          value = computedConstructor | (!(objectOrigin & ROOT) ? 0
            : key === "eval" ? EVAL : key === "Function" ? CONSTRUCTOR : key === "globalThis" ? ROOT
              : key === null ? EVAL | CONSTRUCTOR | ROOT : 0);
        }
      } else if ((t.isCallExpression(node) || t.isNewExpression(node)) && (dependency(node.callee) & CONSTRUCTOR)) {
        value = CREATED;
      }
      const joined = entry.value | value;
      if (joined !== entry.value) { entry.value = joined; changed = true; }
      entry.visiting = false;
      entry.done = true;
      return entry.value;
    };
    const root = entryFor(rootNode, rootSite);
    do {
      changed = false;
      for (const bySite of byNode.values()) for (const entry of bySite.values()) entry.done = false;
      evaluate(root);
    } while (changed);
    return root.value;
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
