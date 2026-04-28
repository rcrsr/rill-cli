/**
 * Collection Operator Rules
 * Enforces conventions for the collection callables seq, fan, fold, filter, acc.
 */

import type {
  ValidationRule,
  Diagnostic,
  ValidationContext,
} from '../types.js';
import type {
  ASTNode,
  BlockNode,
  ClosureNode,
  HostCallNode,
  BodyNode,
} from '@rcrsr/rill';
import { extractContextLine } from './helpers.js';
import { visitNode } from '../visitor.js';
import {
  isCollectionOpCall,
  isParallelOp,
  getCollectionOpBody,
} from '../collection-ops.js';

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Check if an AST subtree contains a Break node.
 * Uses visitNode for full AST traversal.
 */
function containsBreak(node: ASTNode): boolean {
  let found = false;
  const ctx = {} as ValidationContext;
  visitNode(node, ctx, {
    enter(n: ASTNode) {
      if (n.type === 'Break') {
        found = true;
      }
    },
    exit() {},
  });
  return found;
}

/**
 * Check if an AST subtree contains side-effecting operations.
 * Detects HostCall (log, host functions) and ClosureCall ($fn(), $obj.method()).
 */
function containsSideEffects(node: ASTNode): boolean {
  let found = false;
  const ctx = {} as ValidationContext;
  visitNode(node, ctx, {
    enter(n: ASTNode) {
      if (n.type === 'HostCall' || n.type === 'ClosureCall') {
        found = true;
      }
    },
    exit() {},
  });
  return found;
}

/**
 * Unwrap a Block-with-single-Statement to the inner expression's head.
 * In 0.19.0 collection-op bodies are always wrapped in `{...}`, so a literal
 * `.empty` arrives as Block → Statement → PipeChain → PostfixExpr.
 */
function unwrapBlockToHead(body: BodyNode): ASTNode | null {
  if (body.type !== 'Block') return body;
  if (body.statements.length !== 1) return null;
  const stmt = body.statements[0];
  if (!stmt || stmt.type !== 'Statement') return null;
  const expr = stmt.expression;
  if (expr.type !== 'PipeChain') return null;
  if (expr.pipes.length !== 0) return null;
  return expr.head;
}

/**
 * Check if a body is a method shorthand (`.upper`, `.empty`, etc).
 * Matches both bare PostfixExpr and Block-wrapped shorthand.
 */
function isMethodShorthand(body: BodyNode): boolean {
  const head = unwrapBlockToHead(body);
  if (!head) return false;
  if (head.type !== 'PostfixExpr') return false;
  if (head.methods.length !== 0) return false;
  return head.primary.type === 'MethodCall';
}

/**
 * Check if a body is a block wrapping a single method call on $.
 * Example: { $.upper() } when it could be .upper
 * Structure: Block -> Statement -> PipeChain -> PostfixExpr($) with methods
 */
function isBlockWrappingMethod(body: BodyNode): boolean {
  if (body.type !== 'Block') return false;
  if (body.statements.length !== 1) return false;

  const stmt = body.statements[0];
  if (!stmt || stmt.type !== 'Statement') return false;

  const expr = stmt.expression;
  if (expr.type !== 'PipeChain') return false;

  // Should have no pipes (direct method call on head)
  if (expr.pipes.length !== 0) return false;

  const head = expr.head;
  if (head.type !== 'PostfixExpr') return false;

  // Primary should be pipe variable ($)
  if (head.primary.type !== 'Variable') return false;
  const variable = head.primary;
  if (!('isPipeVar' in variable) || !variable.isPipeVar) return false;

  // Should have exactly one method in the methods array
  if (head.methods.length !== 1) return false;
  if (head.methods[0]?.type !== 'MethodCall') return false;

  return true;
}

/**
 * Get method name from a closure body.
 * Handles both PostfixExpr shorthand (raw or block-wrapped) and the verbose
 * `{ $.method() }` block form.
 */
function getMethodName(body: BodyNode): string | null {
  // Shorthand form: PostfixExpr with MethodCall primary (raw or block-wrapped)
  const head = unwrapBlockToHead(body);
  if (
    head &&
    head.type === 'PostfixExpr' &&
    head.methods.length === 0 &&
    head.primary.type === 'MethodCall'
  ) {
    return head.primary.name;
  }

  // Block form: $.method()
  if (isBlockWrappingMethod(body) && body.type === 'Block') {
    const stmt = body.statements[0];
    if (!stmt || stmt.type !== 'Statement') return null;

    const expr = stmt.expression;
    if (expr.type !== 'PipeChain') return null;

    const head2 = expr.head;
    if (head2.type !== 'PostfixExpr') return null;

    const method = head2.methods[0];
    if (method && method.type === 'MethodCall') {
      return method.name;
    }
  }

  return null;
}

/**
 * Resolve the body to inspect for a collection-op call.
 * - `seq({block})` — arg primary is a Block; we inspect that Block directly.
 * - `seq(|x|(expr))` — arg primary is a Closure; we inspect closure.body.
 * Both return values are valid `BodyNode` shapes.
 */
function resolveOpBody(node: HostCallNode): BodyNode | null {
  const arg = getCollectionOpBody(node);
  if (!arg) return null;
  if (arg.type === 'Closure') return (arg as ClosureNode).body;
  return arg as BlockNode;
}

// ============================================================
// BREAK_IN_PARALLEL RULE
// ============================================================

/**
 * Validates that break is not used in parallel operators (`fan`, `filter`).
 *
 * Break is semantically invalid in parallel execution contexts. It is valid in
 * sequential operators (`seq`, `acc`, `fold`).
 *
 * Error severity because this is semantically wrong, not just stylistic.
 */
export const BREAK_IN_PARALLEL: ValidationRule = {
  code: 'BREAK_IN_PARALLEL',
  category: 'collections',
  severity: 'error',
  nodeTypes: ['HostCall'],

  validate(node: ASTNode, context: ValidationContext): Diagnostic[] {
    if (!isCollectionOpCall(node)) return [];
    if (!isParallelOp(node.name)) return [];

    const body = resolveOpBody(node);
    if (!body) return [];

    if (containsBreak(body)) {
      return [
        {
          location: node.span.start,
          severity: 'error',
          code: 'BREAK_IN_PARALLEL',
          message: `Break not allowed in '${node.name}' (parallel operator). Use 'seq' for sequential iteration with break.`,
          context: extractContextLine(node.span.start.line, context.source),
          fix: null,
        },
      ];
    }

    return [];
  },
};

// ============================================================
// PREFER_FAN RULE (formerly PREFER_MAP)
// ============================================================

/**
 * Suggests using `fan` over `seq` when no side effects are present.
 *
 * `fan` is semantically clearer for pure transformations: it signals no side
 * effects and may execute in parallel.
 *
 * Detects `seq` calls whose closure body contains no side-effecting operations
 * (host calls, logging). With 0.19.0, `seq` strictly has no accumulator
 * (`acc` is a separate callable), so the legacy accumulator-detection branch
 * is gone.
 */
export const PREFER_MAP: ValidationRule = {
  code: 'PREFER_MAP',
  category: 'collections',
  severity: 'info',
  nodeTypes: ['HostCall'],

  validate(node: ASTNode, context: ValidationContext): Diagnostic[] {
    if (!isCollectionOpCall(node)) return [];
    if (node.name !== 'seq') return [];

    const body = resolveOpBody(node);
    if (!body) return [];

    if (containsSideEffects(body)) {
      return [];
    }

    return [
      {
        location: node.span.start,
        severity: 'info',
        code: 'PREFER_MAP',
        message:
          "Consider using 'fan' instead of 'seq' for pure transformations (no side effects)",
        context: extractContextLine(node.span.start.line, context.source),
        fix: null,
      },
    ];
  },
};

// ============================================================
// FOLD_INTERMEDIATES RULE
// ============================================================

/**
 * Suggests `fold` for final-only results, `acc` for running totals.
 *
 * - `fold(init, {body})` returns final accumulated value only
 * - `acc(init, {body})` returns list of all intermediate results
 *
 * Informational placeholder - real implementation requires flow analysis.
 */
export const FOLD_INTERMEDIATES: ValidationRule = {
  code: 'FOLD_INTERMEDIATES',
  category: 'collections',
  severity: 'info',
  nodeTypes: ['HostCall'],

  validate(node: ASTNode, _context: ValidationContext): Diagnostic[] {
    if (!isCollectionOpCall(node)) return [];
    // Reserved for future flow-analysis on seq/fold/acc.
    return [];
  },
};

// ============================================================
// FILTER_NEGATION RULE
// ============================================================

/**
 * Validates that negation in `filter` uses grouped form.
 *
 * Grouped negation is clearer and prevents bugs:
 * - Correct: filter ({ !.empty })  -- grouped negation
 * - Wrong:   filter ({ .empty })   -- filters for empty elements (likely bug)
 */
export const FILTER_NEGATION: ValidationRule = {
  code: 'FILTER_NEGATION',
  category: 'collections',
  severity: 'warning',
  nodeTypes: ['HostCall'],

  validate(node: ASTNode, context: ValidationContext): Diagnostic[] {
    if (!isCollectionOpCall(node)) return [];
    if (node.name !== 'filter') return [];

    const body = resolveOpBody(node);
    if (!body) return [];

    if (isMethodShorthand(body)) {
      const methodName = getMethodName(body);

      if (methodName === 'empty') {
        return [
          {
            location: node.span.start,
            severity: 'warning',
            code: 'FILTER_NEGATION',
            message: `Filter with '.${methodName}' likely unintended. Use grouped negation: 'filter({ !.${methodName} })' to filter non-${methodName} elements`,
            context: extractContextLine(node.span.start.line, context.source),
            fix: null,
          },
        ];
      }
    }

    return [];
  },
};

// ============================================================
// METHOD_SHORTHAND RULE
// ============================================================

/**
 * Suggests using method shorthand over block form in collection operators.
 *
 * Block-wrapping a single method call is verbose:
 * - Verbose:    fan({ $.upper() })
 * - Preferred:  fan(.upper)  -- when supported
 *
 * Informational - both forms work identically.
 */
export const METHOD_SHORTHAND: ValidationRule = {
  code: 'METHOD_SHORTHAND',
  category: 'collections',
  severity: 'info',
  nodeTypes: ['HostCall'],

  validate(node: ASTNode, context: ValidationContext): Diagnostic[] {
    if (!isCollectionOpCall(node)) return [];

    const body = resolveOpBody(node);
    if (!body) return [];

    if (isBlockWrappingMethod(body)) {
      const methodName = getMethodName(body);

      if (methodName) {
        return [
          {
            location: node.span.start,
            severity: 'info',
            code: 'METHOD_SHORTHAND',
            message: `Prefer method shorthand '.${methodName}' over block form '{ $.${methodName}() }'`,
            context: extractContextLine(node.span.start.line, context.source),
            fix: null,
          },
        ];
      }
    }

    return [];
  },
};
