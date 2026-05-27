import {
  fail,
  isPlainObject,
  optionalString,
  validateOptionalSafeId,
  validateSafeId,
} from './common.mjs';

export const EXPERT_AGENT_LIMITS = Object.freeze({
  maxDepth: 4,
  maxTurns: 10,
  timeoutMs: 120_000,
  maxOutputChars: 4000,
});

const DEFAULTS = Object.freeze({
  enabled: true,
  description: '',
  selectionPrompt: '',
  outputContract: '',
  allowedTools: [],
  allowSubagents: false,
  maxDepth: 2,
  maxTurns: 3,
  timeoutMs: 90_000,
  maxOutputChars: 2000,
  channelId: null,
  model: '',
});

function optionalBoolean(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') fail(`${field} must be a boolean`);
  return value;
}

function optionalInteger(value, field, { min, max }) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    fail(`${field} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function validateToolNames(value, field) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const name = validateSafeId(item, `${field} item`);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  if (out.length > 80) fail(`${field} has too many entries`);
  return out;
}

export function normalizeExpertAgentProfile(profile = {}) {
  const id = validateSafeId(profile.id, 'id');
  const title = optionalString(profile.title, 'title', 120)?.trim();
  if (!title) fail('title must be a non-empty string');

  return {
    id,
    title,
    description: optionalString(profile.description, 'description', 1000) ?? DEFAULTS.description,
    selectionPrompt: optionalString(profile.selectionPrompt, 'selectionPrompt', 2000) ?? DEFAULTS.selectionPrompt,
    systemPrompt: optionalString(profile.systemPrompt, 'systemPrompt', 20_000) ?? '',
    outputContract: optionalString(profile.outputContract, 'outputContract', 4000) ?? DEFAULTS.outputContract,
    allowedTools: validateToolNames(profile.allowedTools, 'allowedTools') ?? DEFAULTS.allowedTools,
    allowSubagents: optionalBoolean(profile.allowSubagents, 'allowSubagents') ?? DEFAULTS.allowSubagents,
    maxDepth: optionalInteger(profile.maxDepth, 'maxDepth', { min: 1, max: EXPERT_AGENT_LIMITS.maxDepth }) ?? DEFAULTS.maxDepth,
    maxTurns: optionalInteger(profile.maxTurns, 'maxTurns', { min: 1, max: EXPERT_AGENT_LIMITS.maxTurns }) ?? DEFAULTS.maxTurns,
    timeoutMs: optionalInteger(profile.timeoutMs, 'timeoutMs', { min: 1000, max: EXPERT_AGENT_LIMITS.timeoutMs }) ?? DEFAULTS.timeoutMs,
    maxOutputChars: optionalInteger(profile.maxOutputChars, 'maxOutputChars', { min: 500, max: EXPERT_AGENT_LIMITS.maxOutputChars }) ?? DEFAULTS.maxOutputChars,
    channelId: validateOptionalSafeId(profile.channelId, 'channelId') ?? null,
    model: optionalString(profile.model, 'model', 200) ?? DEFAULTS.model,
    enabled: optionalBoolean(profile.enabled, 'enabled') ?? DEFAULTS.enabled,
    builtin: profile.builtin === true,
    createdAt: typeof profile.createdAt === 'string' ? profile.createdAt : new Date().toISOString(),
    updatedAt: typeof profile.updatedAt === 'string' ? profile.updatedAt : new Date().toISOString(),
  };
}

export function validateExpertAgentPayload(payload, { partial = false } = {}) {
  if (!isPlainObject(payload)) fail('request body must be an object');
  const out = {};

  if (payload.id !== undefined) out.id = validateSafeId(payload.id, 'id');

  if (!partial || payload.title !== undefined) {
    const title = optionalString(payload.title, 'title', 120)?.trim();
    if (!title) fail('title must be a non-empty string');
    out.title = title;
  }
  if (payload.description !== undefined) out.description = optionalString(payload.description, 'description', 1000) ?? '';
  if (payload.selectionPrompt !== undefined) out.selectionPrompt = optionalString(payload.selectionPrompt, 'selectionPrompt', 2000) ?? '';
  if (!partial || payload.systemPrompt !== undefined) {
    const systemPrompt = optionalString(payload.systemPrompt, 'systemPrompt', 20_000) ?? '';
    if (!partial && !systemPrompt.trim()) fail('systemPrompt must be a non-empty string');
    out.systemPrompt = systemPrompt;
  }
  if (payload.outputContract !== undefined) out.outputContract = optionalString(payload.outputContract, 'outputContract', 4000) ?? '';
  if (payload.allowedTools !== undefined) out.allowedTools = validateToolNames(payload.allowedTools, 'allowedTools') ?? [];
  if (payload.allowSubagents !== undefined) out.allowSubagents = optionalBoolean(payload.allowSubagents, 'allowSubagents');
  if (payload.maxDepth !== undefined) out.maxDepth = optionalInteger(payload.maxDepth, 'maxDepth', { min: 1, max: EXPERT_AGENT_LIMITS.maxDepth });
  if (payload.maxTurns !== undefined) out.maxTurns = optionalInteger(payload.maxTurns, 'maxTurns', { min: 1, max: EXPERT_AGENT_LIMITS.maxTurns });
  if (payload.timeoutMs !== undefined) out.timeoutMs = optionalInteger(payload.timeoutMs, 'timeoutMs', { min: 1000, max: EXPERT_AGENT_LIMITS.timeoutMs });
  if (payload.maxOutputChars !== undefined) {
    out.maxOutputChars = optionalInteger(payload.maxOutputChars, 'maxOutputChars', { min: 500, max: EXPERT_AGENT_LIMITS.maxOutputChars });
  }
  if (payload.channelId !== undefined) out.channelId = validateOptionalSafeId(payload.channelId, 'channelId') ?? null;
  if (payload.model !== undefined) out.model = optionalString(payload.model, 'model', 200) ?? '';
  if (payload.enabled !== undefined) out.enabled = optionalBoolean(payload.enabled, 'enabled');

  return out;
}
