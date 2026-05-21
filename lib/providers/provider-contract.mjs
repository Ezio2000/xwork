/**
 * Provider adapters convert model-specific request/stream protocols into this
 * project runtime shape. queryLoop should depend on this shape, not on one
 * vendor's SSE event names.
 *
 * @typedef {Object} ProviderTurnResult
 * @property {string} text
 * @property {string=} reasoningContent
 * @property {Array<Object>} content
 * @property {string|null} stopReason
 * @property {Object|null} usage
 * @property {Array<Object>} toolCalls
 * @property {Array<Object>} serverToolEvents
 */

export const PROVIDER_CONTRACT_VERSION = 1;
