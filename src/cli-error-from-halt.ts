/**
 * Halt-view extraction from RuntimeError.
 *
 * `@rcrsr/rill@0.19.0` `execute()` rethrows escaping halts as `RuntimeError`
 * with the originating invalid `RillValue` attached as a non-enumerable
 * `haltValue` property. The full status sidecar (atom, message, provider,
 * raw payload, trace chain) lives on that value.
 */

import {
  atomName,
  getStatus,
  isInvalid,
  type RillValue,
  type RuntimeError,
  type TraceFrame,
} from '@rcrsr/rill';

export interface HaltView {
  readonly atom: string | null;
  readonly message: string;
  readonly provider: string | null;
  readonly trace: ReadonlyArray<TraceFrame>;
  readonly raw: Readonly<Record<string, RillValue>>;
}

function buildView(value: RillValue, fallbackMessage: string): HaltView {
  const status = getStatus(value);
  return {
    atom: status.code ? `#${atomName(status.code)}` : null,
    message: status.message !== '' ? status.message : fallbackMessage,
    provider: status.provider !== '' ? status.provider : null,
    trace: status.trace,
    raw: status.raw,
  };
}

/**
 * Build a halt view from a RuntimeError when the runtime has attached an
 * invalid value via `haltValue`. Returns null for plain runtime errors.
 */
export function viewFromRuntimeError(err: RuntimeError): HaltView | null {
  const halt = err.haltValue;
  if (halt === undefined) return null;
  if (!isInvalid(halt)) return null;
  return buildView(halt, err.message);
}

/**
 * Build a halt view from an invalid `RillValue` returned by a script
 * (e.g. a `guard`-recovered result). Returns null for valid values.
 */
export function viewFromInvalidValue(value: RillValue): HaltView | null {
  if (!isInvalid(value)) return null;
  return buildView(value, '');
}
