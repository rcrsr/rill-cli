/**
 * Error-Handling Convention Rules
 * Lints idiomatic use of 0.19.0 error-handling primitives:
 * `guard`, `retry`, `.!`, `.?`, and `#atom`.
 */

import type {
  ValidationRule,
  Diagnostic,
  ValidationContext,
} from '../types.js';
import type {
  ASTNode,
  AtomLiteralNode,
  BinaryExprNode,
  ConditionalNode,
  GuardBlockNode,
  GroupedExprNode,
  HostCallNode,
  PipeChainNode,
  PostfixExprNode,
  RetryBlockNode,
  StatusProbeNode,
} from '@rcrsr/rill';
import { extractContextLine } from './helpers.js';
import { visitNode } from '../visitor.js';

// ============================================================
// BUILTIN ATOMS
// ============================================================

/**
 * Atoms pre-registered by the runtime. Source:
 * node_modules/@rcrsr/rill/dist/runtime/core/types/atom-registry.js
 * Names are stored without the leading '#'.
 */
const BUILTIN_ATOMS: ReadonlySet<string> = new Set([
  'ok',
  'R001',
  'R999',
  'TIMEOUT',
  'AUTH',
  'FORBIDDEN',
  'RATE_LIMIT',
  'QUOTA_EXCEEDED',
  'UNAVAILABLE',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_INPUT',
  'PROTOCOL',
  'DISPOSED',
  'TYPE_MISMATCH',
]);

// ============================================================
// GUARD_BARE
// ============================================================

/**
 * Suggests explicit `on:` codes on `guard` blocks. A bare `guard { ... }`
 * recovers from any error; that hides intent and silences errors the author
 * never planned for. Prefer `guard<on: list[#X, ...]>` for explicit
 * recoverability.
 */
export const GUARD_BARE: ValidationRule = {
  code: 'GUARD_BARE',
  category: 'errors',
  severity: 'info',
  nodeTypes: ['GuardBlock'],

  validate(node: ASTNode, context: ValidationContext): Diagnostic[] {
    const guard = node as GuardBlockNode;
    if (guard.onCodes && guard.onCodes.length > 0) return [];

    return [
      {
        location: guard.span.start,
        severity: 'info',
        code: 'GUARD_BARE',
        message:
          'Bare guard catches every error. Prefer guard<on: list[#X, ...]> to make recoverability explicit.',
        context: extractContextLine(guard.span.start.line, context.source),
        fix: null,
      },
    ];
  },
};

// ============================================================
// RETRY_TRIVIAL
// ============================================================

/**
 * Flags `retry<limit: N>` with N <= 1. A single attempt is what already happens
 * without `retry`; the block has no effect. Either remove the wrapper or
 * raise the attempt count.
 */
export const RETRY_TRIVIAL: ValidationRule = {
  code: 'RETRY_TRIVIAL',
  category: 'errors',
  severity: 'warning',
  nodeTypes: ['RetryBlock'],

  validate(node: ASTNode, context: ValidationContext): Diagnostic[] {
    const retry = node as RetryBlockNode;
    if (retry.attempts > 1) return [];

    return [
      {
        location: retry.span.start,
        severity: 'warning',
        code: 'RETRY_TRIVIAL',
        message: `retry<limit: ${retry.attempts}> has no effect; remove the wrapper or raise the attempt count.`,
        context: extractContextLine(retry.span.start.line, context.source),
        fix: null,
      },
    ];
  },
};

// ============================================================
// ATOM_UNREGISTERED
// ============================================================

/**
 * Warns on `#ATOM` literals whose name is not a runtime builtin. Such atoms
 * must be registered by the host via `registerErrorCode` before use; the
 * lint cannot see host registrations, so this is a best-effort check.
 * Suppress per-file via config when the host registers the atom.
 */
export const ATOM_UNREGISTERED: ValidationRule = {
  code: 'ATOM_UNREGISTERED',
  category: 'errors',
  severity: 'warning',
  nodeTypes: ['AtomLiteral'],

  validate(node: ASTNode, context: ValidationContext): Diagnostic[] {
    const atom = node as AtomLiteralNode;
    if (BUILTIN_ATOMS.has(atom.name)) return [];

    return [
      {
        location: atom.span.start,
        severity: 'warning',
        code: 'ATOM_UNREGISTERED',
        message: `Atom #${atom.name} is not a runtime builtin; ensure the host registers it via registerErrorCode.`,
        context: extractContextLine(atom.span.start.line, context.source),
        fix: null,
      },
    ];
  },
};

// ============================================================
// STATUS_PROBE_NO_FIELD
// ============================================================

/**
 * Suggests selecting a field on `.!` probes used as values. Bare `.!`
 * yields the whole status record; `.!code`, `.!message`, or `.!provider`
 * are usually what callers want. Probes used in boolean position (the
 * direct condition of a Conditional/While/DoWhile) do not fire.
 */
export const STATUS_PROBE_NO_FIELD: ValidationRule = {
  code: 'STATUS_PROBE_NO_FIELD',
  category: 'errors',
  severity: 'info',
  nodeTypes: ['StatusProbe'],

  validate(node: ASTNode, context: ValidationContext): Diagnostic[] {
    const probe = node as StatusProbeNode;
    if (probe.field !== undefined) return [];

    return [
      {
        location: probe.span.start,
        severity: 'info',
        code: 'STATUS_PROBE_NO_FIELD',
        message:
          'Bare .! returns the whole status record. Project a field with .!code, .!message, or .!provider.',
        context: extractContextLine(probe.span.start.line, context.source),
        fix: null,
      },
    ];
  },
};

// ============================================================
// PRESENCE_OVER_NULL_GUARD
// ============================================================

/**
 * Detects `($x == nil) ? fallback ! $x` and `($x != nil) ? $x ! fallback`
 * patterns. The default operator (`$x ?? fallback`) reads better and avoids
 * branching.
 */
export const PRESENCE_OVER_NULL_GUARD: ValidationRule = {
  code: 'PRESENCE_OVER_NULL_GUARD',
  category: 'errors',
  severity: 'info',
  nodeTypes: ['Conditional'],

  validate(node: ASTNode, context: ValidationContext): Diagnostic[] {
    const cond = node as ConditionalNode;
    const binExpr = unwrapConditionToBinary(cond);
    if (!binExpr) return [];
    if (binExpr.op !== '==' && binExpr.op !== '!=') return [];
    if (!operandIsNil(binExpr.left) && !operandIsNil(binExpr.right)) return [];

    return [
      {
        location: cond.span.start,
        severity: 'info',
        code: 'PRESENCE_OVER_NULL_GUARD',
        message:
          'Nil-checking conditional. Prefer the default operator: $x ?? fallback.',
        context: extractContextLine(cond.span.start.line, context.source),
        fix: null,
      },
    ];
  },
};

// ============================================================
// GUARD_OVER_TRY_CATCH
// ============================================================

/**
 * Detects `Conditional` whose condition inspects a `.!` status probe.
 * Branching on `.!code == #TIMEOUT` is the manual try/catch shape; wrapping
 * the fallible call in `guard<on: list[#TIMEOUT]> { ... }` is the idiomatic
 * 0.19.0 form.
 */
export const GUARD_OVER_TRY_CATCH: ValidationRule = {
  code: 'GUARD_OVER_TRY_CATCH',
  category: 'errors',
  severity: 'info',
  nodeTypes: ['Conditional'],

  validate(node: ASTNode, context: ValidationContext): Diagnostic[] {
    const cond = node as ConditionalNode;
    if (!cond.condition) return [];
    if (!subtreeContainsStatusProbe(cond.condition)) return [];

    return [
      {
        location: cond.span.start,
        severity: 'info',
        code: 'GUARD_OVER_TRY_CATCH',
        message:
          'Branching on .! is manual try/catch. Wrap the fallible call in guard<on: list[#X]> { ... }.',
        context: extractContextLine(cond.span.start.line, context.source),
        fix: null,
      },
    ];
  },
};

// ============================================================
// HELPERS
// ============================================================

/**
 * Peel a Conditional's condition down to its BinaryExpr head, if any.
 * Conditions parse as `BodyNode` (Block | GroupedExpr | PostfixExpr |
 * PipeChain). We handle the common ternary forms: bare PostfixExpr
 * containing a BinaryExpr (rare) and the typical GroupedExpr -> PipeChain
 * -> BinaryExpr shape from `($x == nil) ? ...`.
 */
function unwrapConditionToBinary(cond: ConditionalNode): BinaryExprNode | null {
  const expr = cond.condition;
  if (!expr) return null;

  let inner: ASTNode | null = expr;
  if (inner && inner.type === 'GroupedExpr') {
    inner = (inner as GroupedExprNode).expression;
  }
  if (inner && inner.type === 'PipeChain') {
    const chain = inner as PipeChainNode;
    if (chain.pipes.length !== 0) return null;
    inner = chain.head;
  }
  if (inner && inner.type === 'BinaryExpr') {
    return inner as BinaryExprNode;
  }
  return null;
}

/**
 * Return true when an arithmetic operand is the bareword `nil`. The parser
 * lowers `nil` to a zero-arg HostCall, wrapped in a PostfixExpr.
 */
function operandIsNil(operand: ASTNode | null | undefined): boolean {
  if (!operand) return false;
  if (operand.type !== 'PostfixExpr') return false;
  const postfix = operand as PostfixExprNode;
  if (postfix.methods.length !== 0) return false;
  const primary = postfix.primary;
  if (primary.type !== 'HostCall') return false;
  const call = primary as HostCallNode;
  return call.name === 'nil' && call.args.length === 0;
}

/**
 * Walk a subtree to detect any StatusProbe node.
 */
function subtreeContainsStatusProbe(root: ASTNode): boolean {
  let found = false;
  const ctx = {} as ValidationContext;
  visitNode(root, ctx, {
    enter(n: ASTNode) {
      if (n.type === 'StatusProbe') found = true;
    },
    exit() {},
  });
  return found;
}
