/**
 * Pass dependency graph analysis using Tarjan's SCC algorithm.
 *
 * Identifies strongly connected components (cycles) in the pass dependency
 * graph to optimize iteration: only passes in the same SCC need to iterate
 * together; passes outside SCCs run once in topological order.
 */

/**
 * Find all strongly connected components using Tarjan's algorithm.
 * Returns SCCs in reverse topological order (dependencies before dependents).
 */
export function findSCCs(graph: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let idx = 0;

  function strongconnect(v: string): void {
    index.set(v, idx);
    lowlink.set(v, idx);
    idx++;
    stack.push(v);
    onStack.add(v);

    const neighbors = graph.get(v) ?? [];
    for (const w of neighbors) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    // Root of SCC
    if (lowlink.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  // Visit all nodes (handles disconnected components)
  for (const node of graph.keys()) {
    if (!index.has(node)) {
      strongconnect(node);
    }
  }

  return sccs;
}

/**
 * Topological sort of nodes, respecting SCC grouping.
 * Nodes within the same SCC are adjacent in the output.
 * Returns nodes in execution order (dependencies first).
 */
export function topologicalSort(graph: Map<string, string[]>): string[] {
  const sccs = findSCCs(graph);
  // Tarjan's returns SCCs in reverse topological order, so reverse
  const result: string[] = [];
  for (let i = sccs.length - 1; i >= 0; i--) {
    result.push(...sccs[i]);
  }
  return result;
}

/**
 * Pass dependency graph for the deobfuscation pipeline.
 * Edge A → B means "pass A may expose work for pass B".
 */
export const PASS_DEPENDENCIES = new Map<string, string[]>([
  // Bundler unpack exposes everything
  ["bundler-unpack", ["constant-fold"]],

  // Constant fold feeds propagation
  ["constant-fold", ["constant-propagate"]],

  // Propagation and dead code elimination are mutually dependent
  ["constant-propagate", ["dead-code-eliminate"]],
  ["dead-code-eliminate", ["constant-propagate"]],

  // Hex decode feeds string operations
  ["hex-decode", ["constant-fold"]],

  // String array feeds everything downstream
  ["string-array", ["constant-propagate"]],
  ["string-array-static", ["constant-propagate"]],

  // Control flow passes feed propagation/elimination
  ["control-flow-object", ["constant-propagate"]],
  ["control-flow-unflatten", ["constant-propagate"]],

  // Anti-debug feeds dead code elimination
  ["anti-debug", ["dead-code-eliminate"]],

  // Simplify is terminal (no downstream effects on other passes)
  ["ast-simplify", []],

  // Rename passes are terminal
  ["semantic-rename", []],
  ["ast-rename", []],
]);
