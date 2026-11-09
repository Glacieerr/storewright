/** 可选的大模型模式（默认关，见 docs/06-llm-option.md）：只在服务端、命令行用，不进网页的包 */
export { askWithLlm, isEnglish, SERIOUS, type AgentOpts } from './agent';
export { createProvider, llmConfig, type LlmConfig } from './config';
export { LlmError, type LlmCall, type LlmProvider, type LlmSession, type LlmSessionOpts, type LlmToolSpec, type LlmTurn } from './types';
