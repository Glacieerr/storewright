import { Hub } from './hub';
import { webPlatform } from './platform';
import { memoryStorage } from './storage';
import { buildEvalSet, buildHeldOutSet, buildHeldOutSetB, runEval, type EvalReport } from './assistant/eval';

/**
 * 接上真实的本地语言模型之前和之后的对比（决策记录 0024 · H1）：在演示门店上跑门店助手的三组评测
 * （评测集、留出集 A、留出集 B），模板模式和语言模型模式各跑一遍，比较选对工具的比例、回答里含有该有的数字的比例和用时。
 *
 * 用法：先在本机启动一个 OpenAI 兼容的本地模型服务（例如 llama.cpp 或 Ollama，模型需要另外下载，约 1–3 GB），然后
 *   LLM_URL=http://127.0.0.1:11434/v1 LLM_MODEL=<模型名> npm run llm:eval
 * 不设置 LLM_URL 时只跑模板模式（用来确认评测本身正常）。门店数据不出本机。
 */

function row(name: string, r: EvalReport): string {
  return `${name.padEnd(10)} ${r.source.padEnd(9)} n=${String(r.n).padStart(3)}  tool ${(r.toolAccuracy * 100).toFixed(1).padStart(5)}%  answer ${(r.answerAccuracy * 100).toFixed(1).padStart(5)}%  ${String(Math.round(r.avgMs)).padStart(5)} ms`;
}

async function main(): Promise<void> {
  const llm = process.env.LLM_URL && process.env.LLM_MODEL ? { url: process.env.LLM_URL, model: process.env.LLM_MODEL, ...(process.env.LLM_KEY ? { apiKey: process.env.LLM_KEY } : {}), timeoutMs: 60_000 } : undefined;
  const hub = await Hub.create({ storage: memoryStorage(), platform: webPlatform, demo: true, storeIds: ['demo'], ...(llm ? { llm } : {}) });
  const e = hub.stores.get('demo');
  if (!e) throw new Error('no demo store');
  const sets: Array<[string, ReturnType<typeof buildEvalSet>]> = [
    ['eval', buildEvalSet(e.runtime, e.demo, e.ai)],
    ['held-out A', buildHeldOutSet(e.runtime)],
    ['held-out B', buildHeldOutSetB(e.runtime)],
  ];
  const lines: string[] = [];
  for (const [name, cases] of sets) {
    lines.push(row(name, await runEval(e.assistant, cases, 'TEMPLATE')));
    if (llm) lines.push(row(name, await runEval(e.assistant, cases, 'AUTO')));
  }
  console.log(llm ? `local model: ${llm.model} @ ${llm.url}` : 'LLM_URL / LLM_MODEL not set: template mode only');
  for (const l of lines) console.log(l);
  hub.stop();
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
