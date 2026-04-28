/**
 * Closure Convention Rules
 * Enforces closure best practices from docs/guide-conventions.md:237-286.
 */

import type {
  ValidationRule,
  Diagnostic,
  ValidationContext,
} from '../types.js';
import type {
  ASTNode,
  ClosureNode,
  GroupedExprNode,
  HostCallNode,
  PipeChainNode,
  PostfixExprNode,
  VariableNode,
} from '@rcrsr/rill';
import { extractContextLine } from './helpers.js';
import { visitNode } from '../visitor.js';
import { isCollectionOpCall, getCollectionOpBody } from '../collection-ops.js';

// ============================================================
// CLOSURE_BARE_DOLLAR RULE
// ============================================================

/**
 * Warns on bare $ in stored closures without parameters.
 * Bare $ in stored closures has ambiguous binding - it refers to the
 * pipe value at closure invocation time, not definition time.
 *
 * Detection:
 * - Zero-parameter closures (|| { }) used outside dict context
 * - Body contains bare $ references (VariableNode with name '$')
 *
 * Valid patterns:
 * - Dict closures: [count: ||{ $.items -> .len }]  ($ binds to dict)
 * - Parameterized closures: |x|{ $x }  (explicit params)
 * - Inline blocks: -> { $ * 2 }  (immediate evaluation)
 *
 * References:
 * - docs/guide-conventions.md:251-261
 * - docs/topic-closures.md: Late binding section
 */
export const CLOSURE_BARE_DOLLAR: ValidationRule = {
  code: 'CLOSURE_BARE_DOLLAR',
  category: 'closures',
  severity: 'warning',
  nodeTypes: ['Closure'],

  validate(node: ASTNode, context: ValidationContext): Diagnostic[] {
    const closureNode = node as ClosureNode;

    // Only check zero-parameter closures (|| { })
    if (closureNode.params.length > 0) {
      return [];
    }

    // Check if closure body contains bare $ references
    const hasBareReference = containsBareReference(closureNode.body);

    if (hasBareReference) {
      return [
        {
          location: closureNode.span.start,
          severity: 'warning',
          code: 'CLOSURE_BARE_DOLLAR',
          message:
            'Bare $ in stored closure has ambiguous binding. Use explicit capture: $ => $item',
          context: extractContextLine(
            closureNode.span.start.line,
            context.source
          ),
          fix: null, // Cannot auto-fix safely - requires context understanding
        },
      ];
    }

    return [];
  },
};

/**
 * Check if a node tree contains bare $ variable references.
 * Uses visitNode for full AST traversal, detecting VariableNode with isPipeVar=true.
 */
function containsBareReference(node: ASTNode): boolean {
  let found = false;
  let scopeDepth = 0;
  // Treat both Closure literals and collection-op HostCalls as scopes:
  // inside `seq/fan/fold/filter/acc` the bare `$` is the iteration element,
  // not the outer closure's pipe value.
  const ctx = {} as ValidationContext;
  visitNode(node, ctx, {
    enter(n: ASTNode) {
      if (n.type === 'Closure' || isCollectionOpCall(n)) {
        scopeDepth++;
        return;
      }
      if (scopeDepth > 0) return;
      if (n.type === 'Variable' && (n as VariableNode).isPipeVar) {
        found = true;
      }
    },
    exit(n: ASTNode) {
      if (n.type === 'Closure' || isCollectionOpCall(n)) {
        scopeDepth--;
      }
    },
  });
  return found;
}

// ============================================================
// CLOSURE_BRACES RULE
// ============================================================

/**
 * Enforces braces for complex closure bodies.
 * Simple expressions can use parentheses, but complex bodies need braces.
 *
 * Complex body criteria:
 * - Contains Block (multiple statements)
 * - Contains Conditional
 * - Contains loop constructs
 *
 * Simple bodies (parentheses OK):
 * - Single expression: |x|($x * 2)
 * - Single method chain: |s|($s.trim.lower)
 *
 * Complex bodies (braces required):
 * - Conditionals: |n| { ($n < 1) ? 1 ! ($n * $fact($n - 1)) }
 * - Multiple statements: |x| { $x => $y; $y * 2 }
 *
 * References:
 * - docs/guide-conventions.md:239-249
 */
export const CLOSURE_BRACES: ValidationRule = {
  code: 'CLOSURE_BRACES',
  category: 'closures',
  severity: 'info',
  nodeTypes: ['Closure'],

  validate(node: ASTNode, context: ValidationContext): Diagnostic[] {
    const closureNode = node as ClosureNode;
    const body = closureNode.body;

    // Check if body is GroupedExpr containing complex content
    if (body.type === 'GroupedExpr') {
      const grouped = body as GroupedExprNode;
      const innerExpr = grouped.expression;

      // Navigate through PipeChain to find the actual content
      let content: ASTNode = innerExpr;
      if (innerExpr && innerExpr.type === 'PipeChain') {
        const head = innerExpr.head;
        // Check if head is PostfixExpr
        if (head && head.type === 'PostfixExpr') {
          content = head.primary;
        } else {
          content = head;
        }
      }

      // Check if the content is a conditional or loop
      const isComplex =
        content &&
        (content.type === 'Conditional' ||
          content.type === 'WhileLoop' ||
          content.type === 'DoWhileLoop' ||
          content.type === 'GuardBlock' ||
          content.type === 'RetryBlock');

      if (isComplex) {
        return [
          {
            location: closureNode.span.start,
            severity: 'info',
            code: 'CLOSURE_BRACES',
            message:
              'Use braces for complex closure bodies (conditionals, loops)',
            context: extractContextLine(
              closureNode.span.start.line,
              context.source
            ),
            fix: null, // Auto-fix would require AST reconstruction
          },
        ];
      }
    }

    return [];
  },
};

// ============================================================
// CLOSURE_LATE_BINDING RULE
// ============================================================

/**
 * Detects closures created inside sequential collection bodies that may
 * suffer from late binding issues. Closures capture variables by reference,
 * so all closures created in a loop body share the final iteration value.
 *
 * Targets the sequential callables `seq` and `acc`. (`fan`/`filter` execute
 * in parallel, `fold` reduces to a single value, so late-binding pitfalls
 * are less common there.)
 *
 * Solution: Explicit capture per iteration:
 *   [1, 2, 3] -> seq({
 *     $ => $item
 *     || { $item }
 *   })
 */
export const CLOSURE_LATE_BINDING: ValidationRule = {
  code: 'CLOSURE_LATE_BINDING',
  category: 'closures',
  severity: 'warning',
  nodeTypes: ['HostCall'],

  validate(node: ASTNode, context: ValidationContext): Diagnostic[] {
    if (!isCollectionOpCall(node)) return [];
    if (node.name !== 'seq' && node.name !== 'acc') return [];

    const opCall = node as HostCallNode;
    const arg = getCollectionOpBody(opCall);
    if (!arg) return [];

    // For closure form (|x|{...}) inspect closure.body; for bare-block form
    // ({...}) inspect the Block directly.
    const innerBody = arg.type === 'Closure' ? (arg as ClosureNode).body : arg;

    // Check if body contains a closure creation
    const hasClosureCreation = containsClosureCreation(innerBody);
    if (!hasClosureCreation) return [];

    // Check if there's an explicit capture before the closure
    const hasExplicitCapture = containsExplicitCapture(innerBody);
    if (hasExplicitCapture) return [];

    return [
      {
        location: opCall.span.start,
        severity: 'warning',
        code: 'CLOSURE_LATE_BINDING',
        message:
          'Capture loop variable explicitly for deferred closures: $ => $item',
        context: extractContextLine(opCall.span.start.line, context.source),
        fix: null,
      },
    ];
  },
};

/**
 * Check if a node contains a closure creation (Closure node).
 * Uses visitNode for full AST traversal.
 */
function containsClosureCreation(node: ASTNode): boolean {
  let found = false;
  const ctx = {} as ValidationContext;
  visitNode(node, ctx, {
    enter(n: ASTNode) {
      if (n.type === 'Closure') {
        found = true;
      }
    },
    exit() {},
  });
  return found;
}

/**
 * Check if a Block node contains an explicit capture statement ($ => $name)
 * at the top level (closureDepth === 0). Captures inside nested closures
 * are scoped to that closure and do not fix late binding for the each body.
 */
function containsExplicitCapture(node: ASTNode): boolean {
  if (node.type !== 'Block') {
    return false;
  }

  let found = false;
  let closureDepth = 0;
  const ctx = {} as ValidationContext;
  visitNode(node, ctx, {
    enter(n: ASTNode) {
      if (n.type === 'Closure') {
        closureDepth++;
        return;
      }
      if (closureDepth > 0) return;
      if (n.type !== 'PipeChain') return;
      const chain = n as PipeChainNode;
      const head = chain.head;
      if (!head || head.type !== 'PostfixExpr') return;
      const postfix = head as PostfixExprNode;
      if (!postfix.primary || postfix.primary.type !== 'Variable') return;
      if (!(postfix.primary as VariableNode).isPipeVar) return;
      for (const pipe of chain.pipes) {
        if (pipe.type === 'Capture') {
          found = true;
        }
      }
    },
    exit(n: ASTNode) {
      if (n.type === 'Closure') {
        closureDepth--;
      }
    },
  });
  return found;
}
