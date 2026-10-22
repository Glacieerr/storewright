import type { PlanogramEntry } from '@storewright/ops';
import { matchItem } from './tools';

/**
 * 本地意图分类器（Phase 5d）：一个很小的多项式朴素贝叶斯模型，判断问题属于哪类工具。
 * 训练语料由模板组合生成（不同的开头、说法、结尾），覆盖中英文的常见问法；在门店电脑上几毫秒训练完。
 * 语料与评测用的留出集严格分开：留出集里的句子不进入训练语料。
 * 特征：中文的单字与相邻两字、英文单词，以及几个占位符（问题里有商品名、数字、百分比、时间、岗位）。
 * 参数（商品、岗位、人数、时间段）仍由规则抽取；分类器只负责「该用哪个工具」。
 */

export type Intent = 'store_status' | 'find_item' | 'forecast' | 'staff_status' | 'explain_recommendation' | 'wait_analysis' | 'whatif' | 'knowledge' | 'shift_summary';

const HAN = /[一-鿿]/;

export function features(q: string, planogram?: readonly PlanogramEntry[]): string[] {
  const lower = q.toLowerCase();
  const out: string[] = [];
  for (const w of lower.match(/[a-z']+/g) ?? []) if (w.length >= 2) out.push(`w:${w}`);
  let run = '';
  const flush = () => {
    for (const c of run) out.push(`c:${c}`);
    for (let i = 0; i + 1 < run.length; i++) out.push(`b:${run.slice(i, i + 2)}`);
    run = '';
  };
  for (const c of lower) {
    if (HAN.test(c)) run += c;
    else flush();
  }
  flush();
  if (/\d+\s*%/.test(q)) out.push('<PCT>');
  else if (/\d/.test(q)) out.push('<NUM>');
  if (/(\d{1,2})\s*(点|时|:00)|\b(at|from)\s*\d{1,2}\b/i.test(q)) out.push('<HOUR>');
  if (/(拣货|暂存|交付|补货|后仓|picker|picking|handoff|staging|restock)/i.test(q)) out.push('<ROLE>');
  if (planogram && matchItem(q, planogram)) out.push('<ITEM>', '<ITEM>');
  return out;
}

/** 训练语料：每类意图的若干说法，用开头 × 主体 × 结尾组合展开 */
function corpus(): Array<[Intent, string]> {
  const out: Array<[Intent, string]> = [];
  const expand = (intent: Intent, heads: string[], bodies: string[], tails: string[] = ['']) => {
    for (const h of heads) for (const b of bodies) for (const t of tails) out.push([intent, `${h}${b}${t}`.trim()]);
  };
  const zhNow = ['', '现在', '目前', '这会儿', '眼下'];
  const enNow = ['', 'right now ', 'currently '];
  expand('store_status', zhNow, ['有几位顾客在等', '门口有多少人', '情况怎么样', '进度怎么样', '店里什么状况', '还有多少单没交付', '暂存满了吗', '有多少单', '排队的人多吗', '状态如何'], ['', '？', '呀']);
  expand('store_status', ['', 'so ', 'hey, '], ['how many customers are waiting', 'how busy are we', "what's the status", 'give me an overview', 'how are we doing', 'how many orders are left', 'is staging full', 'what does the store look like'], ['', ' right now', '?']);
  expand('find_item', ['', '请问', '帮我查一下'], ['<ITEM>在哪', '<ITEM>货架上还有多少', '后仓还有<ITEM>吗', '<ITEM>有货吗', '<ITEM>的位置', '<ITEM>缺货了吗'], ['', '？']);
  expand('find_item', ['', 'can you check '], ['where is <ITEM>', 'how many <ITEM> are on the shelf', 'is there <ITEM> in the backroom', 'do we have <ITEM>', 'location of <ITEM>', 'is <ITEM> out of stock'], ['', '?']);
  expand('forecast', ['', '你觉得', '预计'], ['接下来几个小时会来多少单', '等会儿会忙吗', '今天还会有多少订单', '高峰什么时候', '未来三小时预测', '待会订单多不多', '今晚订单量'], ['', '？']);
  expand('forecast', ['', 'do you think '], ['how many orders are coming', 'what is the forecast for the next hours', 'how many orders should we expect this afternoon', 'when is the peak', 'will tonight be busy', 'how busy will it get later', 'expected orders for the next few hours'], ['', '?']);
  expand('staff_status', zhNow, ['谁在拣货', '交付岗有哪些人', '哪些人在暂存', '谁在补货', '几个人在拣货', '人员怎么安排的', '谁在岗', '交付有几个人'], ['', '？']);
  expand('staff_status', enNow, ['who is picking', 'who is on staging', 'how many people are picking', 'who is on shift', 'who is doing restocks', 'what roles do people have', 'how many associates are on handoff'], ['', '?']);
  expand('explain_recommendation', ['', 'AI ', '系统'], ['为什么建议调人', '这条建议的理由是什么', '为什么推荐这个', '凭什么说货架上没货', '为什么要盘点这个库位', '这个预测怎么来的', '建议的原因'], ['', '？']);
  expand('explain_recommendation', ['', 'can you explain '], ['why did the ai recommend that', 'what is the reason for this suggestion', 'why this recommendation', 'why does it think the shelf is empty', 'why count this bin', 'how was this forecast made'], ['', '?']);
  expand('wait_analysis', ['', '请问'], ['为什么顾客等这么久', '排队怎么这么长', '为什么交付这么慢', '等待时间怎么变长了', '为什么门口堆了这么多人', '怎么一直排队'], ['', '？']);
  expand('wait_analysis', [''], ['why are customers waiting so long', 'why is handoff so slow', 'why did waits go up', 'why is everyone waiting at pickup', 'what is causing the long waits'], ['', '?']);
  expand('whatif', ['如果', '要是', '假如', ''], ['多一个交付员会怎样', '拣货少一个人会怎样', '订单多百分之二十会怎么样', '暂存多一个人呢', '<HOUR>到<HOUR>多派一个人', '交付减一个人会不会排长队'], ['', '？']);
  expand('whatif', ['what if ', '', 'suppose '], ['we add one more handoff associate', 'we take one picker off', 'orders go up 20%', 'we had another person on staging', 'one more person from <HOUR> to <HOUR>', 'we remove someone from handoff'], ['', '?']);
  expand('knowledge', ['', '请问', ''], ['冷冻暂存满了怎么办', '标签坏了怎么办', '验证码输错三次怎么处理', '顾客买酒要核验吗', '化学品能和食品放一起吗', '订单取消了框怎么办', '箱子破了怎么处理', '收货少了几箱怎么办', '冷链超时了怎么办', '找不到商品可以替代吗'], ['', '？']);
  expand('knowledge', ['', 'what should i do: ', 'how do i handle this: '], ['the pickup code failed three times', 'do i need to check id for alcohol', 'can chemicals go with food', 'the order was cancelled', 'a case is damaged', 'the delivery was short', 'the cold chain limit passed', 'can i substitute this item'], ['', '?']);
  expand('shift_summary', ['', '帮我', '给我'], ['做个交接班摘要', '总结一下今天', '今天到现在的汇总', '写个日报', '交接一下'], ['', '吧']);
  expand('shift_summary', ['', 'please '], ['give me a handover summary', 'recap of today', 'wrap up the shift', 'shift summary', 'what happened today'], ['', '.']);
  return out;
}

export interface IntentModel {
  classes: Intent[];
  prior: Record<string, number>;
  logp: Record<string, Map<string, number>>;
  unseen: Record<string, number>;
}

/** 训练多项式朴素贝叶斯（拉普拉斯平滑 α） */
export function trainIntent(alpha = 0.5): IntentModel {
  const rows = corpus().map(([intent, text]) => [intent, features(text.replace(/<ITEM>/g, ' ').replace(/<HOUR>/g, '16 点'))] as const);
  // <ITEM> 占位：训练语料里用特征标记代替商品名
  const withItem = corpus().map(([intent, text]) => (text.includes('<ITEM>') ? ['<ITEM>', '<ITEM>'] : []));
  const classes = [...new Set(rows.map((r) => r[0]))] as Intent[];
  const vocab = new Set<string>();
  const counts: Record<string, Map<string, number>> = {};
  const totals: Record<string, number> = {};
  const docs: Record<string, number> = {};
  rows.forEach(([c, f], i) => {
    const all = [...f, ...(withItem[i] as string[])];
    const m = (counts[c] ??= new Map());
    for (const t of all) {
      vocab.add(t);
      m.set(t, (m.get(t) ?? 0) + 1);
      totals[c] = (totals[c] ?? 0) + 1;
    }
    docs[c] = (docs[c] ?? 0) + 1;
  });
  const V = vocab.size;
  const n = rows.length;
  const prior: Record<string, number> = {};
  const logp: Record<string, Map<string, number>> = {};
  const unseen: Record<string, number> = {};
  for (const c of classes) {
    // 各类先验取均匀（语料规模不代表真实提问频率）
    prior[c] = Math.log(1 / classes.length);
    void n;
    void docs;
    const denom = (totals[c] ?? 0) + alpha * V;
    const m = new Map<string, number>();
    for (const [t, k] of counts[c] ?? new Map()) m.set(t, Math.log((k + alpha) / denom));
    logp[c] = m;
    unseen[c] = Math.log(alpha / denom);
  }
  return { classes, prior, logp, unseen };
}

export function classifyIntent(model: IntentModel, q: string, planogram?: readonly PlanogramEntry[]): { intent: Intent; p: number } {
  const f = features(q, planogram);
  const scores = model.classes.map((c) => {
    let s = model.prior[c] as number;
    const m = model.logp[c] as Map<string, number>;
    for (const t of f) s += m.get(t) ?? (model.unseen[c] as number);
    return s;
  });
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  let best = 0;
  for (let i = 1; i < scores.length; i++) if ((scores[i] as number) > (scores[best] as number)) best = i;
  return { intent: model.classes[best] as Intent, p: Math.round(((exps[best] as number) / sum) * 1000) / 1000 };
}
