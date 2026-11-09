import { SOP, SOP_EN } from '../../src/assistant/knowledge';
import type { Answer, Link, Proposal } from '../../src/assistant/types';
import { tx } from './i18n';

/**
 * 值班助手的回答在面板上的显示文字：助手（src/assistant）照旧写中文，这里在显示时逐行翻成当前语言。
 * 中文界面 tx 原样返回，这里的每个函数也原样返回（一个字都不变）；英文界面按字典（i18n/extra/assistant.ts、runtime.ts）
 * 整行翻译，整行都翻成英文以后再把全角标点换成英文标点。tests/assistantEn.test.ts 用同一套函数统计英文覆盖率。
 *
 * Display text for the duty assistant: the assistant writes Chinese, and the panel translates each line when it shows it.
 * In Chinese mode every function returns its input unchanged.
 */
export type Tr = (zh: string) => string;
const HAN = /\p{Script=Han}/u;

/** 去掉英文双引号里的部分（用户自己打的字可以留中文） */
export const quotedOut = (s: string): string => s.replace(/"[^"]*"/g, '""');

/** 整行已经是英文时：全角标点换成英文的，句首大写 */
function tidy(s: string): string {
  const out = s
    .replace(/「/g, '"')
    .replace(/」/g, '"')
    .replace(/（/g, ' (')
    .replace(/）/g, ')')
    .replace(/：/g, ': ')
    .replace(/；/g, '; ')
    .replace(/，/g, ', ')
    .replace(/、/g, ', ')
    .replace(/。/g, '. ')
    .replace(/——/g, ' – ')
    .replace(/ {2,}/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ ([,.;:)])/g, '$1')
    .trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** 翻一行：「- 」「1. 」开头和整行的 **粗体** 先拿掉，翻完放回去；翻不出来原样返回 */
export function txLine(line: string, tr: Tr = tx): string {
  if (!HAN.test(line)) return line;
  const m = /^(\s*)(- |\d+\. )?([\s\S]*?)(\s*)$/.exec(line) as RegExpExecArray;
  const [, lead = '', mark = '', core = '', tail = ''] = m;
  const bold = /^\*\*([^*]+)\*\*$/.exec(core);
  const text = bold ? (bold[1] as string) : core;
  const en = tr(text);
  // 引号里的中文是用户自己打的字（错别字提示里的原词），可以留着；别处还有中文就算没翻出来
  if (en === text || HAN.test(quotedOut(en))) return line;
  const done = tidy(en);
  return `${lead}${mark}${bold ? `**${done}**` : done}${tail}`;
}

/** 翻多行文字（回答正文、交接班报告的段落） */
export function txText(text: string, tr: Tr = tx): string {
  return HAN.test(text)
    ? text
        .split('\n')
        .map((l) => txLine(l, tr))
        .join('\n')
    : text;
}

/**
 * 翻一份 Markdown（「复制」「下载 .md」导出的今日计划、交接班报告）：「# 」「## 」标题去掉井号翻完放回，其余按行翻（同 txLine，
 * 翻不出来的行保留原文）。中文界面原样返回。Translates an exported Markdown report line by line, headings included.
 */
export function txMarkdown(md: string, tr: Tr = tx): string {
  if (!HAN.test(md)) return md;
  return md
    .split('\n')
    .map((l) => {
      const h = /^(#{1,6} )(.*)$/.exec(l);
      return h ? `${h[1]}${txLine(h[2] as string, tr)}` : txLine(l, tr);
    })
    .join('\n');
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 回答里可以点的东西的文字：建议卡的标签按整张卡的标题翻（回答里的是截短的中文） */
export function linkLabel(l: Link, tr: Tr = tx, cardTitle?: (key: string) => string | undefined): string {
  if (l.kind === 'card') {
    const full = cardTitle?.(l.key);
    const en = full ? txLine(full, tr) : undefined;
    if (full && en && en !== full) return `${txLine('看建议卡', tr)}: ${clip(en, 44)}`;
  }
  return txLine(l.label, tr);
}

/** 一条提议显示的文字 */
export function proposalView(p: Proposal, tr: Tr = tx): { title: string; effect: string; checks: { label: string; text: string }[] } {
  return {
    title: txLine(p.title, tr),
    effect: txLine(p.effect, tr),
    checks: (p.checks ?? []).filter((c) => c.level === 'warn' && !c.ok).map((c) => ({ label: txLine(c.label, tr), text: txLine(c.text, tr) })),
  };
}

/** 问句按钮：显示的文字翻译，点了以后发给助手的还是原来的中文（内置助手只懂中文） */
export interface AskChip {
  label: string;
  ask: string;
}

/** 回答显示的全部文字（面板按它排版；覆盖率测试按它统计） */
export interface AnswerView {
  conclusion: string;
  /** 正文（第一行就是结论时去掉），逐行翻好，排版前的 markdown */
  body: string;
  clarify?: { question: string; options: AskChip[] };
  proposals: ReturnType<typeof proposalView>[];
  links: { label: string; link: Link }[];
  followups: AskChip[];
  cites: string[];
  quality: string;
  level: string;
  notes: string[];
  next: { text: string; who?: string }[];
}

// —— 资料库摘录（「**标题**（出处）：片段」）：处理办法用 knowledge.ts 里逐句对应的英文，韧性预案逐句查字典；片段覆盖到哪几句就显示哪几句的英文 ——
type Hit = { title: string; source: string; text: string };
const KB_LINE = /^(- )?\*\*(.+?)\*\*（(.+?)）：(.*)$/;
const sentences = (s: string) => s.split(/(?<=。)/).filter(Boolean);
/** tr 是不是翻成英文的（中文界面的 tx、测试里的原样函数都不是） */
const translating = (tr: Tr) => tr('处理办法') !== '处理办法';
function kbLine(line: string, hits: Hit[], tr: Tr): string | undefined {
  const m = KB_LINE.exec(line);
  if (!m) return undefined;
  const [, mark = '', title = '', source = '', snip = ''] = m;
  const hit = hits.find((h) => h.title === title && h.source === source);
  if (!hit) return undefined;
  const zh = sentences(hit.text);
  const sop = SOP.find((p) => p.title === title && p.source === source);
  const known = sop ? SOP_EN[sop.id] : undefined;
  const en = known ? known.text : zh.map((s) => txLine(s, tr));
  const enTitle = known ? known.title : txLine(title, tr);
  if (en.length !== zh.length || [enTitle, ...en].some((s) => HAN.test(s))) return undefined;
  const core = snip.replace(/^…/, '').replace(/…$/, '');
  const at = hit.text.indexOf(core);
  if (at < 0) return undefined;
  let pos = 0;
  const pick: string[] = [];
  zh.forEach((s, i) => {
    if (pos + s.length > at && pos < at + core.length) pick.push(en[i] as string);
    pos += s.length;
  });
  return `${mark}**${enTitle}** (${txLine(source, tr)}): ${snip.startsWith('…') ? '…' : ''}${pick.join(' ')}${snip.endsWith('…') ? '…' : ''}`;
}
/** 回答里资料库检索的结果（search_knowledge 工具的 hits） */
const hitsOf = (a: Answer): Hit[] => (a.data ?? []).flatMap((d) => (Array.isArray((d as { hits?: unknown }).hits) ? ((d as { hits: Hit[] }).hits ?? []) : []));

export function answerView(a: Answer, tr: Tr = tx, cardTitle?: (key: string) => string | undefined): AnswerView {
  const lines = a.text.split('\n');
  const body = lines[0]?.trim() === a.conclusion.trim() ? lines.slice(1).join('\n') : a.text;
  const chip = (q: string): AskChip => ({ label: txLine(q, tr), ask: q });
  const hits = translating(tr) ? hitsOf(a) : [];
  const line = (l: string) => (hits.length ? (kbLine(l, hits, tr) ?? txLine(l, tr)) : txLine(l, tr));
  return {
    conclusion: line(a.conclusion),
    body: hits.length && HAN.test(body) ? body.split('\n').map(line).join('\n') : txText(body, tr),
    ...(a.clarify ? { clarify: { question: txLine(a.clarify.question, tr), options: a.clarify.options.map(chip) } } : {}),
    proposals: a.proposals.map((p) => proposalView(p, tr)),
    links: a.links.map((l) => ({ label: linkLabel(l, tr, cardTitle), link: l })),
    followups: a.clarify ? [] : a.followups.map(chip),
    cites: a.cites.map((c) => txLine(c, tr)),
    quality: txLine(a.basis.quality.label, tr),
    level: txLine(a.certainty.level, tr),
    notes: a.certainty.notes.map((n) => txLine(n, tr)),
    next: a.next.map((n) => ({ text: txLine(n.text, tr), ...(n.who ? { who: txLine(n.who, tr) } : {}) })),
  };
}

/** 面板上显示的每一行（覆盖率测试用）：结论、正文各行、澄清、提议、链接、追问、依据、数据质量、把握的说明、下一步 */
export function viewLines(v: AnswerView): string[] {
  const out = [v.conclusion, ...v.body.split('\n')];
  if (v.clarify) out.push(v.clarify.question, ...v.clarify.options.map((o) => o.label));
  for (const p of v.proposals) out.push(p.title, p.effect, ...p.checks.flatMap((c) => [c.label, c.text]));
  out.push(...v.links.map((l) => l.label), ...v.followups.map((f) => f.label), ...v.cites, v.quality, ...v.notes);
  for (const n of v.next) out.push(n.text, ...(n.who ? [n.who] : []));
  return out.map((s) => s.replace(/^(- |\d+\. )/, '').trim()).filter(Boolean);
}

/** 帮助和按钮里的示例问句：英文界面照着英文示例打字时换回中文原句（内置助手只懂中文） */
const EXAMPLES = [
  '现在有什么风险',
  '整体情况怎么样',
  'M02 在哪',
  '哪些车会晚',
  '乳品还剩多少',
  'D05 什么时候空',
  '港口怎么样',
  '航班到了吗',
  '下午有几趟去门店',
  '有什么待处理的建议',
  '为什么推荐第一条',
  '如果不处理会怎样',
  '批准第一条',
  '否决第一条',
  '把低风险的都批了',
  '写交接班报告',
  '今日计划',
  '复盘一下今天的建议',
  '冷链门不够用怎么办',
  'M02 为什么晚',
  '门店今天为什么晚',
  '有没有异常的指标',
  '港口物流中心怎么样',
  '本店的货在哪',
  '本店的箱在哪',
  '哪里是瓶颈',
  '机场货站预约错峰',
  '数据靠谱吗',
  '我能批多少',
  '你能帮我做什么',
  '现在整体情况怎么样',
  '现在有哪些车晚点',
  '今天的指标怎么样',
  '路上有什么事故和故障',
  '接下来两小时有什么作业',
  '各个仓储中心现在怎么样',
  '规则表和审批额度',
];
const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s?？.!。！]+$/, '')
    .replace(/\s+/g, ' ');
const reverse = new WeakMap<Tr, Map<string, string>>();
export function fromEnglish(text: string, tr: Tr = tx): string {
  if (HAN.test(text) || !/[a-z]/i.test(text)) return text;
  let map = reverse.get(tr);
  if (!map) reverse.set(tr, (map = new Map(EXAMPLES.map((q) => [norm(txLine(q, tr)), q] as const).filter(([en, q]) => en !== norm(q)))));
  return map.get(norm(text)) ?? text;
}

// —— 英文问题路由：内置助手只懂中文。英文界面上打的英文问题对不上示例原句时，按词的重合找最像的示例问句（中文），
// 问题里的编号（M02、D05、DS-BEV-1、FL1100、VS1、TR0527……）放回中文问句里；把握不够就用英文说明内置助手懂什么 ——
/** 路由用的示例：示例问句之外再加几句内置助手答得好的；后面是补充的英文说法（同义词归一以后算重合） */
const ROUTES: [string, string][] = [
  ['现在有什么风险', 'risk risks danger watch attention worry alert warning'],
  ['整体情况怎么样', 'overall status summary overview situation'],
  ['M02 在哪', 'where location position find track truck vehicle'],
  ['哪些车会晚', 'which trucks late delayed behind schedule'],
  ['乳品还剩多少', 'dairy milk stock left remaining much'],
  ['D05 什么时候空', 'door dock free available empty when'],
  ['港口怎么样', 'port harbor how'],
  ['航班到了吗', 'flight flights plane landed arrived'],
  ['机场货站怎么样', 'airport air cargo terminal how'],
  ['物流园怎么样', 'logistics park dc distribution center how'],
  ['门店收货场怎么样', 'store receiving yard parking how'],
  ['下午有几趟去门店', 'afternoon trips store how many deliveries'],
  ['有什么待处理的建议', 'pending recommendations cards suggestions open'],
  ['为什么推荐第一条', 'why recommend recommended first card'],
  ['如果不处理会怎样', 'happens nothing ignore what if'],
  ['批准第一条', 'approve accept first card'],
  ['否决第一条', 'reject decline first card'],
  ['把低风险的都批了', 'approve all low risk'],
  ['写交接班报告', 'write handover report shift'],
  ['今日计划', 'today plan daily'],
  ['复盘一下今天的建议', 'review recommendations today retrospective'],
  ['冷链门不够用怎么办', 'cold chain doors not enough short what do'],
  ['M02 为什么晚', 'why late truck vehicle reason cause'],
  ['门店今天为什么晚', 'why store late today reason'],
  ['有没有异常的指标', 'anomaly anomalies abnormal unusual metric metrics kpi'],
  ['港口物流中心怎么样', 'port logistics center hub how'],
  ['本店的货在哪', 'where our goods cargo freight'],
  ['本店的箱在哪', 'where our containers boxes'],
  ['哪里是瓶颈', 'where bottleneck congestion'],
  ['机场货站预约错峰', 'airport appointment slots smoothing reschedule'],
  ['数据靠谱吗', 'data reliable trust quality accurate'],
  ['我能批多少', 'approve how much limit can'],
  ['你能帮我做什么', 'help what can do'],
  ['现在有哪些车晚点', 'which trucks late now'],
  ['今天的指标怎么样', 'today metrics kpi indicators'],
  ['路上有什么事故和故障', 'road accidents incidents breakdowns faults'],
  ['接下来两小时有什么作业', 'next two hours upcoming jobs work schedule'],
  ['各个仓储中心现在怎么样', 'hubs warehouses facilities all how'],
  ['规则表和审批额度', 'rules policy approval limits guardrails'],
];
/** 同义词归一（左边的词都当成右边的） */
const SYN: Record<string, string> = {
  delayed: 'late', delay: 'late', delays: 'late', behind: 'late', overdue: 'late', lateness: 'late',
  trucks: 'truck', vehicle: 'truck', vehicles: 'truck', lorry: 'truck', lorries: 'truck', van: 'truck', vans: 'truck',
  risks: 'risk', danger: 'risk', dangers: 'risk', problem: 'risk', problems: 'risk', issue: 'risk', issues: 'risk', alert: 'risk', alerts: 'risk', warning: 'risk', warnings: 'risk', attention: 'risk', worry: 'risk', watch: 'risk',
  location: 'where', locate: 'where', located: 'where', position: 'where', find: 'where', track: 'where',
  doors: 'door', dock: 'door', docks: 'door',
  available: 'free', empty: 'free', vacant: 'free', idle: 'free', open: 'free',
  harbor: 'port', harbour: 'port', seaport: 'port',
  flights: 'flight', plane: 'flight', planes: 'flight', landed: 'flight', landing: 'flight', land: 'flight',
  milk: 'dairy',
  inventory: 'stock', left: 'stock', remaining: 'stock', remain: 'stock',
  recommendations: 'recommend', recommendation: 'recommend', recommended: 'recommend', suggestion: 'recommend', suggestions: 'recommend', cards: 'card', proposals: 'recommend', proposal: 'recommend',
  approval: 'approve', accept: 'approve', confirm: 'approve', ok: 'approve',
  decline: 'reject', veto: 'reject', deny: 'reject', refuse: 'reject',
  handoff: 'handover', 'hand-over': 'handover',
  schedule: 'plan', agenda: 'plan', daily: 'plan',
  retrospective: 'review', recap: 'review', debrief: 'review',
  chilled: 'cold', reefer: 'cold', refrigerated: 'cold', frozen: 'cold', 'cold-chain': 'cold',
  reason: 'why', cause: 'why', causes: 'why', because: 'why',
  anomalies: 'anomaly', abnormal: 'anomaly', unusual: 'anomaly', outlier: 'anomaly', outliers: 'anomaly',
  metrics: 'metric', kpi: 'metric', kpis: 'metric', indicator: 'metric', indicators: 'metric',
  cargo: 'goods', freight: 'goods', shipment: 'goods', shipments: 'goods', products: 'goods', items: 'goods',
  containers: 'container', boxes: 'container', box: 'container',
  bottlenecks: 'bottleneck', congestion: 'bottleneck', congested: 'bottleneck', jam: 'bottleneck',
  appointments: 'appointment', slots: 'appointment', slot: 'appointment', booking: 'appointment', bookings: 'appointment', smoothing: 'appointment', reschedule: 'appointment',
  reliable: 'data', trust: 'data', quality: 'data', accurate: 'data', accuracy: 'data',
  overview: 'overall', summary: 'overall', status: 'overall', situation: 'overall',
  accidents: 'incident', accident: 'incident', incidents: 'incident', breakdown: 'incident', breakdowns: 'incident', faults: 'incident', fault: 'incident', roadworks: 'incident',
  upcoming: 'next', coming: 'next',
  hubs: 'hub', warehouse: 'hub', warehouses: 'hub', facilities: 'hub', facility: 'hub', centers: 'hub', centres: 'hub',
  policy: 'rules', limits: 'rules', guardrails: 'rules', rule: 'rules',
  shop: 'store', stores: 'store',
  deliveries: 'trips', delivery: 'trips', runs: 'trips', trip: 'trips',
  jobs: 'work', job: 'work', operations: 'work', tasks: 'work',
  arrived: 'arrive', arrival: 'arrive', arrivals: 'arrive', arriving: 'arrive',
  centre: 'center', dc: 'park', distribution: 'park',
};
const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'i', 'me', 'my', 'we', 'us', 'you', 'your', 'it', 'its', 'this', 'that', 'these', 'those', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'and', 'or', 'please', 'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'tell', 'show', 'give', 'let', 'there', 'any', 'some', 'about', 'now', 'right', 'currently', 'just', 'so', 'far', 'pls', 'hey', 'hi', 'hello', 'going', 'doing', 'get', 'got', 'have', 'has', 'had', 'up', 'go', 'goes', 'look', 'looks', 'like', 'know', 'need', 'want', 'see', 'still', 'yet', 'whats', 'what', 'okay', 'thanks', 'thank', 'one', 'ones']);
// 编号：字母开头、带数字（M02、DS-BEV-1、FL1100、VS1、TR0527、PT015、AF037）；门是 C05、D05、S01-1 这样的
const ID = /\b([a-z]{1,4}(?:-[a-z]{2,5})*-?\d{1,5}(?:-\d{1,2})?[a-z]?)\b/gi;
const DOOR = /^([CD]\d{2}|S\d{2}-\d)$/i;
function tokens(s: string): string[] {
  const out: string[] = [];
  for (const raw of s.toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9#-]+/)) {
    const w = raw.replace(/^-+|-+$/g, '');
    if (!w || STOP.has(w)) continue;
    out.push(SYN[w] ?? w.replace(/(ies)$/, 'y').replace(/([^s])s$/, '$1'));
  }
  return out;
}
interface RouteIndex {
  items: { zh: string; en: string; toks: Set<string>; slot?: 'veh' | 'door' }[];
  idf: Map<string, number>;
}
const routeIndex = new WeakMap<Tr, RouteIndex>();
function indexOf(tr: Tr): RouteIndex {
  let ix = routeIndex.get(tr);
  if (ix) return ix;
  const items = ROUTES.map(([zh, extra]) => {
    const en = txLine(zh, tr);
    const slot = /\bD05\b/.test(zh) ? ('door' as const) : /\bM02\b/.test(zh) ? ('veh' as const) : undefined;
    const toks = new Set(tokens(`${en.replace(/\b(M02|D05)\b/g, ' ')} ${extra}`));
    if (slot) toks.add(`#${slot}`);
    return { zh, en, toks, ...(slot ? { slot } : {}) };
  });
  const df = new Map<string, number>();
  for (const it of items) for (const w of it.toks) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = new Map([...df].map(([w, n]) => [w, Math.log(1 + items.length / n)] as const));
  ix = { items, idf };
  routeIndex.set(tr, ix);
  return ix;
}

/** 路由的结果：zh = 交给内置助手的中文问句（via = 按哪句示例理解的，英文）；没有 zh 时要用英文说明（score 是最好的那句的把握） */
export interface EnglishRoute {
  zh?: string;
  via?: string;
  score: number;
}
/** 把握到这个分数才换成示例问句 */
export const ROUTE_MIN = 0.55;
/**
 * 英文界面上打的英文问题：示例原句直接换回中文；否则按词的重合（同义词归一、按示例里词的稀有程度加权）找最像的示例问句，
 * 问题里的编号放回去；把握不够返回没有 zh 的结果。中文问题、没有字母的输入返回 undefined（照原样问）。
 * Routes free English input to the closest Chinese example question (token overlap with synonyms and IDF weights, IDs put back).
 */
export function routeEnglish(text: string, tr: Tr = tx): EnglishRoute | undefined {
  if (HAN.test(text) || !/[a-z]/i.test(text)) return undefined;
  const exact = fromEnglish(text, tr);
  if (exact !== text) return { zh: exact, score: 1 };
  const ids = [...text.matchAll(ID)].map((m) => (m[1] as string).toUpperCase()).filter((x) => /\d/.test(x) && !/^\d/.test(x));
  const doors = ids.filter((x) => DOOR.test(x));
  // 航班号（FL1100）不是车：按「航班」算
  const flights = ids.filter((x) => /^FL\d/.test(x));
  const vehs = ids.filter((x) => !DOOR.test(x) && !/^FL\d/.test(x));
  const user = new Set(tokens(text.replace(ID, (m: string) => (/\d/.test(m) ? ' ' : m))));
  if (flights.length) user.add('flight');
  if (vehs.length) user.add('#veh');
  if (doors.length) user.add('#door');
  if (!user.size) return { score: 0 };
  const ix = indexOf(tr);
  const unknown = Math.log(1 + ix.items.length);
  const w = (t: string) => ix.idf.get(t) ?? unknown;
  const total = [...user].reduce((s, t) => s + w(t), 0);
  let best: { it: RouteIndex['items'][number]; score: number; cover: number } | undefined;
  for (const it of ix.items) {
    let hit = 0;
    for (const t of user) if (it.toks.has(t)) hit += w(t);
    const score = hit / total;
    // 同分时选示例里的词被问题覆盖得多的（更具体的那句）
    const cover = [...it.toks].filter((t) => user.has(t)).length / it.toks.size;
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && cover > best.cover)) best = { it, score, cover };
  }
  if (!best || best.score < ROUTE_MIN) return { score: best?.score ?? 0 };
  let zh = best.it.zh;
  if (best.it.slot === 'veh' && vehs[0]) zh = zh.replace('M02', vehs[0]);
  if (best.it.slot === 'door' && doors[0]) zh = zh.replace('D05', doors[0]);
  return { zh, via: best.it.slot === 'veh' && vehs[0] ? best.it.en.replace('M02', vehs[0]) : best.it.slot === 'door' && doors[0] ? best.it.en.replace('D05', doors[0]) : best.it.en, score: best.score };
}
/** 英文说明下面给的示例问句（中文原句，按钮上显示英文） */
export const ROUTE_EXAMPLES = ['现在有什么风险', '哪些车会晚', 'M02 在哪', 'D05 什么时候空', '港口怎么样', '有什么待处理的建议', '今日计划', '写交接班报告'];
