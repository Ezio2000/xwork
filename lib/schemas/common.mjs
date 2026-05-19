export const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const MAX_TITLE_LEN = 200;
export const MAX_MODEL_LEN = 200;
export const MAX_MESSAGE_LEN = 200_000;
export const MAX_HEADER_COUNT = 50;
export const PRICING_UNIT = 'per_1m_tokens';
export const PRICING_FIELDS = [
  'inputTokenPrice',
  'cacheReadInputTokenPrice',
  'cacheCreationInputTokenPrice',
  'outputTokenPrice',
  'webSearchRequestPrice',
  'requestPrice',
];

export class SchemaValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'SchemaValidationError';
    this.status = status;
  }
}

export function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

export function validationErrorResult(err) {
  if (err instanceof SchemaValidationError) {
    return { error: err.message, status: err.status };
  }
  throw err;
}

export function fail(message, status = 400) {
  throw new SchemaValidationError(message, status);
}

export function nonEmptyString(value, field, maxLen = 10_000) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(`${field} must be a non-empty string`);
  }
  if (value.length > maxLen) fail(`${field} is too long`);
  return value.trim();
}

export function optionalString(value, field, maxLen = 10_000) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') fail(`${field} must be a string`);
  if (value.length > maxLen) fail(`${field} is too long`);
  return value;
}

export function isSafeId(value) {
  return typeof value === 'string' && SAFE_ID_RE.test(value);
}

export function validateSafeId(value, field = 'id') {
  if (!isSafeId(value)) {
    fail(`${field} must be a safe id`);
  }
  return value;
}

export function validateOptionalSafeId(value, field = 'id') {
  if (value === undefined || value === null || value === '') return undefined;
  return validateSafeId(value, field);
}
