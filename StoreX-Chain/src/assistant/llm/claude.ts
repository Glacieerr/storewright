import Anthropic from '@anthropic-ai/sdk';
import { LlmError, type LlmCall, type LlmProvider, type LlmSession, type LlmSessionOpts, type LlmTurn } from './types';

/**
 * 云端提供方：Anthropic 的官方 SDK（@anthropic-ai/sdk），只在服务端、命令行用，不进网页的包。
 * 凭据从环境读（ANTHROPIC_API_KEY，或 SDK 认的其他凭据），代码里不写密钥。默认模型 claude-opus-5-5，可以用 STOREX_LLM_MODEL 换。
 * 默认开自适应思考、effort 中等（STOREX_LLM_EFFORT 可以改，off = 都不带，给不支持的旧模型用）；
 * 带上服务端的拒答兜底（fallbacks: "default"：模型因安全原因拒答时由服务端换别的模型接着答）。
 * 每轮把模型返回的整段内容（包括思考块）原样记回会话，再接工具结果。
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'off';

export class ClaudeProvider implements LlmProvider {
  readonly name = 'claude';
  private readonly client: Anthropic;
  constructor(
    readonly model: string,
    private readonly effort: Effort = 'medium',
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic();
  }

  start(o: LlmSessionOpts): LlmSession {
    const messages: Anthropic.Beta.BetaMessageParam[] = [];
    for (const h of o.history ?? []) messages.push({ role: 'user', content: h.q }, { role: 'assistant', content: h.a });
    const tools: Anthropic.Beta.BetaTool[] = o.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
    }));
    return {
      send: async (input): Promise<LlmTurn> => {
        if (input.user !== undefined) messages.push({ role: 'user', content: input.user });
        else
          messages.push({
            role: 'user',
            content: (input.toolResults ?? []).map((r) => ({
              type: 'tool_result' as const,
              tool_use_id: r.id,
              content: r.content,
              ...(r.isError ? { is_error: true } : {}),
            })),
          });
        let res: Anthropic.Beta.BetaMessage;
        try {
          res = await this.client.beta.messages.create(
            {
              model: this.model,
              max_tokens: o.maxTokens,
              system: o.system,
              tools,
              messages,
              ...(this.effort !== 'off' ? { thinking: { type: 'adaptive' as const }, output_config: { effort: this.effort } } : {}),
              betas: ['server-side-fallback-2026-07-01'],
              fallbacks: 'default',
            },
            { signal: o.signal, timeout: o.timeoutMs, maxRetries: 1 },
          );
        } catch (err) {
          throw claudeError(err);
        }
        messages.push({ role: 'assistant', content: res.content });
        const text = res.content
          .flatMap((b) => (b.type === 'text' ? [b.text] : []))
          .join('\n')
          .trim();
        const calls: LlmCall[] = res.content.flatMap((b) =>
          b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {} }] : [],
        );
        const stop =
          res.stop_reason === 'tool_use'
            ? 'tool'
            : res.stop_reason === 'end_turn'
              ? 'end'
              : res.stop_reason === 'max_tokens'
                ? 'max_tokens'
                : res.stop_reason === 'refusal'
                  ? 'refusal'
                  : 'other';
        return { text, calls, stop, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens } };
      },
    };
  }
}

/** SDK 的错误按类型分（不按错误文字猜） */
function claudeError(err: unknown): LlmError {
  if (err instanceof Anthropic.AuthenticationError) return new LlmError('auth', 'authentication failed (ANTHROPIC_API_KEY)');
  if (err instanceof Anthropic.RateLimitError) return new LlmError('rate', 'rate limited');
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new LlmError('timeout', 'request timed out');
  if (err instanceof Anthropic.APIUserAbortError) return new LlmError('timeout', 'request aborted (time limit)');
  if (err instanceof Anthropic.APIConnectionError) return new LlmError('network', 'cannot reach the API');
  if (err instanceof Anthropic.APIError) return new LlmError('api', `API error ${err.status ?? ''}`.trim());
  return new LlmError('other', String(err));
}
