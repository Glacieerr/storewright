import type { AiService } from '../ai';
import type { DemoStore } from '../demo';
import type { StoreRuntime } from '../runtime';
import { askLlm, type LlmConfig } from './llm';
import { trainIntent, type IntentModel } from './intent';
import { tokenize, type KnowledgeHit } from './knowledge';
import { route, routeHybrid } from './router';
import { L, TOOL_BY_NAME, TOOLS, type Lang, type ToolContext, type ToolResult } from './tools';

/**
 * 本地助手（Phase 5d）：店长和员工用一句话提问，助手调用查询工具回答，并给出数据出处。
 * - 配置了本地语言模型（LLM_URL、LLM_MODEL）时，由模型选择工具、组织语言；
 * - 没有配置、或模型超时出错时，退回模板模式：按关键词识别问题、调用工具、拼接工具写好的回答。
 * 两种模式都只用工具查到的数据。
 */

const WHERE_WORDS = /(在哪里|在哪儿|在哪|哪里|放在|摆在|位置|什么地方|还有多少|还剩|有没有货|有货吗|库存|where (is|are|do|can i find)|in stock|location|\bthe\b|[?？。，,!！])/gi;

export interface AskResult {
  answer: string;
  source: 'LLM' | 'TEMPLATE';
  tools: Array<{ name: string; args: Record<string, unknown> }>;
  citations: string[];
  ms: number;
  /** 本地模型失败、退回模板时的原因 */
  fallback?: string;
  results: ToolResult[];
}

export class Assistant {
  /** 本地意图分类器（启动时训练，几毫秒） */
  private readonly intent: IntentModel = trainIntent();

  constructor(
    private readonly rt: StoreRuntime,
    private readonly demo: DemoStore,
    private readonly ai: AiService,
    private readonly llm?: LlmConfig,
  ) {}

  status(): { llm: boolean; model?: string } {
    return this.llm ? { llm: true, model: this.llm.model } : { llm: false };
  }

  private ctx(lang: Lang, now: number): ToolContext {
    return { rt: this.rt, demo: this.demo, ai: this.ai, now, lang };
  }

  private async exec(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const t = TOOL_BY_NAME.get(name);
    if (!t) return { tool: name, args, data: { error: 'unknown tool' }, text: '', cite: '' };
    return t.run(ctx, args);
  }

  /**
   * 模板模式：识别问题 → 调用工具 → 拼接回答；规范与经验里查不到时补上门店状态。
   * router = 'rules' 只用关键词规则（评测时作对照），默认规则 + 本地意图分类器。
   */
  async template(question: string, lang: Lang, now = Date.now(), router: 'rules' | 'hybrid' = 'hybrid'): Promise<AskResult> {
    const t0 = Date.now();
    const ctx = this.ctx(lang, now);
    const results: ToolResult[] = [];
    const calls = router === 'rules' ? route(question, this.rt.statics.planogram) : routeHybrid(question, this.rt.statics.planogram, this.intent);
    for (const c of calls) results.push(await this.exec(ctx, c.name, c.args));
    if (results.length === 1 && results[0]?.tool === 'knowledge' && !((results[0].data.hits as unknown[] | undefined)?.length ?? 0)) results.push(await this.exec(ctx, 'store_status', {}));
    // 陈列表里没有的商品（例如只在周末出现的熟食），门店经验里可能记着它放在哪。
    // 去掉「放在哪」这类问法再检索，并且只认和商品名有两个字以上重合的经验，避免任何「X 在哪」都命中同一条
    if (results.length === 1 && results[0]?.tool === 'find_item' && results[0].data.found === false) {
      const name = question.replace(WHERE_WORDS, ' ').trim();
      const keys = new Set(tokenize(name).filter((t) => t.length >= 2));
      const k = await this.exec(ctx, 'knowledge', { query: name });
      const notes = ((k.data.hits ?? []) as KnowledgeHit[]).filter((h) => h.kind === 'NOTE' && tokenize(h.text).some((t) => keys.has(t)));
      if (notes.length) {
        results.splice(0, 1, { ...results[0], text: L(lang, '陈列表里没有这个商品，门店经验里有相关记录：', 'That item is not in the planogram; the store notes mention it:') }, {
          ...k,
          data: { hits: notes },
          text: notes.map((n) => n.text).join(L(lang, '；', '; ')),
          cite: notes.map((n) => L(lang, `门店经验 ${n.id}`, `store note ${n.id}`)).join(L(lang, '、', ', ')),
        });
      }
    }
    const useful = results.filter((r) => r.text);
    return {
      answer: useful.map((r) => r.text).join('\n'),
      source: 'TEMPLATE',
      tools: results.map((r) => ({ name: r.tool, args: r.args })),
      citations: useful.map((r) => r.cite).filter(Boolean),
      ms: Date.now() - t0,
      results,
    };
  }

  async ask(question: string, lang: Lang, now = Date.now()): Promise<AskResult> {
    const q = question.trim().slice(0, 500);
    if (!this.llm) return this.template(q, lang, now);
    const t0 = Date.now();
    const ctx = this.ctx(lang, now);
    try {
      const r = await askLlm(this.llm, q, lang, TOOLS, (name, args) => this.exec(ctx, name, args));
      return { answer: r.text, source: 'LLM', tools: r.results.map((x) => ({ name: x.tool, args: x.args })), citations: r.results.map((x) => x.cite).filter(Boolean), ms: Date.now() - t0, results: r.results };
    } catch (e) {
      const res = await this.template(q, lang, now);
      return { ...res, fallback: String((e as Error).message ?? e).slice(0, 120) };
    }
  }
}

export type { LlmConfig };
