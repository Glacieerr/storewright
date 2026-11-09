import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BLIND2_ACCEPT, BLIND3_ACCEPT, BLIND4_ACCEPT, runBlind, runBlindAsync, type BlindAccept, type BlindReport, type EvalCtxs } from '../assistant/eval';
import { BLIND_SET, type BlindItem } from '../assistant/evalBlind';
import { BLIND_SET2 } from '../assistant/evalBlind2';
import { BLIND_SET3 } from '../assistant/evalBlind3';
import { BLIND_SET4 } from '../assistant/evalBlind4';
import { askWithLlm, createProvider, llmConfig } from '../assistant/llm';

/**
 * 可选：把四套盲测题交给设好的大模型答一遍（npm run assistant:eval -- --llm；--dry-run 只打印要问多少题、估计调用多少次）。
 * 只在用户明确加 --llm 时跑，测试和持续集成里不跑；要联网、按调用计费。结果写到 docs/results/assistant-eval-llm.md（和内置的报告分开）。
 * 这四套题都已经看过（第一到第三套不再是盲测，第四套首次运行在内置模式），所以这里的数只是内置和大模型两种模式的对照，不是新的盲测成绩。
 */
export async function runLlmEval(ctxs: EvalCtxs, dryRun: boolean): Promise<void> {
  const cfg = llmConfig();
  const sets: [string, readonly BlindItem[], Record<string, BlindAccept>][] = [
    ['第一套', BLIND_SET, {}],
    ['第二套', BLIND_SET2, BLIND2_ACCEPT],
    ['第三套', BLIND_SET3, BLIND3_ACCEPT],
    ['第四套', BLIND_SET4, BLIND4_ACCEPT],
  ];
  const n = sets.reduce((s, [, set]) => s + set.length, 0);
  process.stdout.write(
    `将问 ${n} 题（四套盲测题），每题至少调用模型 1 次、每轮工具再 1 次（最多 ${cfg.maxRounds} 轮）：估计 ${n * 2}–${n * (cfg.maxRounds + 1)} 次调用，一般在 ${Math.round(n * 2.5)} 次左右。模式：${cfg.mode}${cfg.mode === 'off' ? '' : ` · ${cfg.model}`}。\n`,
  );
  if (cfg.mode === 'off') {
    process.stderr.write(
      '大模型模式没打开：设 STOREX_LLM=claude（再设 ANTHROPIC_API_KEY），或 STOREX_LLM=local（再设 STOREX_LLM_BASE_URL、STOREX_LLM_MODEL）。见 docs/06-llm-option.md。\n',
    );
    process.exitCode = 1;
    return;
  }
  if (dryRun) return;
  const provider = await createProvider(cfg);
  if (!provider) return;
  const ctx = { ...ctxs.card, ...(ctxs.hubs.hubs ? { hubs: ctxs.hubs.hubs } : {}) };
  const L: string[] = ['# 值班助手评测 · 大模型模式（可选）', ''];
  L.push(
    `由 \`npm run assistant:eval -- --llm\` 生成：模式 ${cfg.mode}、模型 ${cfg.model}、最多 ${cfg.maxRounds} 轮工具、每次最多 ${cfg.maxTokens} 个输出 token。四套盲测题、评分规则和内置模式一样（见 assistant-eval.md）；这四套题都已经看过，这里只是两种模式的对照，不是新的盲测成绩。模型的回答有随机性，每次跑会有出入。`,
    '',
  );
  L.push('| 题目 | 引擎 | 意图 | 工具 | 回答形态 | 安全 | 四项都对 | 大模型答的 / 改用内置的 |', '|---|---|---|---|---|---|---|---|');
  const row = (name: string, engine: string, r: BlindReport, used?: string) =>
    L.push(
      `| ${name} | ${engine} | ${r.metrics.intent.ok} | ${r.metrics.tool.ok} | ${r.metrics.behavior.ok} | ${r.metrics.safety.ok} | ${r.metrics.all.ok} / ${r.items.length} | ${used ?? '—'} |`,
    );
  const misses: string[] = [];
  for (const [name, set, accept] of sets) {
    let byModel = 0;
    let fell = 0;
    const llm = await runBlindAsync(
      ctx,
      set,
      accept,
      (q, c, bot, history) =>
        askWithLlm(q, c, { provider, maxRounds: cfg.maxRounds, maxTokens: cfg.maxTokens, timeoutMs: cfg.timeoutMs, history }, bot.ask(q, c)),
      (k, a) => {
        if (a.engine === 'builtin') fell++;
        else byModel++;
        process.stdout.write(`\r${name} ${k}/${set.length}`);
      },
    );
    process.stdout.write('\n');
    row(name, '内置', runBlind(ctx, set, accept));
    row(name, `大模型（${cfg.mode}）`, llm, `${byModel} / ${fell}`);
    for (const x of llm.items.filter((i) => !(i.intentOk && i.toolOk && i.behaviorOk && i.safetyOk)))
      misses.push(
        `- ${name} ${x.id}「${x.q}」：期望 ${x.want.intent} / ${x.want.tools.join('、') || '不调工具'} / ${x.want.behavior}；实际 ${x.intent} / ${x.tools.join('、') || '没调工具'} / ${x.behavior}${x.safetyOk ? '' : '（不安全）'}`,
      );
  }
  L.push('', '## 大模型模式没对上的', '', ...(misses.length ? misses : ['全部对上。']), '');
  const out = fileURLToPath(new URL('../../docs/results/assistant-eval-llm.md', import.meta.url));
  mkdirSync(fileURLToPath(new URL('../../docs/results/', import.meta.url)), { recursive: true });
  writeFileSync(out, L.join('\n'));
  process.stdout.write(`写好了：docs/results/assistant-eval-llm.md\n`);
}
