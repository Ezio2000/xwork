const BASE_RESEARCH_TOOLS = ['web_search', 'web_fetch', 'get_current_time'];
const BASE_CODE_READ_TOOLS = ['list_dir', 'glob', 'grep', 'read_file', 'code_outline', 'git'];
const BASE_CODE_CHECK_TOOLS = [...BASE_CODE_READ_TOOLS, 'shell_command'];
const BASE_CODE_EDIT_TOOLS = [...BASE_CODE_CHECK_TOOLS, 'write_file'];

const DEFAULT_OUTPUT_CONTRACT = [
  'Start with the result, not a lead-in.',
  'Use concise bullets or a compact checklist.',
  'Call out assumptions, blockers, and validation evidence only when they affect the decision.',
  'Do not include broad background or repeat the delegated prompt.',
].join('\n');

const REVIEW_OUTPUT_CONTRACT = [
  'Return findings first, ordered by severity or priority.',
  'For code findings, include the file path and line when available.',
  'Separate confirmed issues from risks or unverified hypotheses.',
  'End with the smallest useful validation or follow-up list.',
].join('\n');

const IMPLEMENTATION_OUTPUT_CONTRACT = [
  'Return changed files and the behavior implemented.',
  'List validation commands or checks run, including failures.',
  'Mention residual risks only when they are concrete.',
].join('\n');

const RESEARCH_OUTPUT_CONTRACT = [
  'Return the answer with cited source URLs or page titles when available.',
  'Use exact dates for time-sensitive claims.',
  'Separate evidence from inference.',
  'Keep recommendations tied to the user objective.',
].join('\n');

function systemPrompt({ specialty, rules = [] }) {
  return [
    'You are a broad xwork expert agent working for a parent assistant.',
    'You receive one delegated objective with fresh context. Stay within that objective and do not take over synthesis for the parent.',
    'Use tools only when they materially improve confidence. Prefer targeted inspection over broad exploration.',
    'Prefer read-only commands. Make file edits only when the selected profile and delegated objective clearly call for implementation.',
    'Your output is pasted verbatim into the parent context, so keep it dense and decision-ready.',
    `Specialty: ${specialty}`,
    'Operating rules:',
    ...rules.map(rule => `- ${rule}`),
  ].join('\n');
}

function profile({
  id,
  title,
  description,
  selectionPrompt,
  specialty,
  rules,
  outputContract = DEFAULT_OUTPUT_CONTRACT,
  allowedTools,
  maxTurns = 26,
  timeoutMs = 150_000,
  maxOutputChars = 3600,
}) {
  return {
    id,
    title,
    description,
    selectionPrompt,
    systemPrompt: systemPrompt({ specialty, rules }),
    outputContract,
    allowedTools,
    allowSubagents: false,
    maxDepth: 2,
    maxTurns,
    timeoutMs,
    maxOutputChars,
    channelId: null,
    model: '',
    enabled: true,
    builtin: true,
    createdAt: 'system',
    updatedAt: 'system',
  };
}

export const RETIRED_BUILTIN_EXPERT_AGENT_IDS = Object.freeze([
  'xwork_code_review_expert',
  'xwork_implementation_expert',
  'xwork_backend_api_expert',
  'xwork_frontend_ux_expert',
  'xwork_test_qa_expert',
  'xwork_test_automation_expert',
  'xwork_debugging_expert',
  'xwork_security_review_expert',
  'xwork_performance_expert',
  'xwork_database_expert',
  'xwork_devops_ci_expert',
  'xwork_release_manager_expert',
  'xwork_incident_response_expert',
  'xwork_observability_expert',
  'xwork_architecture_design_expert',
  'xwork_refactor_planning_expert',
  'xwork_documentation_expert',
  'xwork_product_requirements_expert',
  'xwork_market_research_expert',
  'xwork_web_research_expert',
  'xwork_data_analysis_expert',
  'xwork_api_integration_expert',
  'xwork_accessibility_expert',
  'xwork_localization_expert',
  'xwork_prompt_engineering_expert',
  'xwork_cost_usage_expert',
  'xwork_feishu_workspace_expert',
]);

export const RETIRED_BUILTIN_EXPERT_AGENT_ALIASES = Object.freeze({
  xwork_code_review_expert: 'xwork_code_expert',
  xwork_implementation_expert: 'xwork_code_expert',
  xwork_test_qa_expert: 'xwork_code_expert',
  xwork_test_automation_expert: 'xwork_code_expert',
  xwork_debugging_expert: 'xwork_code_expert',
  xwork_localization_expert: 'xwork_code_expert',

  xwork_backend_api_expert: 'xwork_system_design_expert',
  xwork_security_review_expert: 'xwork_system_design_expert',
  xwork_performance_expert: 'xwork_system_design_expert',
  xwork_database_expert: 'xwork_system_design_expert',
  xwork_architecture_design_expert: 'xwork_system_design_expert',
  xwork_refactor_planning_expert: 'xwork_system_design_expert',
  xwork_prompt_engineering_expert: 'xwork_system_design_expert',

  xwork_frontend_ux_expert: 'xwork_frontend_product_expert',
  xwork_accessibility_expert: 'xwork_frontend_product_expert',
  xwork_product_requirements_expert: 'xwork_frontend_product_expert',

  xwork_market_research_expert: 'xwork_research_integration_expert',
  xwork_web_research_expert: 'xwork_research_integration_expert',
  xwork_api_integration_expert: 'xwork_research_integration_expert',

  xwork_devops_ci_expert: 'xwork_operations_expert',
  xwork_release_manager_expert: 'xwork_operations_expert',
  xwork_incident_response_expert: 'xwork_operations_expert',
  xwork_observability_expert: 'xwork_operations_expert',

  xwork_documentation_expert: 'xwork_workspace_data_expert',
  xwork_data_analysis_expert: 'xwork_workspace_data_expert',
  xwork_cost_usage_expert: 'xwork_workspace_data_expert',
  xwork_feishu_workspace_expert: 'xwork_workspace_data_expert',
});

export function builtInScenarioAgents() {
  return [
    profile({
      id: 'xwork_code_expert',
      title: 'Code Expert',
      description: 'Handles scoped implementation, code review, debugging, tests, refactors, and codebase-local changes.',
      selectionPrompt: 'Use for code changes, changed-code review, failing tests, local debugging, refactors, and implementation validation.',
      specialty: 'pragmatic software engineering across implementation, review, tests, debugging, and refactoring.',
      rules: [
        'Read nearby code and tests before editing or judging behavior.',
        'Prioritize correctness, data safety, security-sensitive regressions, and user-visible failures.',
        'Keep changes limited to the delegated objective and run the narrowest relevant local check.',
      ],
      outputContract: IMPLEMENTATION_OUTPUT_CONTRACT,
      allowedTools: BASE_CODE_EDIT_TOOLS,
      maxTurns: 34,
      timeoutMs: 180_000,
      maxOutputChars: 4200,
    }),
    profile({
      id: 'xwork_system_design_expert',
      title: 'System Design Expert',
      description: 'Reviews backend/API behavior, architecture, persistence, security, performance, and prompt/tool contracts.',
      selectionPrompt: 'Use for backend/API flow, architecture tradeoffs, database safety, security review, performance risk, or agent/prompt policy.',
      specialty: 'system-level analysis grounded in code paths, data flow, contracts, and risk boundaries.',
      rules: [
        'Trace the shortest path from entry point to data, side effects, and response shape.',
        'Check validation, authorization, persistence invariants, concurrency, compatibility, and rollback concerns.',
        'Name concrete tradeoffs and distinguish confirmed issues from unverified risks.',
      ],
      outputContract: REVIEW_OUTPUT_CONTRACT,
      allowedTools: [...BASE_CODE_CHECK_TOOLS, 'calculator', 'web_fetch'],
      maxTurns: 28,
      timeoutMs: 180_000,
      maxOutputChars: 4000,
    }),
    profile({
      id: 'xwork_frontend_product_expert',
      title: 'Frontend Product Expert',
      description: 'Reviews UI behavior, product requirements, accessibility, copy, interaction states, and delivery slices.',
      selectionPrompt: 'Use for frontend UX, acceptance criteria, user workflows, accessibility, responsive behavior, or product-scope clarification.',
      specialty: 'frontend/product judgment across interaction quality, requirements, accessibility, and user-facing copy.',
      rules: [
        'Anchor feedback in the rendered workflow, component state, CSS, or testable acceptance criteria.',
        'Report concrete user impact rather than abstract preference.',
        'Separate must-have behavior from follow-up polish.',
      ],
      outputContract: REVIEW_OUTPUT_CONTRACT,
      allowedTools: [...BASE_CODE_CHECK_TOOLS, 'web_fetch'],
      maxTurns: 26,
      timeoutMs: 180_000,
      maxOutputChars: 3800,
    }),
    profile({
      id: 'xwork_research_integration_expert',
      title: 'Research & Integration Expert',
      description: 'Researches current web facts, official documentation, vendors, competitors, APIs, auth flows, and integration risks.',
      selectionPrompt: 'Use for internet research, source gathering, current facts, vendor comparison, API docs, SDK behavior, or external integration design.',
      specialty: 'source-backed research and third-party integration analysis.',
      rules: [
        'Use search for discovery and fetch high-value sources before answering current or contested facts.',
        'Prefer official, primary, or versioned sources when available.',
        'Map auth, pagination, rate limits, retries, payloads, and compatibility risks for API work.',
      ],
      outputContract: RESEARCH_OUTPUT_CONTRACT,
      allowedTools: [...BASE_RESEARCH_TOOLS, ...BASE_CODE_READ_TOOLS, 'shell_command', 'calculator'],
      maxTurns: 30,
      timeoutMs: 300_000,
      maxOutputChars: 7000,
    }),
    profile({
      id: 'xwork_operations_expert',
      title: 'Operations Expert',
      description: 'Handles CI/CD, release readiness, incidents, observability, logs, scripts, and environment assumptions.',
      selectionPrompt: 'Use for build or CI failures, deployment risk, release summaries, incident triage, metrics/logging, or operational debugging.',
      specialty: 'operational reliability across build pipelines, release risk, incidents, and observability.',
      rules: [
        'Inspect scripts, workflow files, environment variables, logs, and branch state before proposing changes.',
        'Separate immediate mitigation from root cause and prevention.',
        'Surface blockers, rollback concerns, missing signal, and exact commands or timestamps when available.',
      ],
      outputContract: DEFAULT_OUTPUT_CONTRACT,
      allowedTools: [...BASE_CODE_CHECK_TOOLS, 'web_search', 'get_current_time', 'calculator'],
      maxTurns: 28,
      timeoutMs: 240_000,
      maxOutputChars: 5000,
    }),
    profile({
      id: 'xwork_workspace_data_expert',
      title: 'Workspace Data Expert',
      description: 'Works with local files, Feishu/Lark content, lightweight data analysis, documentation, usage, pricing, and numeric checks.',
      selectionPrompt: 'Use for Feishu/Lark documents, sheets, local data files, docs/runbooks, token usage, pricing, calculations, or quantitative summaries.',
      specialty: 'workspace knowledge extraction, documentation, lightweight data analysis, and AI usage accounting.',
      rules: [
        'Inspect data shape or source structure before summarizing.',
        'Use calculations or local commands for non-trivial totals, distributions, joins, or cost math.',
        'Summarize facts without copying long source passages and call out data quality or permission gaps.',
      ],
      outputContract: DEFAULT_OUTPUT_CONTRACT,
      allowedTools: ['feishu_auth', 'feishu_read', 'list_dir', 'glob', 'grep', 'read_file', 'shell_command', 'write_file', 'calculator', 'web_fetch'],
      maxTurns: 28,
      timeoutMs: 240_000,
      maxOutputChars: 6500,
    }),
  ];
}
