import type { Lang, ToolDef, ToolResult } from './tools';

/**
 * 本地语言模型（Phase 5d）：通过 OpenAI 兼容的 /chat/completions 接口调用（llama.cpp 的 server、Ollama 等都提供）。
 * 模型只负责理解问题、选择工具、组织语言；数字全部来自工具结果。最多 4 轮工具调用，超时或出错时由调用方退回模板模式。
 * 不会把门店数据发到外部：地址由门店自己配置，默认指向本机。
 */

export interface LlmConfig {
  /** 例如 http://127.0.0.1:11434/v1 */
  url: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

const SYSTEM = (lang: Lang) =>
  [
    'You are the local operations assistant of a grocery store, running on the store’s own computer.',
    'Use the tools to read live store data, procedures and staff notes. Answer only from tool results; never invent numbers, names or times.',
    'Keep answers short (at most 4 sentences) and practical for floor staff. Mention which data you used.',
    `Answer in ${lang === 'zh' ? 'Simplified Chinese' : 'English'}.`,
  ].join(' ');

export async function askLlm(cfg: LlmConfig, question: string, lang: Lang, tools: readonly ToolDef[], exec: (name: string, args: Record<string, unknown>) => Promise<ToolResult>): Promise<{ text: string; results: ToolResult[] }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM(lang) },
    { role: 'user', content: question },
  ];
  const results: ToolResult[] = [];
  const specs = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  for (let round = 0; round < 5; round++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 20_000);
    let body: { choices?: Array<{ message?: ChatMessage }> };
    try {
      const res = await fetch(`${cfg.url.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({ model: cfg.model, messages, tools: round < 4 ? specs : undefined, temperature: 0.2 }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
      body = (await res.json()) as typeof body;
    } finally {
      clearTimeout(timer);
    }
    const msg = body.choices?.[0]?.message;
    if (!msg) throw new Error('LLM returned no message');
    if (msg.tool_calls?.length) {
      messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
        } catch {
          args = {};
        }
        const r = await exec(call.function.name, args);
        results.push(r);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ text: r.text, data: r.data }) });
      }
      continue;
    }
    const text = (msg.content ?? '').trim();
    if (!text) throw new Error('LLM returned an empty answer');
    return { text, results };
  }
  throw new Error('LLM did not finish within the tool-call limit');
}
