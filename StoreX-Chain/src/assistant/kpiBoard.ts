import { STORE } from '../region/network';
import { soldOutAt } from './context';
import { pendingCards } from './brief';
import { ROLE_LABEL, type Role } from './roles';
import type { AssistCtx } from './types';

/**
 * 分层看板：集团、区域、设施、作业四层指标，每个指标有「注意」「告警」两道阈值（可以改，存在本机浏览器里）。
 *
 * - 集团：18 周平均的服务水平、准时率、每箱成本、每箱排放（和这个方案的基准比，超出百分之几算注意 / 告警），今天的准点率、孪生措施花费；
 * - 区域：在途车辆的平均延误、进行中的路况、预计迟到的车；
 * - 设施：港口闸口排队、堆场利用率，配送中心月台门在用、累计等门，门店累计等收货口、最快卖空的商品族还够卖几小时；
 * - 作业：晚 20 分钟以上的车、超温的车、待处理的建议卡、待审批。
 * 进入注意或告警就开一条告警；值班的人点「知道了」确认；没人确认的往上报：告警 15 分钟报站长、30 分钟报区域经理，注意 30 分钟报站长。
 */
export type KpiLevel = 'group' | 'region' | 'facility' | 'op';
export const LEVEL_LABEL: Record<KpiLevel, string> = { group: '集团', region: '区域', facility: '设施', op: '作业' };
export const LEVELS: KpiLevel[] = ['group', 'region', 'facility', 'op'];

export interface KpiInput {
  ctx: AssistCtx;
  /** 这次运行的 18 周平均指标、这个方案的基准（报告里 18 周的平均） */
  summary?: Record<string, number>;
  base?: Record<string, number>;
  /** 待审批的单数 */
  approvals?: number;
}
export interface KpiDef {
  key: string;
  level: KpiLevel;
  label: string;
  unit: string;
  better: 'lower' | 'higher';
  /** 默认阈值；rel = 阈值是相对基准的百分比（比基准差多少算注意 / 告警） */
  warn: number;
  alarm: number;
  rel?: boolean;
  digits?: number;
  get(x: KpiInput): number | undefined;
}
export interface Threshold {
  warn: number;
  alarm: number;
}
export type KpiState = 'ok' | 'warn' | 'alarm' | 'na';
export interface KpiValue {
  def: KpiDef;
  value: number | undefined;
  state: KpiState;
  /** 相对基准的变化（%），rel 指标才有 */
  delta?: number;
}

/** 一次 evaluate 里几个指标共用的中间结果（在途的车、待处理的建议卡、监控识别）只算一次；evaluate 以外单独调 get 时照常每次算 */
let shared: Map<string, unknown> | undefined;
function once<T>(key: string, f: () => T): T {
  if (!shared) return f();
  if (!shared.has(key)) shared.set(key, f());
  return shared.get(key) as T;
}
const moving = (x: KpiInput) => once('moving', () => x.ctx.rows.filter((r) => r.status === 'moving'));
const nums = (x: KpiInput, f: 'port' | 'dc' | 'store') => x.ctx.fac?.()[f]?.nums;
const cards = (x: KpiInput) => once('cards', () => pendingCards(x.ctx));
const cams = (x: KpiInput) => once('cams', () => x.ctx.cams?.());

export const KPI_DEFS: KpiDef[] = [
  { key: 'service', level: 'group', label: '门店服务水平（18 周平均）', unit: '%', better: 'higher', warn: 0.3, alarm: 1, rel: true, digits: 2, get: (x) => x.summary?.service },
  { key: 'onTime18', level: 'group', label: '准时送达（18 周平均）', unit: '%', better: 'higher', warn: 2, alarm: 5, rel: true, digits: 1, get: (x) => x.summary?.onTime18 },
  { key: 'costPerCase', level: 'group', label: '每箱的供应链成本（18 周平均）', unit: '美元', better: 'lower', warn: 5, alarm: 15, rel: true, digits: 2, get: (x) => x.summary?.costPerCase },
  { key: 'co2PerCase', level: 'group', label: '每箱的本地运输排放（18 周平均）', unit: '克', better: 'lower', warn: 5, alarm: 15, rel: true, digits: 0, get: (x) => x.summary?.co2PerCase },
  {
    key: 'onTimeToday',
    level: 'group',
    label: `${STORE.name}今天到货准点率（到此刻）`,
    unit: '%',
    better: 'higher',
    warn: 95,
    alarm: 85,
    digits: 0,
    get: (x) => {
      const res = x.ctx.twin?.result;
      const done = res ? res.stops.filter((s) => s.store === STORE.key && s.t <= x.ctx.t) : [];
      return done.length ? (done.filter((s) => s.late <= 0.5).length / done.length) * 100 : undefined;
    },
  },
  { key: 'twinCost', level: 'group', label: '孪生措施花费（今天到此刻）', unit: '美元', better: 'lower', warn: 300, alarm: 800, digits: 0, get: (x) => x.ctx.twin?.kpi?.cost },
  { key: 'avgDelay', level: 'region', label: '在途车辆的平均延误', unit: '分钟', better: 'lower', warn: 10, alarm: 25, digits: 0, get: (x) => (moving(x).length ? moving(x).reduce((a, r) => a + Math.max(0, r.delayMin ?? 0), 0) / moving(x).length : 0) },
  { key: 'incidents', level: 'region', label: '进行中的路况（事故、施工、拥堵）', unit: '处', better: 'lower', warn: 1, alarm: 3, digits: 0, get: (x) => (x.ctx.twin ? x.ctx.twin.incidents.filter((i) => i.t0 <= x.ctx.t && i.t1 > x.ctx.t).length : undefined) },
  { key: 'lateCards', level: 'region', label: '孪生预计会迟到的车（待处理）', unit: '辆', better: 'lower', warn: 1, alarm: 3, digits: 0, get: (x) => (x.ctx.twin ? cards(x).filter((r) => r.kind === 'late').length : undefined) },
  { key: 'gateQueue', level: 'facility', label: '港口闸口排队的外来集卡', unit: '辆', better: 'lower', warn: 5, alarm: 12, digits: 0, get: (x) => nums(x, 'port')?.gateQueue },
  { key: 'yardUse', level: 'facility', label: '港口堆场利用率', unit: '%', better: 'lower', warn: 80, alarm: 92, digits: 0, get: (x) => nums(x, 'port')?.yardUse },
  { key: 'dcDoors', level: 'facility', label: '配送中心月台门在用', unit: '%', better: 'lower', warn: 85, alarm: 95, digits: 0, get: (x) => nums(x, 'dc')?.doorUse },
  { key: 'doorWait', level: 'facility', label: '等月台门（今天累计）', unit: '分钟', better: 'lower', warn: 15, alarm: 60, digits: 0, get: (x) => x.ctx.twin?.kpi?.door },
  { key: 'dockWait', level: 'facility', label: `${STORE.name}等收货口（今天累计）`, unit: '分钟', better: 'lower', warn: 15, alarm: 60, digits: 0, get: (x) => x.ctx.twin?.kpi?.dock },
  {
    key: 'stockHours',
    level: 'facility',
    label: `${STORE.name}最快卖空的商品族还够卖`,
    unit: '小时',
    better: 'higher',
    warn: 4,
    alarm: 2,
    digits: 1,
    get: (x) => {
      const t = x.ctx.t;
      if (!x.ctx.twin || t < 7 * 3600 || t >= 21 * 3600) return undefined;
      let min = 48;
      for (const s of x.ctx.twin.stock) {
        const at = soldOutAt(s.est ?? s.units, s.daily, t);
        if (at !== undefined) min = Math.min(min, (at - t) / 3600);
      }
      return min;
    },
  },
  { key: 'camQueue', level: 'facility', label: `监控识别：${STORE.name}收货区排队的车`, unit: '辆', better: 'lower', warn: 2, alarm: 4, digits: 0, get: (x) => cams(x)?.find((c) => c.kind === 'store')?.queued },
  { key: 'camMisaligned', level: 'facility', label: '监控识别：没对准收货口 / 月台门的车', unit: '辆', better: 'lower', warn: 1, alarm: 2, digits: 0, get: (x) => { const cs = cams(x); return cs ? cs.reduce((a, c) => a + c.misaligned, 0) : undefined; } },
  { key: 'late20', level: 'op', label: '晚 20 分钟以上的车', unit: '辆', better: 'lower', warn: 1, alarm: 3, digits: 0, get: (x) => moving(x).filter((r) => (r.delayMin ?? 0) >= 20).length },
  { key: 'hot', level: 'op', label: '货温超标的车', unit: '辆', better: 'lower', warn: 1, alarm: 2, digits: 0, get: (x) => x.ctx.rows.filter((r) => r.temp && r.temp.value > r.temp.limit && (r.status === 'moving' || r.status === 'working')).length },
  { key: 'pending', level: 'op', label: '待处理的建议卡', unit: '张', better: 'lower', warn: 2, alarm: 4, digits: 0, get: (x) => (x.ctx.twin ? cards(x).length : undefined) },
  { key: 'approvals', level: 'op', label: '待审批', unit: '单', better: 'lower', warn: 1, alarm: 3, digits: 0, get: (x) => x.approvals },
];

export const defaultThresholds = (): Record<string, Threshold> => Object.fromEntries(KPI_DEFS.map((d) => [d.key, { warn: d.warn, alarm: d.alarm }]));

export function evaluate(x: KpiInput, th: Record<string, Threshold> = defaultThresholds()): KpiValue[] {
  const outer = shared;
  shared = new Map();
  try {
    return evaluateAll(x, th);
  } finally {
    shared = outer;
  }
}
function evaluateAll(x: KpiInput, th: Record<string, Threshold>): KpiValue[] {
  return KPI_DEFS.map((def) => {
    const value = def.get(x);
    const lim = th[def.key] ?? { warn: def.warn, alarm: def.alarm };
    if (value === undefined || !Number.isFinite(value)) return { def, value: undefined, state: 'na' as const };
    if (def.rel) {
      const b = x.base?.[def.key];
      if (b === undefined || !b) return { def, value, state: 'na' as const };
      // 变差了多少（%）：越低越好的看涨了多少，越高越好的看跌了多少（服务水平、准时率按百分点）
      const worse = def.better === 'lower' ? ((value - b) / Math.abs(b)) * 100 : def.unit === '%' ? b - value : ((b - value) / Math.abs(b)) * 100;
      const delta = def.better === 'lower' || def.unit !== '%' ? ((value - b) / Math.abs(b)) * 100 : value - b;
      return { def, value, delta, state: worse >= lim.alarm ? 'alarm' : worse >= lim.warn ? 'warn' : 'ok' };
    }
    const bad = (limit: number) => (def.better === 'lower' ? value >= limit : value <= limit);
    return { def, value, state: bad(lim.alarm) ? 'alarm' : bad(lim.warn) ? 'warn' : 'ok' };
  });
}

export interface Alert {
  key: string;
  label: string;
  level: KpiLevel;
  state: 'warn' | 'alarm';
  since: number;
  value: number;
  /** 现在该谁管（往上报以后变） */
  owner: Role;
  ack?: { by: Role; t: number };
  escalated: { to: Role; t: number }[];
  cleared?: number;
}

/** 告警本：指标进入注意 / 告警开一条，恢复正常关掉；没人确认的按时往上报 */
export class AlertBook {
  readonly alerts: Alert[] = [];
  private lastT = -1;

  /** 时间往前走到 t：更新告警；时间往回拖或者跳得太远就重新开始（往上报按时间算，跳着看没意义） */
  update(t: number, values: readonly KpiValue[]): Alert[] {
    const jumped = this.lastT < 0 || t < this.lastT || t - this.lastT > 30 * 60;
    if (jumped) this.alerts.length = 0;
    this.lastT = t;
    const fresh: Alert[] = [];
    for (const v of values) {
      const open = this.alerts.find((a) => a.key === v.def.key && a.cleared === undefined);
      if (v.state === 'warn' || v.state === 'alarm') {
        if (open) {
          if (open.state === 'warn' && v.state === 'alarm') {
            open.state = 'alarm';
            delete open.ack;
          }
          open.value = v.value as number;
        } else {
          const a: Alert = { key: v.def.key, label: v.def.label, level: v.def.level, state: v.state, since: t, value: v.value as number, owner: 'dispatcher', escalated: [] };
          this.alerts.push(a);
          if (!jumped) fresh.push(a);
        }
      } else if (open) open.cleared = t;
    }
    // 往上报：告警 15 分钟没人确认报站长、30 分钟报区域经理；注意 30 分钟报站长
    for (const a of this.alerts) {
      if (a.cleared !== undefined || a.ack) continue;
      const age = t - a.since;
      const next: Role | undefined = a.state === 'alarm' ? (age >= 30 * 60 ? 'regional' : age >= 15 * 60 ? 'manager' : undefined) : age >= 30 * 60 ? 'manager' : undefined;
      if (next && next !== a.owner && (next === 'regional' || a.owner === 'dispatcher')) {
        a.owner = next;
        a.escalated.push({ to: next, t });
      }
    }
    // 关掉的只留最近的 30 条
    const closed = this.alerts.filter((a) => a.cleared !== undefined);
    if (closed.length > 30) for (const a of closed.slice(0, closed.length - 30)) this.alerts.splice(this.alerts.indexOf(a), 1);
    return fresh;
  }

  ack(key: string, by: Role, t: number): Alert | undefined {
    const a = this.alerts.find((x) => x.key === key && x.cleared === undefined);
    if (!a || by === 'viewer') return undefined;
    a.ack = { by, t };
    return a;
  }

  open(): Alert[] {
    return this.alerts.filter((a) => a.cleared === undefined).sort((a, b) => (b.state === 'alarm' ? 1 : 0) - (a.state === 'alarm' ? 1 : 0) || a.since - b.since);
  }
}

export const ownerText = (a: Alert): string => `${ROLE_LABEL[a.owner]}${a.escalated.length ? '（已往上报）' : ''}`;
