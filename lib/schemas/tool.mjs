import { fail, isPlainObject } from './common.mjs';

export function validateToolConfigPatch(payload) {
  if (!isPlainObject(payload)) fail('request body must be an object');
  const out = {};
  if (payload.enabled !== undefined) out.enabled = Boolean(payload.enabled);
  if (payload.timeoutMs !== undefined) {
    const n = Number(payload.timeoutMs);
    if (!Number.isInteger(n) || n < 1 || n > 310_000) {
      fail('timeoutMs must be an integer between 1 and 310000');
    }
    out.timeoutMs = n;
  }
  if (payload.config !== undefined) {
    if (!isPlainObject(payload.config)) fail('config must be an object');
    out.config = { ...payload.config };
  }
  return out;
}
