/**
 * Control flow unflattening pass.
 *
 * Detects the while(true)/switch(state) dispatch pattern produced by
 * javascript-obfuscator's controlFlowFlattening option. Reconstructs
 * the original linear statement order from the dispatch sequence.
 *
 * Pattern:
 *   var _0x = '4|2|0|3|1'.split('|');
 *   var _0xi = 0;
 *   while (true) {       // or while(!![])
 *     switch (_0x[_0xi++]) {
 *       case '0': stmt0; continue;
 *       case '1': stmt1; continue;
 *       ...
 *     }
 *     break;
 *   }
 *
 * Reconstructed as: [stmt4, stmt2, stmt0, stmt3, stmt1]
 */

import { traverse, t } from "../babel.js";
import type { File } from "@babel/types";
import type { NodePath } from "@babel/traverse";
import type { ASTPass } from "../types.js";

export const controlFlowUnflattenPass: ASTPass = {
  name: "control-flow-unflatten",
  description: "Reconstruct linear control flow from while/switch dispatch pattern",

  run(ast: File): File {
    let changed = true;
    let iterations = 0;
    const MAX_ITERATIONS = 25;
    while (changed && iterations < MAX_ITERATIONS) {
      changed = false;
      iterations++;
      traverse(ast, {
        WhileStatement(path) {
          if (unflattenDispatch(path) || unflattenArithmeticDispatch(path)) {
            changed = true;
          }
        },
      });
    }
    return ast;
  },
};

interface DispatchPattern {
  /** The order array values (e.g., ['4', '2', '0', '3', '1']) */
  order: string[];
  /** Map from case label string to its body statements (minus trailing continue) */
  caseMap: Map<string, t.Statement[]>;
  /** Binding path for the array variable (to remove) */
  arrayBindingPath: NodePath | null;
  /** Binding path for the counter variable (to remove) */
  counterBindingPath: NodePath | null;
}

function unflattenDispatch(whilePath: NodePath<t.WhileStatement>): boolean {
  // Step 1: Verify the while test is a constant truthy value
  if (!isConstantTruthy(whilePath.node.test)) return false;

  // Step 2: Body must be BlockStatement with [SwitchStatement, BreakStatement]
  const body = whilePath.node.body;
  if (!t.isBlockStatement(body)) return false;
  if (body.body.length !== 2) return false;
  if (!t.isSwitchStatement(body.body[0])) return false;
  if (!t.isBreakStatement(body.body[1])) return false;

  const switchStmt = body.body[0] as t.SwitchStatement;

  // Step 3: Discriminant must be arr[counter++] (computed member + update expression)
  const disc = switchStmt.discriminant;
  if (!t.isMemberExpression(disc) || !disc.computed) return false;
  if (!t.isIdentifier(disc.object)) return false;
  if (!t.isUpdateExpression(disc.property) || disc.property.operator !== "++" || disc.property.prefix) return false;
  if (!t.isIdentifier(disc.property.argument)) return false;

  const arrayVarName = disc.object.name;
  const counterVarName = disc.property.argument.name;

  // Step 4: Resolve the order array and save the binding's declaration path
  const arrayBinding = whilePath.scope.getBinding(arrayVarName);
  const counterBinding = whilePath.scope.getBinding(counterVarName);
  const order = resolveOrderArray(whilePath, arrayVarName);
  if (!order || order.length === 0) return false;

  // Step 5: Build case map (label → statements without trailing continue)
  const caseMap = buildCaseMap(switchStmt, whilePath);
  if (!caseMap) return false;

  // Step 6: Verify all order labels have corresponding cases
  for (const label of order) {
    if (!caseMap.has(label)) return false;
  }

  // Step 7: Reconstruct ordered statements
  const orderedStatements: t.Statement[] = [];
  for (const label of order) {
    const stmts = caseMap.get(label)!;
    orderedStatements.push(...stmts);
  }

  // Step 8: Replace the while loop with ordered statements
  whilePath.replaceWithMultiple(orderedStatements);

  // Step 9: Remove dispatcher variable declarations directly
  removeBindingDeclaration(arrayBinding);
  removeBindingDeclaration(counterBinding);

  return true;
}

/**
 * Check if an expression is a constant truthy value.
 * Matches: true, !![], !!0, !!''  (any double-negation of anything)
 */
function isConstantTruthy(node: t.Expression): boolean {
  // Direct true literal
  if (t.isBooleanLiteral(node) && node.value === true) return true;

  // !!something — double negation always produces true when the inner value is truthy
  // !![] is the standard javascript-obfuscator pattern ([] is truthy)
  if (
    t.isUnaryExpression(node) && node.operator === "!" &&
    t.isUnaryExpression(node.argument) && node.argument.operator === "!"
  ) {
    const inner = node.argument.argument;
    // !![] — array literal is always truthy
    if (t.isArrayExpression(inner)) return true;
    // !!true
    if (t.isBooleanLiteral(inner) && inner.value === true) return true;
    // !!1, !!'x', etc. — any literal that's truthy
    if (t.isNumericLiteral(inner) && inner.value !== 0) return true;
    if (t.isStringLiteral(inner) && inner.value !== "") return true;
  }

  return false;
}

/**
 * Resolve the order array from the array variable's binding.
 * Handles two patterns:
 *   1. var arr = 'orderString'.split('|')
 *   2. var arr = ['0', '1', '2', ...]
 */
function resolveOrderArray(whilePath: NodePath, arrayVarName: string): string[] | null {
  const scope = whilePath.scope;
  const binding = scope.getBinding(arrayVarName);
  if (!binding || !binding.path.isVariableDeclarator()) return null;

  const init = binding.path.node.init;
  if (!init) return null;

  // Pattern 1: 'string'.split('|') or 'string'["split"]('|')
  if (
    t.isCallExpression(init) &&
    t.isMemberExpression(init.callee) &&
    t.isStringLiteral(init.callee.object) &&
    isSplitProperty(init.callee) &&
    init.arguments.length === 1 &&
    t.isStringLiteral(init.arguments[0]) &&
    init.arguments[0].value === "|"
  ) {
    return init.callee.object.value.split("|");
  }

  // Pattern 2: ['0', '1', '2', ...]
  if (t.isArrayExpression(init) && init.elements.every(el => el !== null && t.isStringLiteral(el))) {
    return (init.elements as t.StringLiteral[]).map(el => el.value);
  }

  return null;
}

/** Check if a member expression property is "split" (either .split or ["split"]) */
function isSplitProperty(node: t.MemberExpression): boolean {
  if (!node.computed && t.isIdentifier(node.property) && node.property.name === "split") return true;
  if (node.computed && t.isStringLiteral(node.property) && node.property.value === "split") return true;
  return false;
}

/**
 * Build a map from case label to its body statements (minus trailing continue).
 * Returns null if any case doesn't end with continue (not a dispatch pattern).
 */
function buildCaseMap(
  switchStmt: t.SwitchStatement,
  whilePath: NodePath,
): Map<string, t.Statement[]> | null {
  const caseMap = new Map<string, t.Statement[]>();

  for (const switchCase of switchStmt.cases) {
    // Skip default case — dispatch patterns don't have one
    if (!switchCase.test) return null;

    // Case label must be a string literal
    if (!t.isStringLiteral(switchCase.test)) return null;
    const label = switchCase.test.value;

    const consequent = switchCase.consequent;
    if (consequent.length === 0) return null;

    const lastStmt = consequent[consequent.length - 1];

    if (t.isContinueStatement(lastStmt) && !lastStmt.label) {
      // Normal dispatch case: strip the trailing continue
      caseMap.set(label, consequent.slice(0, -1));
    } else if (t.isReturnStatement(lastStmt) || t.isThrowStatement(lastStmt)) {
      // Terminal case (return/throw): keep all statements including the terminator
      caseMap.set(label, [...consequent]);
    } else {
      return null;
    }
  }

  return caseMap;
}

/**
 * Remove a binding's variable declaration (the whole `var x = ...` statement).
 * Only removes if the declaration has a single declarator.
 */
function removeBindingDeclaration(binding: ReturnType<NodePath["scope"]["getBinding"]>): void {
  if (!binding) return;
  if (!binding.path.isVariableDeclarator()) return;

  const declPath = binding.path.parentPath;
  if (declPath && t.isVariableDeclaration(declPath.node) && declPath.node.declarations.length === 1) {
    declPath.remove();
  }
}

/**
 * Unflatten arithmetic state-machine dispatchers:
 *   var state = initialValue;
 *   while (true) { switch (state) { case N: ...; state = M; continue; } break; }
 *
 * Resolves execution order by tracing state transitions statically.
 * Only handles deterministic transitions (state = constant).
 */
function unflattenArithmeticDispatch(whilePath: NodePath<t.WhileStatement>): boolean {
  if (!isConstantTruthy(whilePath.node.test)) return false;

  const body = whilePath.node.body;
  if (!t.isBlockStatement(body)) return false;
  if (body.body.length !== 2) return false;
  if (!t.isSwitchStatement(body.body[0])) return false;
  if (!t.isBreakStatement(body.body[1])) return false;

  const switchStmt = body.body[0] as t.SwitchStatement;

  // Discriminant must be a simple identifier (the state variable)
  if (!t.isIdentifier(switchStmt.discriminant)) return false;
  const stateVarName = switchStmt.discriminant.name;

  // Resolve the initial state value
  const stateBinding = whilePath.scope.getBinding(stateVarName);
  if (!stateBinding || !stateBinding.path.isVariableDeclarator()) return false;
  const initNode = stateBinding.path.node.init;
  if (!t.isNumericLiteral(initNode)) return false;
  const initialState = initNode.value;

  // Build case map: numeric case label → { body statements, next state }
  const caseMap = new Map<number, { stmts: t.Statement[]; nextState: number | null }>();
  let terminalState: number | null = null;

  for (const switchCase of switchStmt.cases) {
    if (!switchCase.test) return false; // no default case
    if (!t.isNumericLiteral(switchCase.test) && !t.isUnaryExpression(switchCase.test)) return false;

    let label: number;
    if (t.isNumericLiteral(switchCase.test)) {
      label = switchCase.test.value;
    } else if (
      t.isUnaryExpression(switchCase.test) &&
      switchCase.test.operator === "-" &&
      t.isNumericLiteral(switchCase.test.argument)
    ) {
      label = -switchCase.test.argument.value;
    } else {
      return false;
    }

    const consequent = switchCase.consequent;
    if (consequent.length === 0) return false;

    const lastStmt = consequent[consequent.length - 1];

    // Check for terminal case: ends with break (not continue)
    if (t.isBreakStatement(lastStmt) && !lastStmt.label) {
      terminalState = label;
      caseMap.set(label, { stmts: [], nextState: null });
      continue;
    }

    // Must end with continue
    if (!t.isContinueStatement(lastStmt) || lastStmt.label) return false;

    // Find the state assignment: state = constant
    const bodyWithoutContinue = consequent.slice(0, -1);
    let nextState: number | null = null;
    const stmtsWithoutStateAssign: t.Statement[] = [];

    for (const stmt of bodyWithoutContinue) {
      if (
        t.isExpressionStatement(stmt) &&
        t.isAssignmentExpression(stmt.expression) &&
        stmt.expression.operator === "=" &&
        t.isIdentifier(stmt.expression.left) &&
        stmt.expression.left.name === stateVarName
      ) {
        // state = constant
        if (t.isNumericLiteral(stmt.expression.right)) {
          nextState = stmt.expression.right.value;
        } else if (
          t.isUnaryExpression(stmt.expression.right) &&
          stmt.expression.right.operator === "-" &&
          t.isNumericLiteral(stmt.expression.right.argument)
        ) {
          nextState = -stmt.expression.right.argument.value;
        } else {
          // Try computed transition: state = state op C
          const computed = evaluateComputedTransition(stmt.expression.right, stateVarName, label);
          if (computed !== null) {
            nextState = computed;
          } else {
            // Non-deterministic state transition — bail out
            return false;
          }
        }
      } else {
        stmtsWithoutStateAssign.push(stmt);
      }
    }

    if (nextState === null) return false; // No state transition found
    caseMap.set(label, { stmts: stmtsWithoutStateAssign, nextState });
  }

  // Trace execution order starting from initial state
  const order: number[] = [];
  const visited = new Set<number>();
  let currentState: number | null = initialState;
  const MAX_TRACE = 1000;

  while (currentState !== null && !visited.has(currentState) && order.length < MAX_TRACE) {
    visited.add(currentState);
    const entry = caseMap.get(currentState);
    if (!entry) return false; // Missing case

    order.push(currentState);
    currentState = entry.nextState;
  }

  if (order.length === 0) return false;

  // Build ordered statement list
  const orderedStatements: t.Statement[] = [];
  for (const state of order) {
    const entry = caseMap.get(state)!;
    if (entry.stmts.length > 0) {
      orderedStatements.push(...entry.stmts);
    }
  }

  // Replace while loop with ordered statements
  whilePath.replaceWithMultiple(orderedStatements);

  // Remove state variable declaration
  removeBindingDeclaration(stateBinding);

  return true;
}

/**
 * Evaluate a computed state transition using the current case label.
 * Handles: state + C, state * K + C, state ^ C.
 */
function evaluateComputedTransition(
  right: t.Expression,
  stateVarName: string,
  currentState: number,
): number | null {
  if (!t.isBinaryExpression(right)) return null;

  // state + C
  if (
    right.operator === "+" &&
    t.isIdentifier(right.left) && right.left.name === stateVarName &&
    t.isNumericLiteral(right.right)
  ) {
    return currentState + right.right.value;
  }

  // state * K + C (affine: outer + with inner *)
  if (
    right.operator === "+" &&
    t.isBinaryExpression(right.left) && right.left.operator === "*" &&
    t.isIdentifier(right.left.left) && right.left.left.name === stateVarName &&
    t.isNumericLiteral(right.left.right) &&
    t.isNumericLiteral(right.right)
  ) {
    return currentState * right.left.right.value + right.right.value;
  }

  // state ^ C (XOR)
  if (
    right.operator === "^" &&
    t.isIdentifier(right.left) && right.left.name === stateVarName &&
    t.isNumericLiteral(right.right)
  ) {
    return (currentState ^ right.right.value);
  }

  return null;
}
