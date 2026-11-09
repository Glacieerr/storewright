import type { Effort } from './claude';
import { LlmError, type LlmProvider } from './types';

/**
 * 大模型模式的设置（全部从环境变量读，默认关）：
 * - STOREX_LLM = off（默认）| claude | local
 * - ANTHROPIC_API_KEY：云端提供方的密钥（只在服务端、命令行读，不进网页）
 * - STOREX_LLM_MODEL：模型（claude 默认 claude-opus-5-5；local 要写本机服务里的模型名）
 * - STOREX_LLM_BASE_URL：本机模型服务的地址（到 /v1 为止）；STOREX_LLM_LOCAL_KEY：它要的密钥（可选）
 * - STOREX_LLM_MAX_TOKENS：每次回答的输出上限（claude 默认 16000，local 默认 2048）
 * - STOREX_LLM_MAX_ROUNDS：最多几轮工具调用（默认 6）；STOREX_LLM_TIMEOUT_MS：一个问题总共最多等多久（默认 90000）
 * - STOREX_LLM_EFFORT：claude 的 effort（low / medium / high / xhigh / max，默认 medium；off = 不带思考和 effort）
 */
export interface LlmConfig {
  mode: 'off' | 'claude' | 'local';
  model: string;
  baseUrl?: string;
  localKey?: string;
  maxTokens: number;
  maxRounds: number;
  timeoutMs: number;
  effort: Effort;
}

const int = (v: string | undefined, def: number, lo: number, hi: number): number => {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isInteger(n) && n >= lo && n <= hi ? n : def;
};

export function llmConfig(env: Record<string, string | undefined> = process.env): LlmConfig {
  const raw = (env.STOREX_LLM ?? 'off').trim().toLowerCase();
  const mode = raw === 'claude' || raw === 'local' ? raw : 'off';
  const effort = (['low', 'medium', 'high', 'xhigh', 'max', 'off'] as const).find((e) => e === (env.STOREX_LLM_EFFORT ?? 'medium').trim()) ?? 'medium';
  return {
    mode,
    model: env.STOREX_LLM_MODEL?.trim() || (mode === 'local' ? 'local-model' : 'claude-opus-5-5'),
    ...(env.STOREX_LLM_BASE_URL?.trim() ? { baseUrl: env.STOREX_LLM_BASE_URL.trim() } : {}),
    ...(env.STOREX_LLM_LOCAL_KEY?.trim() ? { localKey: env.STOREX_LLM_LOCAL_KEY.trim() } : {}),
    maxTokens: int(env.STOREX_LLM_MAX_TOKENS, mode === 'local' ? 2048 : 16000, 256, 128000),
    maxRounds: int(env.STOREX_LLM_MAX_ROUNDS, 6, 1, 20),
    timeoutMs: int(env.STOREX_LLM_TIMEOUT_MS, 90000, 5000, 600000),
    effort,
  };
}

/** 按设置建提供方；关着的返回 undefined。云端提供方的 SDK 只在打开时才加载 */
export async function createProvider(cfg: LlmConfig): Promise<LlmProvider | undefined> {
  if (cfg.mode === 'off') return undefined;
  if (cfg.mode === 'local') {
    if (!cfg.baseUrl) throw new LlmError('config', 'STOREX_LLM=local needs STOREX_LLM_BASE_URL (for example http://127.0.0.1:11434/v1)');
    const { LocalProvider } = await import('./local');
    return new LocalProvider(cfg.model, cfg.baseUrl, fetch, cfg.localKey);
  }
  const { ClaudeProvider } = await import('./claude');
  return new ClaudeProvider(cfg.model, cfg.effort);
}
