import { scenarioFor, withLoad, type ChainScenario, type Disruption, type DisruptionKey, type Gen, type LoadLevel } from '../sim/config';
import { runChain, type ChainResult } from '../sim/engine';

/**
 * 演练和预案库：把一条通知（台风预警、港口罢工、节假日抢购、道路封闭、供应商停产、机场因风暴关闭）变成仿真里的扰动，
 * 同一个种子分别跑「不启动预案」和「启动预案」，都和没有扰动的那次逐日比，打一个韧性得分。
 *
 * - 通知按模板解析：哪种情况、几天后开始、持续几天、强度（台风按预警颜色）、需求涨多少；
 * - 扰动用仿真已有的机制（港口拥堵、机场关闭、高速封闭、供应商停产、需求突增），台风 = 登陆前抢购 + 机场关闭 + 港口拥堵（红色预警再加高速封闭一天）；
 * - 「不启动预案」= 应对手段都不用（发现慢、临场应对：供应商断货 3 天才发现、需求突增 2 天才跟上、不过桥采购、不改降备降机场、不提前改道）；
 *   「启动预案」= 通知触发的预案把对应的手段打开（只在扰动期间起作用，平常的日子两次运行完全一样）。
 */
export type NoticeKind = 'typhoon' | 'strike' | 'holiday' | 'highway' | 'supplier' | 'storm';
export const NOTICE_LABEL: Record<NoticeKind, string> = { typhoon: '台风', strike: '港口停工或拥堵', holiday: '节假日抢购', highway: '道路封闭', supplier: '供应商停产', storm: '机场因风暴关闭' };
export const SEVERITY_LABEL: Record<1 | 2 | 3, string> = { 1: '一般', 2: '较重', 3: '严重' };
export interface Notice {
  kind: NoticeKind;
  /** 收到通知后第几天开始（0 = 当天）、持续几天、强度 */
  offset: number;
  days: number;
  severity: 1 | 2 | 3;
  /** 需求涨多少（0.35 = +35%；节假日、台风登陆前的抢购） */
  uplift?: number;
  text: string;
  /** 从通知里认出来的内容（界面上显示） */
  found: string[];
}
/** 收到通知的那天：第 78 天（运行期的第 2 周，周二）；扰动之后 3 周都在计入结果的时段里 */
export const DRILL_TODAY = 78;
const WEEKDAY_CN = ['一', '二', '三', '四', '五', '六', '日'];

export const NOTICE_PRESETS: { key: string; label: string; text: string }[] = [
  { key: 'typhoon', label: '台风橙色预警', text: '气象台发布台风橙色预警：台风预计后天登陆，影响 3 天，港口和机场可能停止作业。' },
  { key: 'strike', label: '港口罢工', text: '码头工会通知：下周一起港口装卸工人全面罢工 10 天。' },
  { key: 'holiday', label: '长假抢购', text: '国庆长假前一周抢购，预计 5 天后开始，需求增加四成，持续 5 天。' },
  { key: 'highway', label: '高速封闭', text: '交通部门公告：物流园进城的高速明天起封闭施工 3 天。' },
  { key: 'supplier', label: '供应商停产', text: '常温畅销品的主供应商工厂明天起停产 7 天。' },
  { key: 'storm', label: '机场关闭', text: '雷暴预警：机场明天起停航 2 天。' },
];

const CN: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
/** 阿拉伯数字或中文数字（一、两、十二、二十、半） */
export function cnNum(s: string): number | undefined {
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === '半') return 0.5;
  const m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  if (m) return (m[1] ? (CN[m[1]] as number) : 1) * 10 + (m[2] ? (CN[m[2]] as number) : 0);
  if (s.length === 1 && s in CN) return CN[s];
  return undefined;
}
const NUM = '(\\d+(?:\\.\\d+)?|[一二两三四五六七八九十半]+)';
const KIND_RULES: [NoticeKind, RegExp][] = [
  ['typhoon', /台风|热带风暴|飓风/],
  ['storm', /机场|航班|停航|航空/],
  ['strike', /罢工|停工|怠工|工潮|码头.{0,8}(停摆|关闭|瘫痪|拥堵|爆仓)|港口.{0,8}(停摆|关闭|瘫痪|拥堵|爆仓)|班轮.{0,6}(晚到|延误|推迟)|船期.{0,4}(延误|推迟)/],
  ['supplier', /供应商|停产|断供|断货|工厂|召回|减产/],
  ['highway', /高速|道路|公路|封路|封闭|施工|塌方|交通管制|大桥/],
  ['holiday', /节假日|节日|节前|春节|国庆|中秋|元旦|端午|长假|假期|黄金周|促销|大促|店庆|抢购|囤货|需求.{0,4}(增|涨)|销量.{0,4}(增|涨)/],
];
const DEFAULTS: Record<NoticeKind, { offset: number; days: number }> = { typhoon: { offset: 2, days: 3 }, strike: { offset: 3, days: 7 }, holiday: { offset: 5, days: 5 }, highway: { offset: 1, days: 1 }, supplier: { offset: 1, days: 7 }, storm: { offset: 1, days: 2 } };

/** 解析一条通知；认不出是哪种情况时返回 undefined */
export function parseNotice(text: string, today = DRILL_TODAY): Notice | undefined {
  const kind = KIND_RULES.find(([, re]) => re.test(text))?.[0];
  if (!kind) return undefined;
  const found: string[] = [`情况：${NOTICE_LABEL[kind]}`];
  let rest = text;
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(rest);
    if (m) rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length);
    return m;
  };
  const wd = (c: string) => (c === '日' || c === '天' ? 6 : WEEKDAY_CN.indexOf(c));
  const dow = today % 7;
  // 什么时候开始
  let offset: number | undefined;
  let m: RegExpExecArray | null;
  if ((m = take(new RegExp(`${NUM}\\s*(?:个)?(?:天|日)(?:之)?后`)))) offset = cnNum(m[1] as string);
  else if ((m = take(new RegExp(`${NUM}\\s*(?:个)?小时(?:之)?后`)))) offset = Math.round((cnNum(m[1] as string) ?? 0) / 24);
  else if ((m = take(/下(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/))) offset = 7 - dow + wd(m[1] as string);
  else if ((m = take(/(?:本|这)?(?:周|星期|礼拜)([一二三四五六日天])/))) offset = (wd(m[1] as string) - dow + 7) % 7;
  else if ((m = take(/下(?:个)?(?:周|星期|礼拜)/))) offset = 7 - dow;
  else if (take(/大后天/)) offset = 3;
  else if (take(/后天/)) offset = 2;
  else if (take(/明天|明日|次日|明早|明晚/)) offset = 1;
  else if (take(/今天|今日|今晚|当天|即日|立即|马上/)) offset = 0;
  if (offset !== undefined && Number.isFinite(offset)) found.push(offset === 0 ? '开始：今天' : `开始：${offset} 天后（周${WEEKDAY_CN[(today + offset) % 7]}）`);
  // 持续多久
  let days: number | undefined;
  const unit = (n: number, u: string) => (u === '小时' ? Math.ceil(n / 24) : /周|星期|礼拜/.test(u) ? Math.round(n * 7) : n);
  if ((m = take(new RegExp(`(?:持续|影响|为期|长达|延续|共|封闭|关闭|停产|罢工|停工|停航|停止作业)(?:施工)?\\s*(?:约|大约)?\\s*${NUM}\\s*(?:个)?(天|日|周|星期|礼拜|小时)`)))) days = unit(cnNum(m[1] as string) ?? 1, m[2] as string);
  else if ((m = take(/半个月/))) days = 15;
  else if ((m = take(/(?:一)?个月/))) days = 30;
  else if ((m = take(new RegExp(`${NUM}\\s*(?:个)?(?:周|星期|礼拜)`)))) days = Math.round((cnNum(m[1] as string) ?? 1) * 7);
  else if ((m = take(new RegExp(`${NUM}\\s*(?:个)?(?:天|日)`)))) days = cnNum(m[1] as string);
  else if ((m = take(new RegExp(`${NUM}\\s*(?:个)?小时`)))) days = Math.ceil((cnNum(m[1] as string) ?? 24) / 24);
  if (days !== undefined && Number.isFinite(days)) found.push(`持续：${Math.round(days)} 天`);
  // 强度
  let severity: 1 | 2 | 3 = 2;
  if (kind === 'typhoon' && /红色/.test(text)) severity = 3;
  else if (kind === 'typhoon' && /橙色/.test(text)) severity = 2;
  else if (kind === 'typhoon' && /黄色|蓝色/.test(text)) severity = 1;
  if (/超强|强台风|特大|严重|罕见|大规模|全面|大面积|全线/.test(text)) severity = 3;
  else if (/轻微|局部|部分|小范围|短时/.test(text)) severity = 1;
  found.push(`强度：${SEVERITY_LABEL[severity]}`);
  // 需求涨多少
  let uplift: number | undefined;
  if ((m = /(\d+(?:\.\d+)?)\s*[%％]/.exec(text))) uplift = Number(m[1]) / 100;
  else if ((m = /百分之([一二两三四五六七八九十]+)/.exec(text))) uplift = (cnNum(m[1] as string) ?? 0) / 100;
  else if ((m = /([一二两三四五六七八九])\s*成/.exec(text))) uplift = (cnNum(m[1] as string) ?? 0) / 10;
  else if (/翻(?:一)?倍/.test(text)) uplift = 1;
  if (uplift !== undefined) {
    uplift = Math.max(0.05, Math.min(1, uplift));
    found.push(`需求：+${Math.round(uplift * 100)}%`);
  }
  const d = DEFAULTS[kind];
  return {
    kind,
    offset: Math.max(0, Math.min(10, Math.round(offset ?? d.offset))),
    days: Math.max(1, Math.min(14, Math.round(days ?? d.days))),
    severity,
    ...(uplift !== undefined ? { uplift } : {}),
    text,
    found,
  };
}

/** 通知 → 仿真里的扰动（today = 收到通知的那天） */
export function noticeDisruptions(n: Notice, today = DRILL_TODAY): Disruption[] {
  const start = today + n.offset;
  const k = n.severity - 1;
  switch (n.kind) {
    case 'typhoon': {
      // 登陆前两天抢购；登陆当天起机场关闭；港口停止作业、恢复后还要几天消化积压
      const s0 = Math.max(today, start - 2);
      const out: Disruption[] = [];
      if (start > s0) out.push({ key: 'demandSurge', start: s0, days: start - s0, factor: 1 + (n.uplift ?? ([0.15, 0.25, 0.35][k] as number)) });
      out.push({ key: 'airportClosed', start, days: Math.min(n.days, [1, 2, 3][k] as number) });
      out.push({ key: 'portCongestion', start, days: n.days + ([2, 4, 7][k] as number), delayDays: [2, 3, 5][k] as number });
      if (n.severity === 3) out.push({ key: 'highwayClosed', start, days: 1 });
      return out;
    }
    case 'strike':
      return [{ key: 'portCongestion', start, days: n.days + 3, delayDays: Math.max(1, Math.min(10, Math.round(n.days * ([0.5, 0.8, 1][k] as number)))) }];
    case 'holiday':
      return [{ key: 'demandSurge', start, days: n.days, factor: 1 + (n.uplift ?? ([0.2, 0.35, 0.5][k] as number)) }];
    case 'highway':
      return [{ key: 'highwayClosed', start, days: n.days }];
    case 'supplier':
      return [{ key: 'supplierOutage', start, days: n.days }];
    case 'storm':
      return [{ key: 'airportClosed', start, days: n.days }];
  }
}
const DIS_LABEL: Record<DisruptionKey, string> = { portCongestion: '港口拥堵', airportClosed: '机场关闭', highwayClosed: '高速封闭', supplierOutage: '供应商停产', demandSurge: '需求突增' };
/** 一条扰动的说明（第几天开始、持续几天、强度） */
export function disruptionText(x: Disruption, today = DRILL_TODAY): string {
  const when = x.start === today ? '当天' : `${x.start - today} 天后`;
  const extra = x.key === 'demandSurge' ? `，需求 +${Math.round(((x.factor ?? 1.35) - 1) * 100)}%` : x.key === 'portCongestion' ? `，班轮多晚到 ${x.delayDays ?? 6} 天、堆场停留翻倍` : '';
  return `${DIS_LABEL[x.key]}：${when}起 ${x.days} 天${extra}`;
}

// —— 预案库 ——
export type PlaybookKey = 'port' | 'airport' | 'highway' | 'supplier' | 'surge';
export interface Playbook {
  key: PlaybookKey;
  title: string;
  covers: DisruptionKey;
  trigger: string;
  owners: string[];
  steps: { when: string; owner: string; text: string }[];
  /** 仿真里对应的设置 */
  levers: string;
  /** 这个预案的标准演练用哪条通知 */
  preset: string;
  apply: (s: ChainScenario) => void;
}
export const PLAYBOOKS: readonly Playbook[] = [
  {
    key: 'port',
    title: '港口拥堵预案（含罢工、台风停工）',
    covers: 'portCongestion',
    trigger: '船公司或码头通知本店班轮晚到超过 2 天、码头停工，或者堆场平均停留超过 3 天',
    owners: ['进口物流主管', '采购', '配送中心计划员'],
    steps: [
      { when: '收到通知 2 小时内', owner: '配送中心计划员', text: '孪生按最新的到港时间推算每个进口商品族未来 12 天的库存缺口' },
      { when: '4 小时内', owner: '采购', text: '只按缺口向国内分销商过桥采购（贵约 15%，3 天到货）' },
      { when: '1 天内', owner: '进口物流主管', text: '和码头确认预清关和提箱预约，自己的箱优先放行（堆场停留只多三成，不是翻倍）' },
      { when: '每天', owner: '配送中心计划员', text: '复核缺口；班轮靠泊、堆场恢复后停止过桥采购' },
    ],
    levers: '过桥采购、预清关优先放行',
    preset: NOTICE_PRESETS[1]?.text ?? '',
    apply: (s) => {
      s.twin.bridgeBuy = true;
    },
  },
  {
    key: 'airport',
    title: '机场关闭预案',
    covers: 'airportClosed',
    trigger: '机场发布停航或风暴、台风预警（关闭 6 小时以上）',
    owners: ['空运协调员', '配送中心夜班主管', '车队调度'],
    steps: [
      { when: '收到预警时', owner: '空运协调员', text: '和航空公司确认改降备降机场（约 300 公里）' },
      { when: '落地前 2 小时', owner: '车队调度', text: '派冷藏车去备降机场接货，路上约 5 小时' },
      { when: '同时', owner: '配送中心夜班主管', text: '通知门店进口生鲜晚到，调整越库波次' },
      { when: '机场恢复后', owner: '空运协调员', text: '改回原机场，核对空运费用' },
    ],
    levers: '改降备降机场、卡车运回',
    preset: NOTICE_PRESETS[5]?.text ?? '',
    apply: (s) => {
      s.twin.altAirport = true;
    },
  },
  {
    key: 'highway',
    title: '道路封闭预案',
    covers: 'highwayClosed',
    trigger: '交通部门发布封闭、施工公告，或者孪生检测到事故封路',
    owners: ['车队调度', '门店收货主管'],
    steps: [
      { when: '前一天', owner: '车队调度', text: '孪生为第二天所有车辆提前改道，重新排出车时刻' },
      { when: '出车前', owner: '车队调度', text: '把新的到店时间推给门店和司机' },
      { when: '当天', owner: '门店收货主管', text: '按新的到店时间安排收货口和人手，必要时收货截止顺延' },
    ],
    levers: '提前改道',
    preset: NOTICE_PRESETS[3]?.text ?? '',
    apply: (s) => {
      s.twin.reroute = true;
    },
  },
  {
    key: 'supplier',
    title: '供应商断供预案',
    covers: 'supplierOutage',
    trigger: '供应商通知停产、断供，或者到货确认连续缺失',
    owners: ['采购', '品类经理', '门店店长'],
    steps: [
      { when: '收到通知当天', owner: '采购', text: '确认断供范围，把卡住的订单转给预先认证的备用供应商（提前期多 1 天）' },
      { when: '1 天内', owner: '品类经理', text: '按库存天数排优先级，必要时限购或用相近商品补位' },
      { when: '断供期间', owner: '门店店长', text: '调整陈列，盯住缺货的商品位' },
      { when: '恢复后', owner: '采购', text: '订单转回主供应商，核对多花的钱' },
    ],
    levers: '预先认证的备用供应商、通知当天确认',
    preset: NOTICE_PRESETS[4]?.text ?? '',
    apply: (s) => {
      s.twin.dualSource = true;
      s.twin.detectOutageDays = 0;
    },
  },
  {
    key: 'surge',
    title: '需求突增预案（节假日、台风前抢购）',
    covers: 'demandSurge',
    trigger: '节假日日历、天气预警，或者门店销量连续 2 小时比预测高三成以上',
    owners: ['需求计划员', '配送中心计划员', '门店店长'],
    steps: [
      { when: '通知一到', owner: '需求计划员', text: '把突增系数加进门店和配送中心的订货预测（提前备货，不等销量涨起来）' },
      { when: '前一天', owner: '配送中心计划员', text: '加一波配送、加拣货人手' },
      { when: '当天', owner: '门店店长', text: '加补货人手，盯住畅销品的货架' },
      { when: '结束后', owner: '需求计划员', text: '把系数撤掉，避免之后积压' },
    ],
    levers: '订货预测提前加上突增系数',
    preset: NOTICE_PRESETS[2]?.text ?? '',
    apply: (s) => {
      s.twin.surgeResponseDays = 0;
    },
  },
];
const PLAYBOOK_OF: Record<DisruptionKey, PlaybookKey> = { portCongestion: 'port', airportClosed: 'airport', highwayClosed: 'highway', supplierOutage: 'supplier', demandSurge: 'surge' };
export const playbooksFor = (dis: readonly Disruption[]): Playbook[] => PLAYBOOKS.filter((p) => dis.some((x) => PLAYBOOK_OF[x.key] === p.key));

/** 不启动预案：应对手段都不用（发现慢、临场应对） */
export function noPlaybook(s: ChainScenario): void {
  s.twin = { ...s.twin, reroute: false, detectOutageDays: 3, surgeResponseDays: 2, dualSource: false, bridgeBuy: false, altAirport: false };
}

// —— 演练 ——
export interface DrillScore {
  /** 韧性得分（0–100）和五项的分 */
  score: number;
  parts: { service: number; stockout: number; fresh: number; late: number; cost: number };
  /** 扰动后 3 周的平均服务水平（%）、比平常低多少、最差一天低多少（百分点） */
  window: number;
  windowDrop: number;
  worstDrop: number;
  /** 扰动期间（加 2 天）准时送达、空运生鲜服务水平最差一天比平常低多少（百分点） */
  onTimeDrop: number;
  airDrop: number;
  /** 3 周里多少卖的件数、多花的钱（含应对成本，美元）、占平常 3 周成本的比例（%） */
  lostUnits: number;
  extraCost: number;
  costPct: number;
  responseCost: number;
}
/**
 * 韧性得分：五项满分 30 / 20 / 10 / 20 / 20，按下降多少线性扣分，降到 zero 时这一项为 0 分——
 * 3 周平均服务水平降 1 个百分点、最差一天降 10 个百分点、空运生鲜最差一天降 60 个百分点、准时送达最差一天降 30 个百分点、多花平常 3 周成本的 8%
 */
export const SCORE_SCALE = { service: { points: 30, zero: 1, label: '3 周服务水平' }, stockout: { points: 20, zero: 10, label: '最差一天的缺货' }, fresh: { points: 10, zero: 60, label: '空运生鲜' }, late: { points: 20, zero: 30, label: '准时送达' }, cost: { points: 20, zero: 8, label: '多花的钱' } } as const;
const WINDOW = 21;

function measure(base: ChainResult, hit: ChainResult, s0: number, e0: number, warmup: number): Omit<DrillScore, 'score' | 'parts'> {
  // daily 从第 0 天起记（含预热期）
  void warmup;
  const sl = (x: readonly number[], a: number, b: number) => x.slice(a, b);
  const win = sl(hit.daily.service, s0, s0 + WINDOW);
  const winB = sl(base.daily.service, s0, s0 + WINDOW);
  const mean = (x: readonly number[]) => (x.reduce((a, b) => a + b, 0) / Math.max(1, x.length)) * 100;
  const drop = (h: readonly number[], b: readonly number[]) => Math.max(0, ...h.map((v, i) => ((b[i] as number) - v) * 100));
  const lost = sl(hit.daily.lost, s0, s0 + WINDOW).reduce((a, b) => a + b, 0) - sl(base.daily.lost, s0, s0 + WINDOW).reduce((a, b) => a + b, 0);
  // 多花的钱按每箱成本的变化算（需求突增时多卖的货本身要多花的运费、人工不算扰动的代价），加上应对成本
  const extraCost = (hit.cost.perCase - base.cost.perCase) * hit.casesDelivered * hit.days + hit.responseCost;
  return {
    window: mean(win),
    windowDrop: mean(winB) - mean(win),
    worstDrop: drop(win, winB),
    onTimeDrop: drop(sl(hit.daily.onTime, s0, e0 + 2), sl(base.daily.onTime, s0, e0 + 2)),
    airDrop: drop(sl(hit.daily.airService, s0, e0 + 2), sl(base.daily.airService, s0, e0 + 2)),
    lostUnits: lost,
    extraCost,
    costPct: (extraCost / Math.max(1, base.cost.total * WINDOW)) * 100,
    responseCost: hit.responseCost,
  };
}
function scoreOf(m: Omit<DrillScore, 'score' | 'parts'>): DrillScore {
  const part = (v: number, k: keyof typeof SCORE_SCALE) => SCORE_SCALE[k].points * Math.max(0, 1 - Math.max(0, v) / SCORE_SCALE[k].zero);
  const parts = { service: part(m.windowDrop, 'service'), stockout: part(m.worstDrop, 'stockout'), fresh: part(m.airDrop, 'fresh'), late: part(m.onTimeDrop, 'late'), cost: part(m.costPct, 'cost') };
  return { ...m, parts, score: parts.service + parts.stockout + parts.fresh + parts.late + parts.cost };
}
function average(list: Omit<DrillScore, 'score' | 'parts'>[]): Omit<DrillScore, 'score' | 'parts'> {
  const keys = ['window', 'windowDrop', 'worstDrop', 'onTimeDrop', 'airDrop', 'lostUnits', 'extraCost', 'costPct', 'responseCost'] as const;
  const out = {} as Omit<DrillScore, 'score' | 'parts'>;
  for (const k of keys) out[k] = list.reduce((a, x) => a + x[k], 0) / Math.max(1, list.length);
  return out;
}

export interface DrillReport {
  notice: Notice;
  disruptions: Disruption[];
  playbooks: PlaybookKey[];
  gen: Gen;
  seeds: number[];
  without: DrillScore;
  with: DrillScore;
  /** 几个预案一起启动时，每个预案单独启动的得分（看哪一步最管用） */
  each: { key: PlaybookKey; score: DrillScore }[];
  /** 每天的门店服务水平（%，几个种子平均）：没有扰动、不启动预案、启动预案；from = 第几天开始 */
  series: { from: number; base: number[]; without: number[]; with: number[] };
  /** 扰动的天（第一条开始到最后一条结束） */
  span: [number, number];
  text: string;
  ms: number;
}
export interface DrillOptions {
  gen?: Gen;
  seeds?: number[];
  load?: LoadLevel;
  /** 调用方给场景再套一层（网页套上管理台改过的设施配置） */
  prepare?: (s: ChainScenario) => ChainScenario;
  onProgress?: (done: number, total: number) => void;
}

/** 跑一次演练：每个种子跑没有扰动、不启动预案、启动预案（几个预案时再各单独跑一次） */
export function runDrill(n: Notice, opts: DrillOptions = {}): DrillReport {
  const t0 = performance.now();
  const gen = opts.gen ?? 'g3';
  const seeds = opts.seeds ?? [1, 2, 3];
  const dis = noticeDisruptions(n);
  const books = playbooksFor(dis);
  const s0 = Math.min(...dis.map((x) => x.start));
  const e0 = Math.max(...dis.map((x) => x.start + x.days));
  const make = (seed: number, hit: boolean, on: readonly Playbook[]) => {
    let s = withLoad(scenarioFor(gen, seed), opts.load ?? 'normal');
    if (opts.prepare) s = opts.prepare(s);
    if (hit) {
      s.disruptions = dis.map((x) => ({ ...x }));
      noPlaybook(s);
      for (const p of on) p.apply(s);
    }
    return s;
  };
  const variants: { key: string; on: readonly Playbook[] }[] = [{ key: 'without', on: [] }, { key: 'with', on: books }, ...(books.length > 1 ? books.map((p) => ({ key: p.key, on: [p] })) : [])];
  const total = seeds.length * (1 + variants.length);
  let done = 0;
  const acc = new Map<string, Omit<DrillScore, 'score' | 'parts'>[]>();
  const from = Math.max(0, s0 - 4);
  const to = s0 + WINDOW;
  const series = { from, base: new Array<number>(to - from).fill(0), without: new Array<number>(to - from).fill(0), with: new Array<number>(to - from).fill(0) };
  for (const seed of seeds) {
    const baseS = make(seed, false, []);
    const base = runChain(baseS);
    opts.onProgress?.(++done, total);
    base.daily.service.slice(from, to).forEach((v, i) => (series.base[i] = (series.base[i] as number) + (v * 100) / seeds.length));
    for (const v of variants) {
      const r = runChain(make(seed, true, v.on));
      opts.onProgress?.(++done, total);
      const list = acc.get(v.key) ?? [];
      list.push(measure(base, r, s0, e0, baseS.warmup));
      acc.set(v.key, list);
      if (v.key === 'without' || v.key === 'with') {
        const arr = series[v.key];
        r.daily.service.slice(from, to).forEach((x, i) => (arr[i] = (arr[i] as number) + (x * 100) / seeds.length));
      }
    }
  }
  const sc = (k: string) => scoreOf(average(acc.get(k) ?? []));
  const report: DrillReport = {
    notice: n,
    disruptions: dis,
    playbooks: books.map((p) => p.key),
    gen,
    seeds,
    without: sc('without'),
    with: sc('with'),
    each: books.length > 1 ? books.map((p) => ({ key: p.key, score: sc(p.key) })) : [],
    series,
    span: [s0, e0],
    text: '',
    ms: 0,
  };
  report.text = drillText(report);
  report.ms = performance.now() - t0;
  return report;
}

const n0 = (x: number) => Math.round(x).toLocaleString('en-US');
const n1 = (x: number) => (Math.abs(x) < 0.05 ? '0' : x.toFixed(1));
const usd = (x: number) => `${x < 0 ? '−' : ''}$${n0(Math.abs(x))}`;
/** 演练报告（一段话） */
export function drillText(r: DrillReport): string {
  const n = r.notice;
  const books = r.playbooks.map((k) => PLAYBOOKS.find((p) => p.key === k)?.title.replace(/（.*）$/, '') ?? k);
  const line = (x: DrillScore) => `扰动后 3 周门店服务水平平均降 ${n1(Math.max(0, x.windowDrop))} 个百分点、最差一天降 ${n1(x.worstDrop)} 个，空运生鲜最差一天降 ${n1(x.airDrop)} 个，准时送达最差一天降 ${n1(x.onTimeDrop)} 个，少卖 ${n0(Math.max(0, x.lostUnits))} 件，${x.extraCost > 0.5 ? `多花约 ${usd(x.extraCost)}` : x.extraCost < -0.5 ? '每箱成本反而略降（多卖的货摊薄了固定成本）' : '没有多花钱'}`;
  const saved = r.without.lostUnits > 1 ? Math.max(0, Math.min(100, ((r.without.lostUnits - r.with.lostUnits) / r.without.lostUnits) * 100)) : 0;
  const parts = [
    `通知：「${n.text}」认出来是${NOTICE_LABEL[n.kind]}（${SEVERITY_LABEL[n.severity]}），在仿真里对应${r.disruptions.map((x) => disruptionText(x)).join('；')}。`,
    `不启动预案：${line(r.without)}。`,
    `启动${books.map((b) => `「${b}」`).join('、')}：${line(r.with)}。`,
    `韧性得分从 ${n0(r.without.score)} 分到 ${n0(r.with.score)} 分${r.without.lostUnits > 1 ? `，少卖的件数挽回 ${n0(saved)}%` : ''}。`,
  ];
  if (r.each.length) {
    const best = [...r.each].sort((a, b) => b.score.score - a.score.score)[0];
    const title = PLAYBOOKS.find((p) => p.key === best?.key)?.title.replace(/（.*）$/, '');
    if (best && title) parts.push(`单独启动时最管用的是「${title}」（${n0(best.score.score)} 分）。`);
  }
  if (r.without.score >= 98 && r.with.score >= 98 && Math.abs(r.without.lostUnits) < 50) parts.push('这次扰动没有影响到门店（库存和路线够用），预案的作用看不出来；可以试更严重的情况。');
  else if (r.with.score + 2 < r.without.score) parts.push('这次预案反而更差：应对手段的成本超过了它挽回的损失，可以把触发条件定得更严。');
  return parts.join('');
}
