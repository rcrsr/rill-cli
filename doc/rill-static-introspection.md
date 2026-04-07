# Static Handler Introspection for @rcrsr/rill

Request from rill-cli to @rcrsr/rill.

## Problem

`rill-build` needs handler parameter metadata (names, types, defaults, descriptions) at build time to generate the `describe()` export in `handler.js`. The `introspectHandler()` function in `@rcrsr/rill-config` requires a live `ScriptCallable` closure, which means `rill-build` must execute the script during compilation.

Executing user scripts at build time causes 3 problems:

1. **Side effects**: scripts that call extensions, write files, or make network requests run during build
2. **Hangs**: infinite loops or blocking I/O in scripts stall the build process
3. **Missing dependencies**: extensions are not loaded during build-time introspection, so scripts that depend on extension-provided values fail

`rill-build` currently wraps execution in try/catch and falls back to `describe() → null`. This works but degrades the output.

## Proposed Solution

Add a static introspection function to `@rcrsr/rill` that extracts handler parameter metadata from a parsed AST without executing the script.

### API

```typescript
import { parse } from '@rcrsr/rill';
import { introspectHandlerFromAST } from '@rcrsr/rill';

const ast = parse(source);
const metadata = introspectHandlerFromAST(ast, 'run');
```

### Function Signature

```typescript
interface HandlerParamStatic {
  readonly name: string;
  readonly type: string;          // from type annotation, or 'any' if absent
  readonly required: boolean;     // true when no default value expression
  readonly description?: string;  // from annotation comment
  readonly defaultValue?: unknown; // evaluated from literal expressions only
}

interface HandlerMetadataStatic {
  readonly description?: string;  // from annotation comment on the closure
  readonly params: ReadonlyArray<HandlerParamStatic>;
}

function introspectHandlerFromAST(
  ast: ASTNode,
  handlerName: string
): HandlerMetadataStatic | null;
```

Returns `null` when the handler assignment cannot be found in the AST.

### Extraction Rules

1. Find the assignment `=> $handlerName` or `$handlerName =` in the top-level AST
2. Locate the closure expression on the right side of the assignment
3. Extract parameter metadata from the closure's parameter list nodes:
   - `name`: from parameter identifier
   - `type`: from type annotation (e.g., `greeting: string`), default `'any'`
   - `required`: `true` when no default value expression exists
   - `description`: from `@desc` annotation comment preceding the parameter (if the language supports this)
   - `defaultValue`: evaluate literal expressions only (`"hello"`, `42`, `true`, `list[]`, `dict[]`). For non-literal defaults (function calls, variable references), set to `undefined` and mark `required: false`
4. Extract closure-level description from annotation comment preceding the closure assignment

### What This Does NOT Do

- Execute any code
- Resolve variable references
- Evaluate complex expressions
- Load extensions or modules
- Require a runtime context

### Example

Source:

```rill
|greeting: string, name: string, loud: bool| {
  $result = $greeting + " " + $name
  if $loud { $result.upper } else { $result }
} => $run
```

`introspectHandlerFromAST(ast, 'run')` returns:

```json
{
  "params": [
    { "name": "greeting", "type": "string", "required": true },
    { "name": "name", "type": "string", "required": true },
    { "name": "loud", "type": "bool", "required": true }
  ]
}
```

## Consumer

`rill-build` in `@rcrsr/rill-cli` replaces the current execution-based introspection:

```typescript
// Current (executes script)
const introCtx = createRuntimeContext({ parseSource: parse });
await rillExecute(introAst, introCtx);
const closure = introCtx.variables.get(handlerName);
const intro = introspectHandler(closure);

// Proposed (static, no execution)
const introAst = parse(source);
const intro = introspectHandlerFromAST(introAst, handlerName);
```

## Compatibility

The output type `HandlerMetadataStatic` matches the existing `HandlerIntrospection` shape from `@rcrsr/rill-config`. `rill-build` can use either source transparently.

`introspectHandler()` in `@rcrsr/rill-config` remains unchanged for runtime use in `rill-run`.
