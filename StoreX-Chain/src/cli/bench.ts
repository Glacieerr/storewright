import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askWithLlm, createProvider, llmConfig } from '../assistant/llm';
import type { Role } from '../assistant/roles';
import { callTool, exportDataset } from '../bench/export';
import { parsePredictions } from '../bench/predictions';
import { writeReports } from '../bench/report';
import { benchContext, pct, resultJson, runAsync, runOffline, scorePredictions, type SystemResult } from '../bench/run';
import { BENCH_NAME, BENCH_SETS, parseSets } from '../bench/sets';
import { OFFLINE_SYSTEMS, SYSTEMS, type OfflineSystem } from '../bench/systems';

/**
 * Duty-Desk Bench（值班台基准）的命令行：
 *   npm run bench -- list                                   # 四套题、对照系统
 *   npm run bench -- export                                 # 导出数据集到 bench/duty-desk/（题目、schema、评测时刻的数据、预测示例）
 *   npm run bench -- run --system builtin [--set all]       # 跑一个本机的对照系统（builtin、lr、nb、nearest、keyword），写 results/<system>.json
 *   npm run bench -- run --all                              # 五个本机系统都跑，再重写报告
 *   npm run bench -- run --system llm [--dry-run]           # 可选：大模型模式（要先按 docs/06-llm-option.md 设好；按调用计费）
 *   npm run bench -- score --pred my.jsonl [--name my-bot] [--set all] [--json] [--save]   # 评外部系统的预测
 *   npm run bench -- tool get_vehicle '{"id":"M03"}' [--role viewer]                       # 在评测时刻调一个工具，打印 JSON
 *   npm run bench -- report                                 # 按 results/*.json 重写 docs/benchmark*.md 的表格和静态网页
 */
const ROOT = fileURLToPath(new URL('../../bench/duty-desk/', import.meta.url));
const RESULTS = join(ROOT, 'results');
const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'list';
const flag = (k: string): string | undefined => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1] : undefined;
};
const has = (k: string) => argv.includes(`--${k}`);
const out = (s: string) => process.stdout.write(`${s}\n`);

function summary(r: SystemResult): void {
  out(`${r.label}（${r.system}）· ${BENCH_NAME} ${r.benchVersion} · ${r.software}`);
  out(`${'题目'.padEnd(6)}${'意图'.padStart(9)}${'工具'.padStart(9)}${'形态'.padStart(9)}${'安全'.padStart(9)}${'四项都对'.padStart(10)}`);
  for (const s of BENCH_SETS) {
    const x = r.sets[s.key];
    if (!x) continue;
    out(
      `${s.label.padEnd(6)}${pct(x.metrics.intent).padStart(9)}${pct(x.metrics.tool).padStart(9)}${pct(x.metrics.behavior).padStart(9)}${pct(x.metrics.safety).padStart(9)}  ${pct(x.metrics.all)}（${x.metrics.all.ok}/${x.metrics.all.n}）`,
    );
  }
  out(
    `${'合计'.padEnd(6)}${pct(r.total.intent).padStart(9)}${pct(r.total.tool).padStart(9)}${pct(r.total.behavior).padStart(9)}${pct(r.total.safety).padStart(9)}  ${pct(r.total.all)}（${r.total.all.ok}/${r.total.all.n}）`,
  );
}

function save(r: SystemResult): string {
  mkdirSync(RESULTS, { recursive: true });
  const p = join(RESULTS, `${r.system}.json`);
  writeFileSync(p, resultJson(r));
  return p;
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'list': {
      out(`${BENCH_NAME}：四套盲测题，每套 80 题`);
      for (const s of BENCH_SETS)
        out(
          `  ${s.key}（${s.label}，${s.prefix}01–${s.prefix}80）：正式成绩 ${s.official.all}/80（${s.official.version}）${s.stillBlind ? '，仍是盲测' : '，已看过'}`,
        );
      out('对照系统：');
      for (const s of SYSTEMS) out(`  ${s.key.padEnd(8)} ${s.label}`);
      out('  llm      可选：大模型模式（STOREX_LLM=claude|local，见 docs/06-llm-option.md）');
      out('  external 外部系统的预测文件（npm run bench -- score --pred …）');
      return;
    }
    case 'export': {
      const files = exportDataset(ROOT);
      out(`写好了 ${files.length} 个文件（bench/duty-desk/）：\n  ${files.join('\n  ')}`);
      return;
    }
    case 'run': {
      const sets = parseSets(flag('set'));
      if (has('all')) {
        for (const k of OFFLINE_SYSTEMS) {
          const r = runOffline(k, sets);
          summary(r);
          out(`→ ${save(r)}\n`);
        }
        out(`报告：${writeReports(ROOT).join('、')}`);
        return;
      }
      const sys = flag('system') ?? 'builtin';
      if (sys === 'llm') {
        const cfg = llmConfig();
        const n = sets.reduce((a, k) => a + (BENCH_SETS.find((s) => s.key === k)?.items.length ?? 0), 0);
        out(
          `将问 ${n} 题：每题至少调用模型 1 次、每轮工具再 1 次（最多 ${cfg.maxRounds} 轮），估计 ${n * 2}–${n * (cfg.maxRounds + 1)} 次调用。模式：${cfg.mode}，模型：${cfg.model}。按调用计费，费用请自己按提供方的价格估算。`,
        );
        if (cfg.mode === 'off') {
          process.stderr.write(
            '大模型模式没打开：设 STOREX_LLM=claude（再设 ANTHROPIC_API_KEY），或 STOREX_LLM=local（再设 STOREX_LLM_BASE_URL、STOREX_LLM_MODEL）。操作步骤见 docs/06-llm-option.md。\n',
          );
          process.exitCode = 1;
          return;
        }
        if (has('dry-run')) return;
        const provider = await createProvider(cfg);
        if (!provider) {
          process.exitCode = 1;
          return;
        }
        let byModel = 0;
        let fell = 0;
        const r = await runAsync(
          {
            system: `llm-${cfg.mode}`,
            kind: 'llm',
            label: `大模型模式（${cfg.mode}，${cfg.model}）`,
            labelEn: `LLM mode (${cfg.mode}, ${cfg.model})`,
            description: '可选的大模型模式：模型自己选工具（工具在本机执行），规则表、数字核对和「人确认才执行」不变；出错时改用内置助手。',
            descriptionEn:
              'The optional LLM mode: the model picks tools (run locally); the policy table, number grounding and human confirmation stay; on errors it falls back to the built-in assistant.',
            config: { mode: cfg.mode, model: cfg.model, maxRounds: cfg.maxRounds, maxTokens: cfg.maxTokens },
          },
          sets,
          (q, c, bot, history) =>
            askWithLlm(q, c, { provider, maxRounds: cfg.maxRounds, maxTokens: cfg.maxTokens, timeoutMs: cfg.timeoutMs, history }, bot.ask(q, c)),
          benchContext(),
          (set, k, a) => {
            if (a.engine === 'builtin') fell++;
            else byModel++;
            process.stdout.write(`\r${set} ${k}/80`);
          },
        );
        process.stdout.write('\n');
        r.config.answeredByModel = byModel;
        r.config.fellBackToBuiltin = fell;
        summary(r);
        out(`→ ${save(r)}（模型答的 ${byModel} 题，改用内置的 ${fell} 题）`);
        return;
      }
      if (!(OFFLINE_SYSTEMS as readonly string[]).includes(sys)) throw new Error(`不认识的系统：${sys}（可以写 ${OFFLINE_SYSTEMS.join('、')}、llm）`);
      const r = runOffline(sys as OfflineSystem, sets);
      summary(r);
      out(`→ ${save(r)}`);
      return;
    }
    case 'score': {
      const file = flag('pred');
      if (!file || !existsSync(file)) throw new Error('要用 --pred 指定预测文件（JSON Lines，格式见 bench/duty-desk/schema/prediction.schema.json）');
      const { preds, errors, warnings } = parsePredictions(readFileSync(file, 'utf8'));
      for (const w of warnings) process.stderr.write(`提醒：${w}\n`);
      if (errors.length) {
        for (const e of errors) process.stderr.write(`错误：${e}\n`);
        process.exitCode = 1;
        return;
      }
      const name = (flag('name') ?? 'external').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
      const r = scorePredictions(preds, parseSets(flag('set')), { system: name, label: flag('name') ?? 'external' });
      if (has('json')) out(JSON.stringify(r, null, 1));
      else {
        summary(r);
        for (const s of BENCH_SETS)
          for (const x of r.sets[s.key]?.items ?? [])
            if (!x.ok.all)
              out(
                `  × ${x.id}「${x.q}」期望 ${x.want.intent} / ${x.want.tools.join(',') || '—'} / ${x.want.behavior}；给的 ${x.got.intent} / ${x.got.tools.join(',') || '—'} / ${x.got.behavior}${x.ok.safety ? '' : '（不安全）'}${x.missing ? '（没有预测）' : ''}`,
              );
      }
      if (has('save')) process.stderr.write(`→ ${save(r)}\n`);
      return;
    }
    case 'tool': {
      const name = argv[1];
      if (!name) throw new Error("用法：npm run bench -- tool <工具名> '<JSON 参数>' [--role viewer|dispatcher|manager|regional]");
      const raw = argv[2] && !argv[2].startsWith('--') ? argv[2] : '{}';
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new Error(`参数不是合法的 JSON：${raw}`);
      }
      const role = (flag('role') ?? 'dispatcher') as Role;
      if (!['viewer', 'dispatcher', 'manager', 'regional'].includes(role)) throw new Error('--role 只能是 viewer、dispatcher、manager、regional');
      out(JSON.stringify(callTool(name, args, role), null, 2));
      return;
    }
    case 'report': {
      out(`写好了：${writeReports(ROOT).join('、')}`);
      return;
    }
    default:
      throw new Error(`不认识的子命令：${cmd}（list、export、run、score、tool、report）`);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
