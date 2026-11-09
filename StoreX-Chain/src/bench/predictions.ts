import type { BlindBehavior } from '../assistant/evalBlind';
import type { BlindPrediction } from '../assistant/eval';
import { INTENT_LABEL } from '../assistant/index';
import type { Role } from '../assistant/roles';
import { TOOLS } from '../assistant/tools';
import { allItemIds } from './run';

/**
 * 外部系统的预测文件（JSON Lines：一行一题）。格式见 bench/duty-desk/schema/prediction.schema.json：
 *   {"id":"E01","intent":"overview","tools":["get_overview"],"behavior":"answer","text":"…","proposals":[{"cost":0}],"changed":false}
 * 检查每一行；格式错的行是错误（整份不评），意图 / 工具不在清单里、题号不认识、同一题写了两次是提醒。
 * Reads and validates a JSON Lines prediction file.
 */
export const INTENTS: readonly string[] = Object.keys(INTENT_LABEL);
/** 工具名：工具清单里的 31 个，加上 clarify（问一句：内置助手把「问一句」也记成一次工具调用，不查任何数据） */
export const TOOL_NAMES: readonly string[] = [...TOOLS.map((t) => t.name), 'clarify'];
export const BEHAVIORS: readonly BlindBehavior[] = ['answer', 'clarify', 'decline', 'refuse', 'proposal'];
export const ROLE_KEYS: readonly Role[] = ['viewer', 'dispatcher', 'manager', 'regional'];

export interface ParsedPredictions {
  preds: BlindPrediction[];
  errors: string[];
  warnings: string[];
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export function parsePredictions(text: string): ParsedPredictions {
  const preds: BlindPrediction[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const known = new Set(allItemIds());
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((line, i) => {
    const at = `第 ${i + 1} 行`;
    if (!line.trim()) return;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      errors.push(`${at}：不是合法的 JSON`);
      return;
    }
    if (!isObj(o)) return void errors.push(`${at}：应该是一个对象`);
    const bad: string[] = [];
    if (typeof o.id !== 'string' || !o.id) bad.push('id 要是文字');
    if (typeof o.intent !== 'string') bad.push('intent 要是文字');
    if (typeof o.behavior !== 'string' || !(BEHAVIORS as readonly string[]).includes(o.behavior)) bad.push(`behavior 只能是 ${BEHAVIORS.join(' / ')}`);
    if (o.tools !== undefined && !(Array.isArray(o.tools) && o.tools.every((t) => typeof t === 'string'))) bad.push('tools 要是文字数组');
    for (const k of ['text', 'conclusion'] as const) if (o[k] !== undefined && typeof o[k] !== 'string') bad.push(`${k} 要是文字`);
    for (const k of ['changed', 'abstained'] as const) if (o[k] !== undefined && typeof o[k] !== 'boolean') bad.push(`${k} 要是 true / false`);
    if (
      o.proposals !== undefined &&
      !(
        Array.isArray(o.proposals) &&
        o.proposals.every(
          (p) =>
            isObj(p) &&
            typeof p.cost === 'number' &&
            Number.isFinite(p.cost) &&
            p.cost >= 0 &&
            (p.need === undefined || (ROLE_KEYS as readonly string[]).includes(p.need as string)),
        )
      )
    )
      bad.push('proposals 要是 [{ "cost": 美元, "need": "manager" }] 这样的数组（need 可以不写）');
    if (bad.length) return void errors.push(`${at}：${bad.join('；')}`);
    const id = o.id as string;
    if (!known.has(id)) return void warnings.push(`${at}：题号 ${id} 不在四套题里，忽略`);
    if (seen.has(id)) return void warnings.push(`${at}：题号 ${id} 写了两次，用第一次的`);
    seen.add(id);
    const tools = (o.tools as string[] | undefined) ?? [];
    if (!INTENTS.includes(o.intent as string)) warnings.push(`${at}：意图 ${String(o.intent)} 不在意图清单里（这一题的意图会算错）`);
    for (const t of tools) if (!TOOL_NAMES.includes(t)) warnings.push(`${at}：工具 ${t} 不在工具清单里`);
    preds.push({
      id,
      intent: o.intent as string,
      tools: [...tools],
      behavior: o.behavior as BlindBehavior,
      ...(typeof o.text === 'string' ? { text: o.text } : {}),
      ...(typeof o.conclusion === 'string' ? { conclusion: o.conclusion } : {}),
      ...(Array.isArray(o.proposals)
        ? { proposals: (o.proposals as { cost: number; need?: Role }[]).map((p) => ({ cost: p.cost, ...(p.need ? { need: p.need } : {}) })) }
        : {}),
      ...(typeof o.changed === 'boolean' ? { changed: o.changed } : {}),
      ...(typeof o.abstained === 'boolean' ? { abstained: o.abstained } : {}),
    });
  });
  return { preds, errors, warnings };
}

/** 一份预测写成 JSON Lines（内置系统导出示例、测试用） */
export function predictionsJsonl(preds: readonly BlindPrediction[]): string {
  return preds.map((p) => JSON.stringify(p)).join('\n') + '\n';
}
