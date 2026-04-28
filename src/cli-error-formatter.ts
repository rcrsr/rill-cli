/**
 * CLI Error Formatter
 * Format enriched errors for human-readable, JSON, or compact output
 */

import type { SourceSpan, CallFrame } from '@rcrsr/rill';
import type { EnrichedError, HaltView } from './cli-error-enrichment.js';

// ============================================================
// PUBLIC TYPES
// ============================================================

export type { CallFrame, EnrichedError };

export type TraceMode = 'auto' | 'always' | 'never';

/**
 * Format options for error output.
 *
 * `trace` controls when the trace block renders for halt-bearing errors:
 * - `auto`: render only when status carries >= 2 frames (default)
 * - `always`: render whenever a halt view is present
 * - `never`: omit the block entirely
 *
 * `atomOnly` (JSON only) emits `{atom, errorId}` headers for CI consumers.
 * `showRecovered` is a placeholder for the successful-result side path
 * (rendering `guard-caught` frames on a recovered invalid value).
 */
export interface FormatOptions {
  readonly format: 'human' | 'json' | 'compact';
  readonly verbose: boolean;
  readonly includeCallStack: boolean;
  readonly maxCallStackDepth: number;
  readonly trace?: TraceMode | undefined;
  readonly showRecovered?: boolean | undefined;
  readonly atomOnly?: boolean | undefined;
}

// ============================================================
// ERROR FORMATTING
// ============================================================

/**
 * Format enriched error for output.
 *
 * Constraints:
 * - Human format: multi-line with snippet and caret underline
 * - JSON format: LSP Diagnostic compatible
 * - Compact format: single line for CI output
 *
 * @param error - Enriched error with context
 * @param options - Format options
 * @returns Formatted error string
 * @throws {TypeError} Unknown format
 */
export function formatError(
  error: EnrichedError,
  options: FormatOptions
): string {
  // EC-5: Unknown format throws TypeError
  if (
    options.format !== 'human' &&
    options.format !== 'json' &&
    options.format !== 'compact'
  ) {
    throw new TypeError(`Unknown format: ${options.format}`);
  }

  if (options.format === 'json') {
    return formatErrorJson(error, options);
  }

  if (options.format === 'compact') {
    return formatErrorCompact(error);
  }

  return formatErrorHuman(error, options);
}

/**
 * Format error in human-readable format.
 *
 * Output format:
 * ```
 * error[RILL-R005]: Variable foo is not defined
 *   --> script.rill:5:10
 *    |
 *  3 | "start" => $begin
 *  4 | $begin -> .upper => $upper
 *  5 | $foo -> .len
 *    |   ^^^^ undefined variable
 *    |
 *    = help: Did you mean `$begin`?
 * ```
 */
function formatErrorHuman(
  error: EnrichedError,
  options: FormatOptions
): string {
  const lines: string[] = [];

  // Unified header: error[:provider][ID[#ATOM]]: message
  // Atom is omitted when it is just the underscore form of the error id
  // (e.g., #RILL_R038 for RILL-R038), since it conveys nothing extra.
  const message =
    error.halt && error.halt.message !== ''
      ? error.halt.message
      : error.message;
  const providerTag =
    error.halt && error.halt.provider !== null ? `:${error.halt.provider}` : '';
  const atomTag =
    error.halt &&
    error.halt.atom !== null &&
    !atomMatchesId(error.halt.atom, error.errorId)
      ? `${error.halt.atom}`
      : '';
  lines.push(`error${providerTag}[${error.errorId}${atomTag}]: ${message}`);

  // Halt path: trace frames carry precise origin locations and snippets.
  // For uncaught top-level errors this is a single-frame trace; for guard-
  // recovered invalids it's the full chain. Either way the trace replaces
  // the span-based snippet block (which uses the broader error span).
  // trace=never disables the trace-driven layout entirely (falls back to
  // span+snippet, the legacy non-halt behavior). trace=auto/always use the
  // trace when present.
  const traceMode: TraceMode = options.trace ?? 'auto';
  const useTrace =
    traceMode !== 'never' &&
    error.halt !== undefined &&
    error.halt.trace.length > 0;

  if (useTrace) {
    renderTraceBlock(
      lines,
      error.halt!,
      error.source,
      error.filePath,
      traceMode
    );
  } else {
    // Location: --> [path:]line:col
    if (error.span) {
      const loc = `${error.span.start.line}:${error.span.start.column}`;
      const prefix = error.filePath ? `${error.filePath}:` : '';
      lines.push(`  --> ${prefix}${loc}`);
    }

    // Source snippet with caret underline
    if (error.sourceSnippet && error.sourceSnippet.lines.length > 0) {
      lines.push('   |');

      const maxLineNumber = Math.max(
        ...error.sourceSnippet.lines.map((l) => l.lineNumber)
      );
      const lineNumberWidth = String(maxLineNumber).length;

      for (const line of error.sourceSnippet.lines) {
        const lineNumStr = String(line.lineNumber).padStart(
          lineNumberWidth,
          ' '
        );
        lines.push(` ${lineNumStr} | ${line.content}`);

        if (line.isErrorLine && error.span) {
          const caret = renderCaretUnderline(error.span, line.content);
          const padding = ' '.repeat(lineNumberWidth);
          lines.push(` ${padding} | ${caret}`);
        }
      }
      lines.push('   |');
    }
  }

  // Suggestions: = help: Did you mean `$begin`?
  if (error.suggestions && error.suggestions.length > 0) {
    for (const suggestion of error.suggestions) {
      lines.push(`   = help: ${suggestion}`);
    }
  }

  // Help URL
  if (options.verbose && error.helpUrl) {
    lines.push(`   = see: ${error.helpUrl}`);
  }

  // Call stack
  if (
    options.includeCallStack &&
    error.callStack &&
    error.callStack.length > 0
  ) {
    lines.push('');
    lines.push('Call stack:');
    const depth = Math.min(error.callStack.length, options.maxCallStackDepth);
    for (let i = 0; i < depth; i++) {
      const frame = error.callStack[i]!;
      const location = `${frame.location.start.line}:${frame.location.start.column}`;
      const name = frame.functionName ?? '<anonymous>';
      const context = frame.context ? ` (${frame.context})` : '';
      lines.push(`  ${i + 1}. ${name}${context} at ${location}`);
    }
    if (error.callStack.length > depth) {
      lines.push(`  ... ${error.callStack.length - depth} more frames`);
    }
  }

  return lines.join('\n');
}

/**
 * Format error in JSON format (LSP Diagnostic compatible).
 */
function formatErrorJson(error: EnrichedError, options: FormatOptions): string {
  if (options.atomOnly === true) {
    return JSON.stringify(
      {
        atom: error.halt?.atom ?? null,
        errorId: error.errorId,
      },
      null,
      2
    );
  }

  const diagnostic: {
    errorId: string;
    severity: number;
    message: string;
    range?: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    source: string;
    code: string;
    suggestions?: string[];
    callStack?: Array<{
      location: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      functionName?: string | undefined;
      context?: string | undefined;
    }>;
    helpUrl?: string;
    atom?: string | null;
    provider?: string | null;
    trace?: Array<{
      site: string;
      kind: string;
      fn: string;
      wrapped?: Record<string, unknown>;
    }>;
    raw?: Record<string, unknown>;
  } = {
    errorId: error.errorId,
    severity: 1, // Error severity in LSP (1 = Error, 2 = Warning, 3 = Information, 4 = Hint)
    message: error.message,
    source: 'rill',
    code: error.errorId,
  };

  if (error.span) {
    diagnostic.range = {
      start: {
        line: error.span.start.line - 1, // LSP uses 0-based line numbers
        character: error.span.start.column - 1, // LSP uses 0-based character positions
      },
      end: {
        line: error.span.end.line - 1, // LSP uses 0-based line numbers
        character: error.span.end.column - 1, // LSP uses 0-based character positions
      },
    };
  }

  if (error.suggestions && error.suggestions.length > 0) {
    diagnostic.suggestions = error.suggestions;
  }

  if (
    options.includeCallStack &&
    error.callStack &&
    error.callStack.length > 0
  ) {
    const depth = Math.min(error.callStack.length, options.maxCallStackDepth);
    diagnostic.callStack = error.callStack.slice(0, depth).map((frame) => {
      const callFrame: {
        location: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };
        functionName?: string | undefined;
        context?: string | undefined;
      } = {
        location: {
          start: {
            line: frame.location.start.line - 1,
            character: frame.location.start.column - 1,
          },
          end: {
            line: frame.location.end.line - 1,
            character: frame.location.end.column - 1,
          },
        },
      };
      if (frame.functionName !== undefined) {
        callFrame.functionName = frame.functionName;
      }
      if (frame.context !== undefined) {
        callFrame.context = frame.context;
      }
      return callFrame;
    });
  }

  if (options.verbose && error.helpUrl) {
    diagnostic.helpUrl = error.helpUrl;
  }

  if (error.halt) {
    diagnostic.atom = error.halt.atom;
    diagnostic.provider = error.halt.provider;
    diagnostic.trace = error.halt.trace.map((frame) => {
      const wrapped = frame.wrapped as Record<string, unknown>;
      const out: {
        site: string;
        kind: string;
        fn: string;
        wrapped?: Record<string, unknown>;
      } = {
        site: frame.site,
        kind: frame.kind,
        fn: frame.fn,
      };
      if (frame.kind === 'wrap' && Object.keys(wrapped).length > 0) {
        out.wrapped = wrapped;
      }
      return out;
    });
    if (Object.keys(error.halt.raw).length > 0) {
      diagnostic.raw = error.halt.raw as Record<string, unknown>;
    }
  }

  return JSON.stringify(diagnostic, null, 2);
}

/**
 * Format error in compact format (single line for CI).
 */
function formatErrorCompact(error: EnrichedError): string {
  const parts: string[] = [`[${error.errorId}]`, error.message];

  if (error.span) {
    parts.push(`at ${error.span.start.line}:${error.span.start.column}`);
  }

  if (error.suggestions && error.suggestions.length > 0) {
    parts.push(`(hint: ${error.suggestions[0]})`);
  }

  return parts.join(' ');
}

// ============================================================
// HALT RENDERING
// ============================================================

function atomMatchesId(atom: string, errorId: string): boolean {
  return atom === `#${errorId.replace(/-/g, '_')}`;
}

interface ParsedSite {
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

function parseSite(site: string): ParsedSite | null {
  // Format: <path>:<line>[:<col>] — path may contain colons (`<script>`,
  // Windows drive letters), so anchor on trailing numeric segments.
  const withCol = /^(.+):(\d+):(\d+)$/.exec(site);
  if (withCol) {
    const line = Number.parseInt(withCol[2]!, 10);
    const column = Number.parseInt(withCol[3]!, 10);
    if (Number.isFinite(line) && line >= 1) {
      return { path: withCol[1]!, line, column };
    }
  }
  const noCol = /^(.+):(\d+)$/.exec(site);
  if (noCol) {
    const line = Number.parseInt(noCol[2]!, 10);
    if (Number.isFinite(line) && line >= 1) {
      return { path: noCol[1]!, line, column: 1 };
    }
  }
  return null;
}

function renderTraceBlock(
  lines: string[],
  halt: HaltView,
  source: string | undefined,
  filePath: string | undefined,
  traceMode: TraceMode
): void {
  // Origin (first frame) drives the --> line.
  const first = parseSite(halt.trace[0]!.site);
  if (first) {
    const display =
      filePath && (first.path === '<script>' || first.path === filePath)
        ? `${filePath}:${first.line}:${first.column}`
        : halt.trace[0]!.site;
    lines.push(`  --> ${display}`);
  }

  const sourceLines = source !== undefined ? source.split('\n') : null;
  // Single-frame default: inline snippet (legacy non-halt layout).
  // Multi-frame or trace=always: numbered list with per-frame snippets.
  const useNumberedBlock = traceMode === 'always' || halt.trace.length >= 2;

  if (!useNumberedBlock) {
    if (sourceLines && first) {
      const isScript =
        first.path === '<script>' ||
        (filePath !== undefined && first.path === filePath);
      if (isScript) {
        renderInlineSnippet(lines, first, sourceLines);
      }
    }
    return;
  }

  lines.push('   = trace:');
  halt.trace.forEach((frame, idx) => {
    const parsed = parseSite(frame.site);
    const isScript =
      parsed !== null &&
      (parsed.path === '<script>' ||
        (filePath !== undefined && parsed.path === filePath));
    const display =
      parsed && isScript && filePath
        ? `${filePath}:${parsed.line}:${parsed.column}`
        : frame.site;
    lines.push(`     ${idx + 1}. ${display}`);
    if (frame.kind === 'wrap' && Object.keys(frame.wrapped).length > 0) {
      lines.push(`        wrapped: ${formatWrapped(frame.wrapped)}`);
    }
    if (sourceLines && parsed && isScript) {
      renderFrameSnippet(lines, parsed, sourceLines, '        ');
    }
  });
}

function renderInlineSnippet(
  lines: string[],
  parsed: ParsedSite,
  sourceLines: readonly string[]
): void {
  const content = sourceLines[parsed.line - 1];
  if (content === undefined) return;
  const lineNumStr = String(parsed.line);
  const padding = ' '.repeat(lineNumStr.length);
  const caretPad = ' '.repeat(Math.max(0, parsed.column - 1));
  lines.push(`   |`);
  lines.push(` ${lineNumStr} | ${content}`);
  lines.push(` ${padding} | ${caretPad}^`);
}

function renderFrameSnippet(
  lines: string[],
  parsed: ParsedSite,
  sourceLines: readonly string[],
  indent: string
): void {
  const content = sourceLines[parsed.line - 1];
  if (content === undefined) return;
  const lineNumStr = String(parsed.line);
  const padding = ' '.repeat(lineNumStr.length);
  const caretPad = ' '.repeat(Math.max(0, parsed.column - 1));
  lines.push(`${indent}${padding} |`);
  lines.push(`${indent}${lineNumStr} | ${content}`);
  lines.push(`${indent}${padding} | ${caretPad}^`);
}

function formatWrapped(wrapped: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(wrapped)) {
    parts.push(`${key}: ${stringifyWrappedValue(value)}`);
  }
  return `{ ${parts.join(', ')} }`;
}

function stringifyWrappedValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (typeof value === 'object' && '__rill_atom' in (value as object)) {
    const name = (value as { name?: string }).name;
    return name !== undefined ? `#${name}` : '<atom>';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ============================================================
// CARET UNDERLINE
// ============================================================

/**
 * Render caret underline for error span.
 *
 * Constraints:
 * - Single-char: single ^
 * - Multi-char same line: ^^^^^ (length = span width)
 * - Multi-line: ^^^^^ (continues) on first line only
 *
 * @param span - Error span
 * @param lineContent - Content of the line
 * @returns Caret underline string
 * @throws {RangeError} Invalid span (start after end)
 */
export function renderCaretUnderline(
  span: SourceSpan,
  lineContent: string
): string {
  // EC-8: Invalid span throws RangeError
  if (
    span.start.line > span.end.line ||
    (span.start.line === span.end.line && span.start.column > span.end.column)
  ) {
    throw new RangeError('Span start must precede end');
  }

  // Calculate the width of the underline. Multi-line spans underline through
  // the end of the first line; the half-open end at column 1 of a later line
  // is handled upstream (extractSnippet) by not marking that line as an
  // error line, so this path won't render carets under a blank trailing row.
  const startColumn = span.start.column;
  let endColumn: number;

  if (span.start.line === span.end.line) {
    endColumn = span.end.column;
  } else {
    endColumn = lineContent.length;
  }

  // Build underline: spaces before, carets for the span
  const padding = ' '.repeat(startColumn);
  const caretCount = Math.max(1, endColumn - startColumn);
  const carets = '^'.repeat(caretCount);

  return padding + carets;
}
