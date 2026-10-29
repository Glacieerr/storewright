import type { PlanogramEntry } from '@storewright/ops';
import { classifyIntent, type IntentModel } from './intent';
import { matchItem } from './tools';

/**
 * 模板模式的问题识别（没有本地语言模型时使用）：按中英文关键词判断该调用哪个工具，并从问题里取出参数
 * （商品、岗位、人数、时间段、订单变化幅度）。规则写得宽一些，同一个意思的不同说法都能识别；
 * 识别准确率用 eval.ts 里的问答评测集衡量。
 */

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

const NUM: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, one: 1, two: 2, three: 3, four: 4, five: 5, a: 1, an: 1, another: 1 };

function roleIn(q: string): 'pick' | 'stage' | 'handoff' | undefined {
  if (/(交付|取货区|车边|handoff|hand-off|curbside)/i.test(q)) return 'handoff';
  if (/(暂存|staging|stager|stage)/i.test(q)) return 'stage';
  if (/(拣货|拣选|picker|picking|\bpick\b)/i.test(q)) return 'pick';
  return undefined;
}

function staffRoleIn(q: string): string | undefined {
  const r = roleIn(q);
  if (r) return r.toUpperCase();
  if (/(补货|restock)/i.test(q)) return 'RESTOCK';
  if (/(后仓|backroom)/i.test(q)) return 'BACKROOM';
  return undefined;
}

function deltaIn(q: string): number | undefined {
  const plus = /(多|加|增加|再来|add|one more|another|extra|\+)\s*(\d+|[一两二三四五]|one|two|three|four|five|an?|another)?\s*(个|名|位|people|person)?/i.exec(q);
  const minus = /(少|减|减少|撤|remove|take away|fewer|one less|less|-)\s*(\d+|[一两二三四五]|one|two|three)?\s*(个|名|位)?/i.exec(q);
  const n = (m: RegExpExecArray | null) => (m?.[2] ? (Number(m[2]) || NUM[m[2].toLowerCase()] || 1) : 1);
  if (plus && !/(订单|需求|orders?|demand)/i.test(q.slice(Math.max(0, plus.index - 6), plus.index + 6))) return n(plus);
  if (minus && !/(订单|需求|orders?|demand)/i.test(q.slice(Math.max(0, minus.index - 6), minus.index + 6))) return -n(minus);
  return undefined;
}

const PM_WORDS = /^(中午|下午|傍晚|晚上|晚)$/;
const HOUR = String.raw`(上午|早上|早晨|中午|下午|傍晚|晚上|晚)?\s*(\d{1,2})\s*(?:点|时|:00)?\s*(a\.?m\.?|p\.?m\.?)?(?![a-z])`;
const RANGE = new RegExp(`${HOUR}\\s*(?:到|至|-|–|~|to|until)\\s*${HOUR}`, 'i');
const AT = new RegExp(String.raw`(上午|早上|早晨|中午|下午|傍晚|晚上|晚)?\s*(\d{1,2})\s*(?:点|时)\s*(a\.?m\.?|p\.?m\.?)?(?![a-z])|\bat\s*(\d{1,2})(?::00)?\s*(a\.?m\.?|p\.?m\.?)?(?![a-z])|\bfrom\s*(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)?(?![a-z])`, 'i');
const isPm = (word?: string, suffix?: string) => (word ? PM_WORDS.test(word) : false) || /^p/i.test(suffix ?? '');
const hasMark = (word?: string, suffix?: string) => !!word || !!suffix;
const to24 = (h: number, pm: boolean) => (pm && h < 12 ? h + 12 : h);

/**
 * 时段：「下午 3 点到 6 点」「3 to 6 pm」→ 15–18（全流程走查发现：原来忽略了「下午」，推演跑在凌晨 3–6 点）。
 * 第二个时间没有写上午下午时沿用第一个；第一个没写而第二个是下午时，在不超过第二个的前提下也按下午算。
 */
function hoursIn(q: string): { fromHour?: number; toHour?: number } {
  const range = RANGE.exec(q);
  if (range) {
    const [, w1, h1, s1, w2, h2, s2] = range;
    const a = Number(h1);
    const b = Number(h2);
    const pm1 = isPm(w1, s1);
    const pm2 = hasMark(w2, s2) ? isPm(w2, s2) : pm1;
    const to = to24(b, pm2);
    const from = !hasMark(w1, s1) && pm2 && to24(a, true) <= to ? to24(a, true) : to24(a, pm1);
    return { fromHour: from, toHour: to };
  }
  const at = AT.exec(q);
  if (at) {
    const h = at[2] !== undefined ? to24(Number(at[2]), isPm(at[1], at[3])) : at[4] !== undefined ? to24(Number(at[4]), isPm(undefined, at[5])) : to24(Number(at[6]), isPm(undefined, at[7]));
    return { fromHour: h, toHour: Math.min(24, h + 3) };
  }
  return {};
}

function demandIn(q: string): number | undefined {
  const m = /(订单|需求|orders?|demand)[^\d%]{0,12}(\d{1,3})\s*%/i.exec(q) ?? /(\d{1,3})\s*%[^\d]{0,12}(more|fewer|less|多|少)?\s*(订单|orders?)?/i.exec(q);
  if (!m) return undefined;
  const n = Number(m[2] ?? m[1]);
  if (!Number.isFinite(n)) return undefined;
  const down = /(少|下降|减少|跌|down|drop|fewer|less|decrease)/i.test(q);
  return down ? 1 - n / 100 : 1 + n / 100;
}

function moduleIn(q: string): string | undefined {
  if (/(调|人员|人手|staff|move|dispatch|排班|schedule)/i.test(q)) return 'STAFFING';
  if (/(幽灵|货架|核对|shelf|phantom)/i.test(q)) return 'AVAILABILITY';
  if (/(盘点|count)/i.test(q)) return 'COUNT';
  if (/(到店|到达|eta|arriv)/i.test(q)) return 'ETA';
  if (/(预测|forecast)/i.test(q)) return 'FORECAST';
  return undefined;
}

/** 问题里的订单号（「订单 K7QD」「order K7QD」） */
function orderCodeIn(q: string): string | undefined {
  return /(?:订单|单号|order)\s*#?\s*([A-Za-z0-9]{4,8})\b/i.exec(q)?.[1]?.toUpperCase();
}

/** 问题里说的是哪天：昨天 / 今天 / 具体日期 */
function dayIn(q: string): string | undefined {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(q);
  if (m) return m[1];
  return /(昨天|yesterday)/i.test(q) ? 'yesterday' : undefined;
}

/** 问数 2.0、复盘、周报（决策记录 0024 · F2、F3、F5）：返回要用的工具，不是这几类时返回 undefined */
function analysisCall(q: string, planogram: readonly PlanogramEntry[]): ToolCall | undefined {
  if (/(复盘|打烊|为什么(会)?迟到|迟到.{0,6}(原因|为什么)|closing review|end[- ]of[- ]day review|why (were|was|did).{0,30}late|what went wrong today)/i.test(q)) return { name: 'closing_review', args: dayIn(q) ? { date: dayIn(q) } : {} };
  if (/(周报|这一?周|本周|weekly|this week|week in review)/i.test(q)) return { name: 'weekly_report', args: {} };
  const code = orderCodeIn(q);
  if (code && /(经过|时间线|怎么回事|到哪|进度|状态|timeline|what happened|history|status|where is)/i.test(q)) return { name: 'order_timeline', args: { order: code } };
  if (/(每小时|按小时|各个?时段|几点.{0,4}(最忙|最多|单最多)|by hour|hourly|busiest hour|hour by hour)/i.test(q)) return { name: 'metrics_by_hour', args: dayIn(q) ? { date: dayIn(q) } : {} };
  if (/(比较|对比|和昨天比|跟昨天比|比昨天|compare|vs\.? yesterday|versus yesterday|than yesterday)/i.test(q)) return { name: 'compare_days', args: {} };
  if (/(今天卖了|卖了多少|卖出多少|库存轨迹|进出记录|sold today|how many .{0,30} sold|inventory history|history of)/i.test(q) && matchItem(q, planogram)) return { name: 'item_history', args: { query: q } };
  return undefined;
}

export function route(question: string, planogram: readonly PlanogramEntry[]): ToolCall[] {
  const q = question.trim();
  // 1. 推演
  if (/(如果|假如|要是|假设|what if|what happens if|if we|if i|suppose)/i.test(q)) {
    const role = roleIn(q);
    const delta = deltaIn(q);
    const demandFactor = demandIn(q);
    if ((role && delta) || demandFactor) return [{ name: 'whatif', args: { ...(role && delta ? { role, delta, ...hoursIn(q) } : {}), ...(demandFactor ? { demandFactor } : {}) } }];
  }
  // 2. 解释建议
  const recId = /REC-\d{6}/i.exec(q)?.[0]?.toUpperCase();
  if (recId || /(为什么|为何|原因|理由|why|explain|reason).*(建议|推荐|recommend|suggest)/i.test(q) || /(建议|推荐|recommendation|suggestion).*(为什么|原因|理由|why|reason)/i.test(q)) {
    const mod = moduleIn(q);
    return [{ name: 'explain_recommendation', args: { ...(recId ? { recId } : {}), ...(mod ? { module: mod } : {}) } }];
  }
  // 3. 等待原因
  if (/(为什么|为何|怎么|why).*(等|慢|久|排队|wait|slow|long|queue)/i.test(q) || /(等待|等候|排队|wait|queue).*(长|久|多|long|slow)/i.test(q)) return [{ name: 'wait_analysis', args: {} }];
  // 3.5 问数 2.0、复盘、周报
  const analysis = analysisCall(q, planogram);
  if (analysis) return [analysis];
  // 4. 开店简报（决策记录 0022 · F1）
  if (/(简报|班前会|早会|开门前|开店前|今天(要|需要|该)?注意|需要我决定|brief(ing)?\b|huddle|watch out for today|need to decide|before (we )?open)/i.test(q)) {
    const part = /(中午|午间|midday|noon)/i.test(q) ? 'MIDDAY' : /(傍晚|晚上|明天|evening|tomorrow)/i.test(q) ? 'EVENING' : /(早上|早会|开门前|开店前|morning|before (we )?open)/i.test(q) ? 'MORNING' : undefined;
    return [{ name: 'opening_brief', args: part ? { part } : {} }];
  }
  // 5. 交接班摘要
  if (/(交接|摘要|总结|日报|汇总|小结|handover|hand-over|summary|summarize|recap|wrap.?up)/i.test(q)) {
    const since = /(\d{1,2})\s*点(?:以来|开始|之后|后)|since\s*(\d{1,2})/i.exec(q);
    return [{ name: 'shift_summary', args: since ? { sinceHour: Number(since[1] ?? since[2]) } : {} }];
  }
  const item = matchItem(q, planogram);
  // 5. 订单预测（问的不是某个商品）
  if (!item && /(预计|预测|会来|会有多少|接下来|未来|待会|forecast|predict|expect|coming|next (few )?hours?|upcoming)/i.test(q)) return [{ name: 'forecast', args: {} }];
  // 6. 人员
  if (/(谁在|谁是|哪些人|哪几个人|人员|员工|几个人|多少人|岗位|在岗|who is|who's|who are|staff|associates|people on|roles?\b)/i.test(q)) {
    const role = staffRoleIn(q);
    return [{ name: 'staff_status', args: role ? { role } : {} }];
  }
  // 7. 商品
  if (item || /(在哪|哪里|位置|放在|还有多少|还剩|有没有货|有货吗|库存|where is|where are|where do|in stock|left on|how many .* left|location)/i.test(q)) return [{ name: 'find_item', args: { query: q } }];
  // 8. 操作规范与经验
  if (/(怎么办|怎么处理|怎么做|怎么弄|如何|规定|流程|可以吗|能不能|要不要|应该|how do|how to|how should|what should|what do i do|what now|policy|procedure|allowed|can i)/i.test(q)) return [{ name: 'knowledge', args: { query: q, explicit: true } }];
  // 9. 门店状态
  if (/(现在|目前|情况|状态|进度|多少|几位|几单|how many|status|overview|right now|currently|so far)/i.test(q)) return [{ name: 'store_status', args: {} }];
  // 10. 兜底：先查规范与经验，查不到再给门店状态（由调用方处理）
  return [{ name: 'knowledge', args: { query: q } }];
}

/**
 * 规则 + 本地意图分类器：参数明确的问题（推演的岗位与人数、建议编号）和明确问操作规范的说法（怎么办、what should I do）先用规则；
 * 其余由分类器判断工具（置信度不足 0.4 时退回规则），参数仍由规则抽取。
 */
export function routeHybrid(question: string, planogram: readonly PlanogramEntry[], model: IntentModel): ToolCall[] {
  const q = question.trim();
  const rules = route(q, planogram);
  const first = rules[0];
  if (first && (first.name === 'whatif' || (first.name === 'explain_recommendation' && first.args.recId) || (first.name === 'knowledge' && first.args.explicit) || ['closing_review', 'weekly_report', 'metrics_by_hour', 'compare_days', 'order_timeline', 'item_history'].includes(first.name))) return rules;
  const { intent, p } = classifyIntent(model, q, planogram);
  if (p < 0.4) return rules;
  switch (intent) {
    case 'whatif': {
      const role = roleIn(q);
      const delta = deltaIn(q) ?? (role ? 1 : undefined);
      const demandFactor = demandIn(q);
      if (!(role && delta) && !demandFactor) return rules;
      return [{ name: 'whatif', args: { ...(role && delta ? { role, delta, ...hoursIn(q) } : {}), ...(demandFactor ? { demandFactor } : {}) } }];
    }
    case 'explain_recommendation': {
      const mod = moduleIn(q);
      return [{ name: 'explain_recommendation', args: mod ? { module: mod } : {} }];
    }
    case 'staff_status': {
      const role = staffRoleIn(q);
      return [{ name: 'staff_status', args: role ? { role } : {} }];
    }
    case 'shift_summary': {
      const since = /(\d{1,2})\s*点(?:以来|开始|之后|后)|since\s*(\d{1,2})/i.exec(q);
      return [{ name: 'shift_summary', args: since ? { sinceHour: Number(since[1] ?? since[2]) } : {} }];
    }
    case 'find_item':
    case 'knowledge':
      return [{ name: intent, args: { query: q } }];
    default:
      return [{ name: intent, args: {} }];
  }
}
