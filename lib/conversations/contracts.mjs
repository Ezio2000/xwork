/**
 * @typedef {Object} ProtocolMessage
 * @property {'system'|'user'|'assistant'|'tool'} role
 * @property {string|Array<Object>} content
 *
 * Message shape sent to, or received from, a model provider after provider
 * normalization. It should not contain UI-only render fields.
 */

/**
 * @typedef {Object} RenderBlock
 * @property {string} type
 *
 * UI projection derived from protocol messages, tool results, server-tool
 * events, and agent runs. Render blocks are cached on stored assistant messages
 * for quick display, but they are not the source of truth for model replay.
 */

/**
 * @typedef {Object} StoredMessage
 * @property {'system'|'user'|'assistant'|'tool'} role
 * @property {string|Array<Object>} content
 * @property {Array<RenderBlock>=} blocks
 * @property {Object=} trace
 *
 * Conversation message persisted by the repository. It may include render and
 * audit projections in addition to protocol content.
 */

/**
 * @typedef {Object} ConversationDocument
 * @property {string} id
 * @property {string} title
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {Array<StoredMessage>} messages
 */

/**
 * @typedef {Object} AuditTrace
 * @property {number} schemaVersion
 * @property {'assistant_turn'} kind
 * @property {string|null} rootRunId
 * @property {Array<ProtocolMessage>} messages
 * @property {Array<Object>} events
 */

export const CONVERSATION_CONTRACT_VERSION = 1;
