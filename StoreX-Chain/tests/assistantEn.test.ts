import { describe, expect, it } from 'vitest';
import { Assistant } from '../src/assistant';
import { dailyPlan } from '../src/assistant/dailyPlan';
import { BLIND_SET } from '../src/assistant/evalBlind';
import { BLIND_SET2 } from '../src/assistant/evalBlind2';
import { BLIND_SET3 } from '../src/assistant/evalBlind3';
import { BLIND_SET4 } from '../src/assistant/evalBlind4';
import { EVAL_SET } from '../src/assistant/evalSet';
import { handover, SHIFTS } from '../src/assistant/handover';
import type { Answer, AssistCtx } from '../src/assistant/types';
import { buildEvalContexts } from '../src/cli/assistantEval';
import { answerView, fromEnglish, quotedOut, txLine, txMarkdown, viewLines } from '../web/src/assistantText';
import { lookup, tx } from '../web/src/i18n';
import { EN } from '../web/src/i18n/en';

/**
 * 值班助手在英文界面上的覆盖率：176 道标准问题和 320 道盲测题，在评测用的数据上（和 npm run assistant:eval 同一份）交给内置助手作答，
 * 按面板显示时的方式（web/src/assistantText.ts 的 answerView）用英文词典逐行翻译，统计「整行没有中文」的行数比例。
 * 中文界面下同一套显示函数原样返回（一个字都不变）。
 *
 * English coverage of the built-in duty assistant: every displayed line of the answers to the 496 evaluation
 * questions, translated the way the panel does it, must be fully English for at least 99.8% of the lines.
 *
 * 计数规则：英文双引号里的中文是用户自己打的字（比如错别字提示「(read "冷连" as "Cold chain")」里的原词），这样的行算英文；
 * 引号外还有中文的行不算。Rule: a line whose only Chinese is quoted user input (inside "…") counts as English.
 */
const HAN = /\p{Script=Han}/u;
/** 引号外没有中文 */
const english = (s: string) => !HAN.test(quotedOut(s));
const en = (s: string) => lookup(EN, s) ?? s;
const same = (s: string) => s;

function answers(): { a: Answer; ctx: AssistCtx }[] {
  const ctxs = buildEvalContexts();
  const out: { a: Answer; ctx: AssistCtx }[] = [];
  for (const item of EVAL_SET) {
    const base = ctxs[item.scenario ?? 'card'];
    const ctx: AssistCtx = item.role ? { ...base, role: item.role } : base;
    const bot = new Assistant();
    let a: Answer | undefined;
    for (const q of Array.isArray(item.q) ? item.q : [item.q]) a = bot.ask(q as string, ctx);
    out.push({ a: a as Answer, ctx });
  }
  const blind: AssistCtx = { ...ctxs.card, ...(ctxs.hubs.hubs ? { hubs: ctxs.hubs.hubs } : {}) };
  for (const set of [BLIND_SET, BLIND_SET2, BLIND_SET3, BLIND_SET4]) {
    const bots = new Map<string, Assistant>();
    for (const item of set) {
      const ctx: AssistCtx = { ...blind, role: item.role ?? 'dispatcher' };
      const bot = item.pair ? (bots.get(item.pair) ?? (bots.set(item.pair, new Assistant()).get(item.pair) as Assistant)) : new Assistant();
      out.push({ a: bot.ask(item.q, ctx), ctx });
    }
  }
  return out;
}

describe('duty assistant in English', () => {
  const list = answers();
  const titleOf = (ctx: AssistCtx) => (key: string) => ctx.twin?.recs.find((r) => r.key === key)?.title;

  it('answers all 496 questions', () => {
    expect(list.length).toBe(EVAL_SET.length + BLIND_SET.length + BLIND_SET2.length + BLIND_SET3.length + BLIND_SET4.length);
    expect(list.length).toBe(496);
  });

  it('translates at least 99.8% of the displayed lines completely (whole line without Chinese outside quoted user input)', () => {
    let total = 0;
    let ok = 0;
    let full = 0;
    const left = new Map<string, number>();
    const t0 = performance.now();
    for (const { a, ctx } of list) {
      const lines = viewLines(answerView(a, en, titleOf(ctx)));
      const bad = lines.filter((s) => !english(s));
      total += lines.length;
      ok += lines.length - bad.length;
      if (!bad.length) full++;
      for (const s of bad) left.set(s, (left.get(s) ?? 0) + 1);
    }
    const ms = performance.now() - t0;
    // 剩下的都列出来（资料库摘录有逐句的英文，错别字提示只留用户打的原词）
    const other = [...left.keys()];
    console.log(`[assistant EN] ${ok}/${total} lines fully English (${((ok / total) * 100).toFixed(2)}%), ${full}/${list.length} answers fully English, ${ms.toFixed(0)} ms; left: ${other.length}`);
    expect(ok / total).toBeGreaterThanOrEqual(0.998);
    expect(other, other.join('\n')).toEqual([]);
  });

  it('keeps every Chinese line exactly as the assistant wrote it in Chinese mode', () => {
    for (const { a, ctx } of list) {
      for (const tr of [same, tx]) {
        const v = answerView(a, tr, titleOf(ctx));
        expect(v.conclusion).toBe(a.conclusion);
        const body = a.text.split('\n')[0]?.trim() === a.conclusion.trim() ? a.text.split('\n').slice(1).join('\n') : a.text;
        expect(v.body).toBe(body);
        expect(v.cites).toEqual(a.cites);
        expect(v.next.map((n) => n.text)).toEqual(a.next.map((n) => n.text));
        expect(v.links.map((l) => l.label)).toEqual(a.links.map((l) => l.label));
        expect(v.followups.map((f) => f.label)).toEqual(a.clarify ? [] : a.followups);
        expect(v.proposals.map((p) => [p.title, p.effect])).toEqual(a.proposals.map((p) => [p.title, p.effect]));
      }
    }
  });

  it('keeps the Chinese question behind every translated button', () => {
    const { a, ctx } = list.find((x) => x.a.followups.length && !x.a.clarify) as { a: Answer; ctx: AssistCtx };
    const v = answerView(a, en, titleOf(ctx));
    expect(v.followups.map((f) => f.ask)).toEqual(a.followups);
    expect(v.followups.every((f) => !HAN.test(f.label))).toBe(true);
  });

  it('maps the English examples of the help text back to the Chinese question', () => {
    expect(fromEnglish('What are the risks now', en)).toBe('现在有什么风险');
    expect(fromEnglish('where is m02?', en)).toBe('M02 在哪');
    expect(fromEnglish('Something else', en)).toBe('Something else');
    // 中文界面不换
    expect(fromEnglish('What are the risks now')).toBe('What are the risks now');
    expect(txLine('现在 09:00：', en)).toBe('Now 09:00:');
  });

  it('exports the daily plan and every shift handover in English (Copy / Download .md); Chinese mode unchanged', () => {
    const { ctx } = list[list.length - 1] as { ctx: AssistCtx };
    for (const md of [dailyPlan(ctx).markdown, ...SHIFTS.map((s) => handover(ctx, s).markdown)]) {
      const lines = txMarkdown(md, en)
        .split('\n')
        .filter((l) => l.trim());
      // 标题都是英文；整行没有中文的行至少 95%（现在是全部）
      expect(lines.filter((l) => l.startsWith('#')).every((l) => !HAN.test(l))).toBe(true);
      expect(lines.filter((l) => !HAN.test(l)).length / lines.length).toBeGreaterThanOrEqual(0.95);
      expect(txMarkdown(md, same)).toBe(md);
    }
  });
});
