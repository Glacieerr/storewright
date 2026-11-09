/**
 * 可选的大模型模式：提供方的接口（src/assistant/llm/）。默认不用大模型（内置的规则 + 逻辑回归），要用户自己打开（见 docs/06-llm-option.md）。
 *
 * 一个提供方开一段会话（start），每次 send 一轮：第一轮是用户的问题，之后是上一轮要的工具的结果；
 * 提供方自己按它的格式记会话（Claude 的思考块要原样带回，本机模型的 tool_calls 也要带回），对外只给文字、要调的工具和停下的原因。
 */
export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmTurn {
  text: string;
  calls: LlmCall[];
  /** end = 说完了；tool = 要调工具；max_tokens = 输出到上限截断了；refusal = 模型拒绝；other = 别的 */
  stop: 'end' | 'tool' | 'max_tokens' | 'refusal' | 'other';
  usage?: { input: number; output: number };
}

export interface LlmSessionOpts {
  system: string;
  tools: LlmToolSpec[];
  maxTokens: number;
  signal: AbortSignal;
  timeoutMs: number;
  /** 前面几轮的问答（同一段对话里接着问：只带文字） */
  history?: { q: string; a: string }[];
}

export interface LlmSession {
  send(input: { user?: string; toolResults?: { id: string; content: string; isError?: boolean }[] }): Promise<LlmTurn>;
}

export interface LlmProvider {
  /** claude / local / mock：回答里写明是哪个引擎答的 */
  readonly name: string;
  readonly model: string;
  start(opts: LlmSessionOpts): LlmSession;
}

/** 提供方出错：种类（回答里按它说明原因，然后改用内置助手） */
export type LlmErrorKind = 'auth' | 'rate' | 'timeout' | 'network' | 'api' | 'config' | 'other';
export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    detail: string,
  ) {
    super(detail);
    this.name = 'LlmError';
  }
}
