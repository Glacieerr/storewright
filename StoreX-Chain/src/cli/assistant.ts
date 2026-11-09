import { Assistant } from '../assistant';
import type { Answer, AssistCtx } from '../assistant/types';
import { ROLES, type Role } from '../assistant/roles';
import { buildEvalContexts } from './assistantEval';

/**
 * 命令行问值班助手（数据是评测用的那一刻：默认区域第 86 天、有两张待处理的建议卡）：
 *   npm run assistant -- "现在有什么风险"
 *   npm run assistant -- "How many vehicles are late?" --llm      # 用大模型（先按 docs/06-llm-option.md 设好环境变量）
 *   npm run assistant -- "批准第一条" --role manager
 * 不加 --llm 时只用内置的规则和模型，不联网。
 */
const args = process.argv.slice(2);
const llm = args.includes('--llm');
const ri = args.indexOf('--role');
const role = ri >= 0 && ROLES.includes(args[ri + 1] as Role) ? (args[ri + 1] as Role) : undefined;
const question = args
  .filter((a, i) => !a.startsWith('--') && !(ri >= 0 && i === ri + 1))
  .join(' ')
  .trim();
if (!question) {
  process.stderr.write('用法：npm run assistant -- "问题" [--llm] [--role dispatcher|manager|regional|viewer]\n');
  process.exit(1);
}
const ctxs = buildEvalContexts();
const ctx: AssistCtx = { ...ctxs.card, ...(ctxs.hubs.hubs ? { hubs: ctxs.hubs.hubs } : {}), ...(role ? { role } : {}) };
const base = new Assistant().ask(question, ctx);
let answer: Answer = { ...base, engine: 'builtin' };
if (llm) {
  const { askWithLlm, createProvider, llmConfig } = await import('../assistant/llm');
  const cfg = llmConfig();
  if (cfg.mode === 'off') {
    process.stderr.write(
      '大模型模式没打开：设 STOREX_LLM=claude（再设 ANTHROPIC_API_KEY），或 STOREX_LLM=local（再设 STOREX_LLM_BASE_URL、STOREX_LLM_MODEL）。见 docs/06-llm-option.md。\n',
    );
    process.exit(1);
  }
  try {
    const provider = await createProvider(cfg);
    if (provider) answer = await askWithLlm(question, ctx, { provider, maxRounds: cfg.maxRounds, maxTokens: cfg.maxTokens, timeoutMs: cfg.timeoutMs }, base);
  } catch (err) {
    answer = { ...base, engine: 'builtin', engineNote: `大模型没建起来（${String(err)}），用内置助手回答。` };
  }
}
process.stdout.write(`引擎：${answer.engine ?? 'builtin'}${answer.engineNote ? `（${answer.engineNote}）` : ''}\n\n${answer.text}\n`);
if (answer.proposals.length)
  process.stdout.write(`\n提议（都要人确认，命令行里不执行）：\n${answer.proposals.map((p) => `- ${p.title}（${p.need ?? 'dispatcher'} 确认）`).join('\n')}\n`);
