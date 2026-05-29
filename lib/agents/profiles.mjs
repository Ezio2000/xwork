import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSqliteDocumentStore } from '../sqlite-store.mjs';
import { normalizeExpertAgentProfile, validateExpertAgentPayload } from '../schema.mjs';
import {
  disabledToolNames,
  filterToolsByEnabledNames,
  mainAgentEnabledToolNameSet,
} from '../tools/main-agent-tools.mjs';
import { builtInScenarioAgents } from './builtin-profiles.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEGACY_PATH = join(__dirname, '..', '..', 'data', 'expert-agents.json');

export const DEFAULT_EXPERT_AGENT_ID = 'general_task_agent';

export const DEFAULT_EXPERT_ALLOWED_TOOLS = [
  'web_search',
  'get_current_time',
  'calculator',
  'uuid_gen',
  'list_dir',
  'git',
  'code_outline',
  'grep',
  'glob',
  'read_file',
  'shell_command',
];

const nowIso = () => new Date().toISOString();

function builtInGeneralAgent() {
  const now = 'system';
  return {
    id: DEFAULT_EXPERT_AGENT_ID,
    title: 'General Task Agent',
    description: 'Default expert for bounded research, code inspection, verification, and multi-step task slices.',
    selectionPrompt: 'Use this general expert when no more specific expert profile clearly fits the delegated objective.',
    systemPrompt: [
      'You are a focused expert agent working for a parent assistant.',
      'You have fresh context. You cannot see the parent conversation unless it is included in this prompt.',
      'Work only on the single delegated objective. Do not broaden the task, take ownership of adjacent work, or solve unrelated parts of the parent request.',
      'Your output is pasted verbatim into the parent conversation. Every word costs the parent tokens.',
      'State assumptions or gaps only when they materially affect the result.',
    ].join('\n'),
    outputContract: [
      'Start directly with the facts. No lead-in sentence.',
      'Return 3-6 short bullets unless the answer fits in 1-2 lines.',
      'One line per bullet. No conclusion, no transition phrases, no commentary.',
    ].join('\n'),
    allowedTools: DEFAULT_EXPERT_ALLOWED_TOOLS,
    allowSubagents: false,
    maxDepth: 2,
    maxTurns: 30,
    timeoutMs: 120_000,
    maxOutputChars: 2400,
    channelId: null,
    model: '',
    enabled: true,
    builtin: true,
    createdAt: now,
    updatedAt: now,
  };
}

function builtInProfiles() {
  return [builtInGeneralAgent(), ...builtInScenarioAgents()];
}

function defaultData() {
  return { profiles: builtInProfiles() };
}

function normalizeStore(data) {
  const rawProfiles = Array.isArray(data?.profiles) ? data.profiles : [];
  const profiles = [];
  const seen = new Set();
  for (const raw of rawProfiles) {
    try {
      const profile = normalizeExpertAgentProfile(raw);
      if (seen.has(profile.id)) continue;
      seen.add(profile.id);
      profiles.push(profile);
    } catch {}
  }
  return { profiles };
}

function serializeStore(data) {
  return { profiles: Array.isArray(data?.profiles) ? data.profiles : [] };
}

const profilesStore = createSqliteDocumentStore({
  key: 'expert-agents',
  legacyFilePath: LEGACY_PATH,
  defaultValue: defaultData(),
  normalize: normalizeStore,
  serialize: serializeStore,
});

function publicProfile(profile, enabledToolNames = null) {
  const allowedTools = enabledToolNames
    ? filterToolsByEnabledNames(profile.allowedTools, enabledToolNames)
    : profile.allowedTools;
  return {
    ...profile,
    allowedTools,
    builtin: profile.builtin === true,
    isDefault: profile.id === DEFAULT_EXPERT_AGENT_ID,
  };
}

function enabledToolError(toolNames, enabledToolNames) {
  if (!Array.isArray(toolNames)) return null;
  const disabled = disabledToolNames(toolNames, enabledToolNames);
  if (!disabled.length) return null;
  return {
    error: `Expert agent allowedTools must be enabled for the main agent: ${disabled.join(', ')}`,
    status: 400,
  };
}

function profileChanged(current, next) {
  return JSON.stringify(normalizeExpertAgentProfile(current)) !== JSON.stringify(normalizeExpertAgentProfile(next));
}

function mergeBuiltIns(profiles = []) {
  const builtIns = builtInProfiles();
  const byId = new Map(profiles.map(profile => [profile.id, profile]));
  let changed = false;

  for (const builtIn of builtIns) {
    const current = byId.get(builtIn.id);
    if (!current) {
      if (builtIn.id === DEFAULT_EXPERT_AGENT_ID) profiles.unshift(builtIn);
      else profiles.push(builtIn);
      byId.set(builtIn.id, builtIn);
      changed = true;
      continue;
    }
    if (current.builtin === true && current.updatedAt === 'system' && profileChanged(current, builtIn)) {
      Object.assign(current, builtIn);
      changed = true;
      continue;
    }
    if (!current.builtin) {
      current.builtin = true;
      changed = true;
    }
    if (current.id === DEFAULT_EXPERT_AGENT_ID && current.enabled === false) {
      current.enabled = true;
      changed = true;
    }
    if (current.id === DEFAULT_EXPERT_AGENT_ID && (current.maxTurns === undefined || current.maxTurns === 3)) {
      current.maxTurns = builtIn.maxTurns;
      changed = true;
    }
  }
  return { profiles, changed };
}

async function readProfiles() {
  const data = await profilesStore.read();
  const { profiles, changed } = mergeBuiltIns(Array.isArray(data.profiles) ? data.profiles : []);
  if (changed) await profilesStore.write({ profiles });
  return profiles;
}

function createId() {
  return `agent_${randomUUID().slice(0, 8)}`;
}

function sortProfiles(profiles) {
  return [...profiles].sort((a, b) => {
    if (a.id === DEFAULT_EXPERT_AGENT_ID) return -1;
    if (b.id === DEFAULT_EXPERT_AGENT_ID) return 1;
    return String(a.title || a.id).localeCompare(String(b.title || b.id));
  });
}

export async function listExpertAgents({ enabledOnly = false } = {}) {
  const profiles = await readProfiles();
  const enabledToolNames = await mainAgentEnabledToolNameSet();
  return sortProfiles(profiles)
    .filter(profile => !enabledOnly || profile.enabled !== false)
    .map(profile => publicProfile(profile, enabledToolNames));
}

export async function listEnabledExpertAgentsForPrompt() {
  const profiles = await listExpertAgents({ enabledOnly: true });
  return profiles.map(profile => ({
    id: profile.id,
    title: profile.title,
    description: profile.description || '',
    selectionPrompt: profile.selectionPrompt || '',
    allowedTools: profile.allowedTools || [],
    allowSubagents: profile.allowSubagents === true,
    model: profile.model || '',
    channelId: profile.channelId || null,
  }));
}

export async function getExpertAgent(id) {
  const profiles = await readProfiles();
  const profile = profiles.find(item => item.id === id);
  if (!profile) return null;
  return publicProfile(profile, await mainAgentEnabledToolNameSet());
}

export async function resolveExpertAgentForRun(id) {
  const requestedId = typeof id === 'string' && id.trim() ? id.trim() : DEFAULT_EXPERT_AGENT_ID;
  const profiles = await readProfiles();
  const enabledToolNames = await mainAgentEnabledToolNameSet();
  const requested = profiles.find(profile => profile.id === requestedId);
  const fallback = profiles.find(profile => profile.id === DEFAULT_EXPERT_AGENT_ID) || builtInGeneralAgent();
  if (!requested) {
    return {
      profile: publicProfile(fallback, enabledToolNames),
      requestedId,
      fallbackReason: requestedId === DEFAULT_EXPERT_AGENT_ID ? '' : 'expert agent not found',
    };
  }
  if (requested.enabled === false && requested.id !== DEFAULT_EXPERT_AGENT_ID) {
    return {
      profile: publicProfile(fallback, enabledToolNames),
      requestedId,
      fallbackReason: 'expert agent disabled',
    };
  }
  return { profile: publicProfile(requested, enabledToolNames), requestedId, fallbackReason: '' };
}

export async function createExpertAgent(payload) {
  const safePayload = validateExpertAgentPayload(payload || {});
  const enabledToolNames = await mainAgentEnabledToolNameSet();
  const toolError = enabledToolError(safePayload.allowedTools, enabledToolNames);
  if (toolError) return toolError;
  const id = safePayload.id || createId();
  return profilesStore.update(data => {
    const profiles = Array.isArray(data.profiles) ? data.profiles : [];
    if (profiles.some(profile => profile.id === id)) return { error: 'Expert agent already exists', status: 409 };
    const timestamp = nowIso();
    const profile = normalizeExpertAgentProfile({
      ...safePayload,
      id,
      builtin: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    profiles.push(profile);
    return publicProfile(profile, enabledToolNames);
  });
}

export async function updateExpertAgent(id, payload) {
  const safeId = typeof id === 'string' ? id : '';
  const patch = validateExpertAgentPayload(payload || {}, { partial: true });
  const enabledToolNames = await mainAgentEnabledToolNameSet();
  const toolError = enabledToolError(patch.allowedTools, enabledToolNames);
  if (toolError) return toolError;
  return profilesStore.update(data => {
    const profiles = Array.isArray(data.profiles) ? data.profiles : [];
    const index = profiles.findIndex(profile => profile.id === safeId);
    if (index === -1) return { error: 'Expert agent not found', status: 404 };
    const current = profiles[index];
    const next = normalizeExpertAgentProfile({
      ...current,
      ...patch,
      id: current.id,
      builtin: current.builtin === true || current.id === DEFAULT_EXPERT_AGENT_ID,
      enabled: current.id === DEFAULT_EXPERT_AGENT_ID ? true : (patch.enabled ?? current.enabled),
      createdAt: current.createdAt,
      updatedAt: nowIso(),
    });
    profiles[index] = next;
    return publicProfile(next, enabledToolNames);
  });
}

export async function deleteExpertAgent(id) {
  const safeId = typeof id === 'string' ? id : '';
  return profilesStore.update(data => {
    const profiles = Array.isArray(data.profiles) ? data.profiles : [];
    const index = profiles.findIndex(profile => profile.id === safeId);
    if (index === -1) return { error: 'Expert agent not found', status: 404 };
    if (profiles[index].builtin || profiles[index].id === DEFAULT_EXPERT_AGENT_ID) {
      return { error: 'Built-in expert agents cannot be deleted', status: 409 };
    }
    profiles.splice(index, 1);
    return { ok: true };
  });
}

export async function resetExpertAgent(id) {
  const safeId = typeof id === 'string' ? id : '';
  const builtIn = builtInProfiles().find(profile => profile.id === safeId);
  if (!builtIn) {
    return { error: 'Only built-in expert agents can be reset', status: 409 };
  }
  const enabledToolNames = await mainAgentEnabledToolNameSet();
  return profilesStore.update(data => {
    const profiles = Array.isArray(data.profiles) ? data.profiles : [];
    const next = builtIn;
    const index = profiles.findIndex(profile => profile.id === safeId);
    if (index === -1 && safeId === DEFAULT_EXPERT_AGENT_ID) profiles.unshift(next);
    else if (index === -1) profiles.push(next);
    else profiles[index] = next;
    return publicProfile(next, enabledToolNames);
  });
}
