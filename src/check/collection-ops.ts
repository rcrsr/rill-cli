/**
 * Collection-Op Recognition Helpers
 *
 * In @rcrsr/rill 0.19.0 the dedicated AST nodes for `each`, `map`, `fold`,
 * `filter` were removed; collection operators now parse as ordinary HostCall
 * nodes (in pipe-target position) whose `name` is one of the five callable
 * builtins below.
 *
 * | Old keyword              | New callable | Behaviour                       |
 * | ------------------------ | ------------ | ------------------------------- |
 * | `each { body }`          | `seq`        | sequential, no accumulator      |
 * | `each(init) { body }`    | `acc`        | sequential scan with accumulator|
 * | `map { body }`           | `fan`        | parallel                        |
 * | `fold(init) { body }`    | `fold`       | sequential reduction            |
 * | `filter { body }`        | `filter`     | parallel predicate              |
 *
 * The closure argument may parse as either:
 *   - a bare-block form: `seq({ body })` — primary is a BlockNode, or
 *   - an explicit closure: `seq(|x|(body))` — primary is a ClosureNode.
 */

import type {
  ASTNode,
  HostCallNode,
  ClosureNode,
  BlockNode,
} from '@rcrsr/rill';

export const COLLECTION_OP_NAMES = new Set([
  'seq',
  'fan',
  'fold',
  'filter',
  'acc',
] as const);

export type CollectionOpName = 'seq' | 'fan' | 'fold' | 'filter' | 'acc';

const PARALLEL_OPS = new Set<CollectionOpName>(['fan', 'filter']);
const ACCUMULATOR_OPS = new Set<CollectionOpName>(['fold', 'acc']);

/** True when the node is a HostCall to one of the five collection callables. */
export function isCollectionOpCall(
  node: ASTNode
): node is HostCallNode & { name: CollectionOpName } {
  return (
    node.type === 'HostCall' &&
    COLLECTION_OP_NAMES.has(node.name as CollectionOpName)
  );
}

/** True for callables that execute the closure in parallel (`fan`, `filter`). */
export function isParallelOp(name: CollectionOpName): boolean {
  return PARALLEL_OPS.has(name);
}

/** True for callables that thread an accumulator (`fold`, `acc`). */
export function isAccumulatorOp(name: CollectionOpName): boolean {
  return ACCUMULATOR_OPS.has(name);
}

/**
 * Resolve the body argument of a collection-op call.
 *
 * Each arg is wrapped in a `PipeChain` whose head is a `PostfixExpr` whose
 * primary is the actual value. We scan args left-to-right and return the
 * first whose primary is a `Closure` or `Block`. Returns null when no such
 * arg exists (e.g. `seq($fn)` where the arg is a Variable).
 */
export function getCollectionOpBody(
  node: HostCallNode
): ClosureNode | BlockNode | null {
  for (const arg of node.args) {
    if (arg.type !== 'PipeChain') continue;
    if (arg.pipes.length !== 0) continue;
    const head = arg.head;
    if (head.type !== 'PostfixExpr') continue;
    const primary = head.primary;
    if (primary.type === 'Closure' || primary.type === 'Block') {
      return primary;
    }
  }
  return null;
}
