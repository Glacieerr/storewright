import { LlmError, type LlmCall, type LlmProvider, type LlmSession, type LlmSessionOpts, type LlmTurn } from './types';

/**
 * 本机模型提供方：本机（或内网）跑的模型服务，接口是常见的 /v1/chat/completions（带 tools 的那种），用来离线、不出内网地用。
 * 地址从 STOREX_LLM_BASE_URL 读（写到 /v1 为止，比如 http://127.0.0.1:11434/v1），模型名 STOREX_LLM_MODEL；
 * 服务要密钥的话放在 STOREX_LLM_LOCAL_KEY。只用标准的 fetch，不依赖第三方包。它和云端提供方是两回事，不拿来接云端模型。
 */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}
interface ChatResponse {
  choices?: { message?: { content?: string | null; tool_calls?: ChatMessage['tool_calls'] }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const parseArgs = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export class LocalProvider implements LlmProvider {
  readonly name = 'local';
  constructor(
    readonly model: string,
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly key?: string,
  ) {}

  start(o: LlmSessionOpts): LlmSession {
    const messages: ChatMessage[] = [{ role: 'system', content: o.system }];
    for (const h of o.history ?? []) messages.push({ role: 'user', content: h.q }, { role: 'assistant', content: h.a });
    const tools = o.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    const url = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    return {
      send: async (input): Promise<LlmTurn> => {
        if (input.user !== undefined) messages.push({ role: 'user', content: input.user });
        for (const r of input.toolResults ?? []) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
        let res: Response;
        try {
          res = await this.fetchFn(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
            body: JSON.stringify({ model: this.model, messages, tools, max_tokens: o.maxTokens }),
            signal: o.signal,
          });
        } catch (err) {
          throw new LlmError(o.signal.aborted ? 'timeout' : 'network', `cannot reach ${url}: ${String(err)}`);
        }
        if (!res.ok)
          throw new LlmError(res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate' : 'api', `HTTP ${res.status} from ${url}`);
        let body: ChatResponse;
        try {
          body = (await res.json()) as ChatResponse;
        } catch {
          throw new LlmError('api', 'response is not JSON');
        }
        const choice = body.choices?.[0];
        const msg = choice?.message;
        if (!msg) throw new LlmError('api', 'response has no choices');
        const toolCalls = (msg.tool_calls ?? []).filter((c) => c && c.function && typeof c.function.name === 'string');
        messages.push({ role: 'assistant', content: msg.content ?? '', ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
        const calls: LlmCall[] = toolCalls.map((c, i) => ({ id: c.id || `call_${i}`, name: c.function.name, input: parseArgs(c.function.arguments) }));
        const stop = calls.length ? 'tool' : choice?.finish_reason === 'length' ? 'max_tokens' : 'end';
        return {
          text: (msg.content ?? '').trim(),
          calls,
          stop,
          ...(body.usage ? { usage: { input: body.usage.prompt_tokens ?? 0, output: body.usage.completion_tokens ?? 0 } } : {}),
        };
      },
    };
  }
}
