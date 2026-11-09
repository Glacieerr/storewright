import { HUB_SLOT, type HubDay, type HubKey } from '../hub/types';
import { STORE } from '../region/network';
import { FAMILIES } from '../region/products';
import type { KpiPoint, LoopResult } from '../twin/loop';
import { clock } from '../twin/twin';
import type { Msg } from '../twin/types';
import type { AssistCtx, Link } from './types';

/**
 * 异常检测：只用此刻以前的数据，找「比平时明显多 / 高」的时段，并给出最可能的原因。
 *
 * - 闭环的累计指标（迟到、超温、缺货、等月台门、等收货口、措施花费）切成每 15 分钟的增量；
 *   每一格和它前面 3 小时比：基线取指数平滑（α = 0.3）和中位数里大的那个，尺度取中位数绝对偏差 × 1.4826（太小时用最小幅度的三分之一），
 *   比基线多出一个最小幅度、并且稳健 z 分数 ≥ 3 才算异常；相邻的异常格并成一个时段。
 * - 孪生的到店预测误差（每小时）：同样的办法，看预测是不是突然变差。
 * - 仓储中心每个区的占用（每 5 分钟）：超过容量的 85% 的时段，和 15 分钟里突然涨了容量的 15% 以上的时段。
 * - 分层看板上还开着的告警也列出来（阈值触发的）。
 * 原因：在那个时段里贡献最多的车、商品族、进来的载具，同时段的路况、故障、指令。
 */
export interface Anomaly {
  key: string;
  source: 'kpi' | 'fidelity' | 'hub' | 'board';
  label: string;
  t0: number;
  t1: number;
  /** 时段里的观测值（指标是这段时间的增量合计；占用是最高的百分比） */
  value: number;
  /** 平时的水平（同样的单位；阈值告警没有） */
  baseline: number;
  z: number;
  unit: string;
  severity: '高' | '中';
  cause: string;
  links: Link[];
}

const median = (xs: readonly number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** 往上的异常：返回异常格的下标、z 分数和基线 */
export function detectUp(x: readonly number[], minDev: number, minHist = 4): { i: number; z: number; base: number }[] {
  const out: { i: number; z: number; base: number }[] = [];
  let ewma = x[0] ?? 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i] as number;
    if (i >= minHist) {
      const w = x.slice(Math.max(0, i - 12), i);
      const med = median(w);
      const scale = Math.max(1.4826 * median(w.map((y) => Math.abs(y - med))), minDev / 3);
      const base = Math.max(ewma, med);
      const z = (v - med) / scale;
      if (v - base >= minDev && z >= 3) out.push({ i, z, base });
    }
    ewma = 0.3 * v + 0.7 * ewma;
  }
  return out;
}

/** 相邻的下标并成时段 */
function runs<T extends { i: number }>(xs: readonly T[]): T[][] {
  const out: T[][] = [];
  for (const x of xs) {
    const last = out[out.length - 1];
    if (last && x.i - (last[last.length - 1] as T).i <= 1) last.push(x);
    else out.push([x]);
  }
  return out;
}

type Field = 'late' | 'hot' | 'short' | 'door' | 'dock' | 'cost';
const FIELDS: { key: Field; label: string; unit: string; minDev: number }[] = [
  { key: 'late', label: `${STORE.name}到货迟到`, unit: '分钟', minDev: 10 },
  { key: 'hot', label: '冷链货超温', unit: '分钟', minDev: 5 },
  { key: 'short', label: `${STORE.name}缺货`, unit: '分钟', minDev: 15 },
  { key: 'door', label: '等配送中心月台门', unit: '分钟', minDev: 10 },
  { key: 'dock', label: `等${STORE.name}收货口`, unit: '分钟', minDev: 10 },
  { key: 'cost', label: '孪生措施花费', unit: '美元', minDev: 50 },
];
const BUCKET = 900;

/** 累计指标在每个 15 分钟边界的值（到此刻为止） */
function cumAt(series: readonly KpiPoint[], t: number): KpiPoint {
  let p: KpiPoint = { t: 0, late: 0, hot: 0, short: 0, cost: 0, lateStops: 0, door: 0, dock: 0 };
  for (const x of series) {
    if (x.t > t) break;
    p = x;
  }
  return p;
}

type EventMsg = Extract<Msg, { kind: 'event' }>;
const isEvent = (m: Msg): m is EventMsg => m.kind === 'event';

const sumSlots = (a: Float32Array | undefined, t0: number, t1: number) => {
  if (!a) return 0;
  let s = 0;
  for (let k = Math.max(0, Math.floor(t0 / 300)); k < Math.min(a.length, Math.ceil(t1 / 300)); k++) s += a[k] as number;
  return s;
};

function kpiCause(ctx: AssistCtx, res: LoopResult, f: Field, a: number, b: number): { text: string; links: Link[] } {
  const label = (vid: number) => ctx.rows.find((r) => r.vid === vid)?.id ?? ctx.board.ops.find((o) => o.vehicle === vid)?.id ?? `车 ${vid}`;
  const links: Link[] = [{ kind: 'time', t: a, label: `跳到 ${clock(a)}` }];
  const inc = res.incidents.filter((x) => x.t0 < b && x.t1 > a);
  const incText = inc.length ? `；同时段路况：${inc.map((x) => x.text).join('、')}` : '';
  const top = (m: Map<number, number>) =>
    [...m.entries()]
      .filter(([, v]) => v >= 0.5)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3);
  if (f === 'late') {
    const st = res.stops.filter((s) => s.store === STORE.key && s.t >= a && s.t < b && s.late > 0.5).sort((x, y) => y.late - x.late);
    for (const s of st.slice(0, 2)) links.push({ kind: 'vehicle', vid: s.vid, label: `看 ${label(s.vid)}` });
    const faults = res.msgs.filter(isEvent).filter((m) => m.ev === 'fault' && m.code === 'ENG' && st.some((s) => s.vid === m.vid) && m.t < b);
    return { text: `${st.length ? `这段时间到店晚了的：${st.slice(0, 3).map((s) => `${label(s.vid)} 晚 ${Math.round(s.late)} 分钟`).join('、')}` : '这段时间有车到店晚了'}${faults.length ? `；${faults.map((m) => `${label(m.vid)} ${clock(m.t)} 报故障`).join('、')}` : ''}${incText}`, links };
  }
  if (f === 'hot') {
    const m = new Map<number, number>();
    for (const [vid, arr] of res.by.hot) m.set(vid, sumSlots(arr, a, b));
    const t3 = top(m);
    for (const [vid] of t3.slice(0, 2)) links.push({ kind: 'vehicle', vid, label: `看 ${label(vid)}` });
    const comp = res.msgs.filter(isEvent).filter((x) => x.ev === 'fault' && x.code === 'COMP' && x.t < b && t3.some(([v]) => v === x.vid));
    return { text: `${t3.length ? `超温的车：${t3.map(([vid, v]) => `${label(vid)} ${Math.round(v)} 分钟`).join('、')}` : '有车超温'}${comp.length ? `；${comp.map((x) => `${label(x.vid)} ${clock(x.t)} 冷机压缩机故障`).join('、')}` : ''}`, links };
  }
  if (f === 'short') {
    const m = [...res.by.short.entries()].map(([fam, arr]) => [fam, sumSlots(arr, a, b)] as const).filter(([, v]) => v >= 0.5).sort((x, y) => y[1] - x[1]).slice(0, 3);
    links.push({ kind: 'facility', fac: 'store', label: `看${STORE.name}` });
    return { text: m.length ? `缺货的商品族：${m.map(([fam, v]) => `${FAMILIES.find((x) => x.key === fam)?.label ?? fam} ${Math.round(v)} 分钟`).join('、')}` : '门店有商品族缺货', links };
  }
  if (f === 'door') {
    const m = new Map<number, number>();
    for (const [vid, v] of res.by.door) {
      const op = ctx.board.ops.find((o) => o.vehicle === vid);
      if (op?.dockAt && op.dockAt[0] >= a - 3600 && op.dockAt[0] < b + 3600) m.set(vid, v);
    }
    const t3 = top(m);
    links.push({ kind: 'facility', fac: 'dc', label: '看物流园' });
    return { text: t3.length ? `等门的车：${t3.map(([vid, v]) => `${label(vid)} ${Math.round(v)} 分钟`).join('、')}` : '配送中心有车在等门', links };
  }
  if (f === 'dock') {
    const m = new Map<number, number>();
    for (const [vid, v] of res.by.dock) if (res.stops.some((s) => s.vid === vid && s.t >= a && s.t < b + 3600)) m.set(vid, v);
    const t3 = top(m);
    links.push({ kind: 'facility', fac: 'store', label: `看${STORE.name}` });
    return { text: t3.length ? `等收货口的车：${t3.map(([vid, v]) => `${label(vid)} ${Math.round(v)} 分钟`).join('、')}` : '门店收货口排了队', links };
  }
  const cmds = res.cmds.filter((c) => c.t >= a && c.t < b && (c.kind === 'rescue' || c.kind === 'restock' || c.kind === 'notifyStore'));
  const name: Record<string, string> = { rescue: '派救援车', restock: '追加补货', notifyStore: '通知门店顺延' };
  return { text: cmds.length ? `这段时间孪生的措施：${[...new Set(cmds.map((c) => name[c.kind] ?? c.kind))].join('、')}` : '这段时间有要花钱的措施', links };
}

/** 一个仓储中心的占用异常 */
function hubAnomalies(day: HubDay, t: number): Anomaly[] {
  const out: Anomaly[] = [];
  const done = Math.min(Math.floor(t / HUB_SLOT), 311);
  const fac: 'port' | 'air' | 'dc' | 'store' = day.key === 'airport' ? 'air' : day.key === 'park' ? 'dc' : day.key;
  for (const z of day.zones) {
    const occ = day.occupancy[z.key];
    if (!occ || z.capacity <= 0 || done < 1) continue;
    const util = Array.from(occ.slice(0, done), (v) => v / z.capacity);
    // 超过 85% 的时段
    const hi = util.map((u, i) => ({ i, u })).filter((x) => x.u >= 0.85);
    for (const r of runs(hi)) {
      const a = (r[0] as { i: number }).i * HUB_SLOT;
      const b = ((r[r.length - 1] as { i: number }).i + 1) * HUB_SLOT;
      const peak = Math.max(...r.map((x) => x.u));
      const before = util.slice(Math.max(0, (r[0] as { i: number }).i - 36), (r[0] as { i: number }).i);
      const entering = day.flows.filter((f) => f.steps.some((s) => s.zone === z.key && s.t0 >= a - 1800 && s.t0 < b));
      const by = new Map<string, number>();
      for (const f of entering) by.set(f.carrierIn ?? f.label, (by.get(f.carrierIn ?? f.label) ?? 0) + f.units);
      const topIn = [...by.entries()].sort((x, y) => y[1] - x[1]).slice(0, 2);
      out.push({
        key: `hub:${day.key}:${z.key}:${a}`,
        source: 'hub',
        label: `${day.label} · ${z.label}占用`,
        t0: a,
        t1: b,
        value: peak * 100,
        baseline: median(before) * 100,
        z: NaN,
        unit: '%',
        severity: peak >= 0.95 ? '高' : '中',
        cause: `最高到容量（${z.capacity} ${z.unit}）的 ${Math.round(peak * 100)}%${topIn.length ? `；这段时间进来的主要是 ${topIn.map(([k, v]) => `${k}（${Math.round(v)} ${z.unit}）`).join('、')}` : ''}`,
        links: [{ kind: 'facility', fac, label: `看${day.label}` }, { kind: 'time', t: a, label: `跳到 ${clock(a)}` }],
      });
    }
    // 15 分钟里突然涨了容量的 15% 以上
    const q: number[] = [];
    for (let k = 0; k + 3 <= done; k += 3) q.push(((occ[k] as number) + (occ[k + 1] as number) + (occ[k + 2] as number)) / 3);
    const diff = q.map((v, i) => (i ? v - (q[i - 1] as number) : 0));
    for (const r of runs(detectUp(diff, 0.15 * z.capacity, 4))) {
      const a = (r[0] as { i: number }).i * BUCKET;
      const b = ((r[r.length - 1] as { i: number }).i + 1) * BUCKET;
      if (out.some((x) => x.label.endsWith(`${z.label}占用`) && x.t0 <= b && x.t1 >= a)) continue;
      const peak = Math.max(...r.map((x) => x.z));
      out.push({ key: `hubjump:${day.key}:${z.key}:${a}`, source: 'hub', label: `${day.label} · ${z.label}突然变多`, t0: a, t1: b, value: r.reduce((s, x) => s + (diff[x.i] as number), 0), baseline: (r[0] as { base: number }).base, z: peak, unit: z.unit, severity: peak >= 6 ? '高' : '中', cause: `15 分钟里多了 ${Math.round(r.reduce((s, x) => s + (diff[x.i] as number), 0))} ${z.unit}（容量 ${z.capacity}）`, links: [{ kind: 'facility', fac, label: `看${day.label}` }] });
    }
  }
  return out;
}

/** 此刻以前的异常（最多 10 条，严重的、最近的在前）；hub 给了就只看那个仓储中心 */
export function detectAnomalies(ctx: AssistCtx, hub?: HubKey): Anomaly[] {
  const t = ctx.t;
  const out: Anomaly[] = [];
  const res = ctx.twin?.result;
  if (res && !hub) {
    const nb = Math.floor(t / BUCKET);
    const cums = Array.from({ length: nb + 1 }, (_, b) => cumAt(res.series, b * BUCKET));
    for (const f of FIELDS) {
      const inc = Array.from({ length: nb }, (_, b) => (cums[b + 1] as KpiPoint)[f.key] - (cums[b] as KpiPoint)[f.key]);
      for (const r of runs(detectUp(inc, f.minDev))) {
        const a = (r[0] as { i: number }).i * BUCKET;
        const b = ((r[r.length - 1] as { i: number }).i + 1) * BUCKET;
        const value = r.reduce((s, x) => s + (inc[x.i] as number), 0);
        const base = r.reduce((s, x) => s + x.base, 0);
        const z = Math.max(...r.map((x) => x.z));
        const c = kpiCause(ctx, res, f.key, a, b);
        out.push({ key: `kpi:${f.key}:${a}`, source: 'kpi', label: f.label, t0: a, t1: b, value, baseline: base, z, unit: f.unit, severity: z >= 6 || value >= 3 * f.minDev ? '高' : '中', cause: c.text, links: c.links });
      }
    }
    // 孪生的到店预测误差（每小时）
    const fs = res.fidelitySeries.filter((x) => x.t <= t && Number.isFinite(x.eta));
    for (const r of runs(detectUp(fs.map((x) => x.eta), 5, 3))) {
      const first = fs[(r[0] as { i: number }).i] as { t: number; eta: number };
      const lastP = fs[(r[r.length - 1] as { i: number }).i] as { t: number; eta: number };
      const z = Math.max(...r.map((x) => x.z));
      out.push({ key: `fid:${first.t}`, source: 'fidelity', label: '孪生的到店预测误差', t0: first.t - 3600, t1: lastP.t, value: lastP.eta, baseline: (r[0] as { base: number }).base, z, unit: '分钟', severity: z >= 6 ? '高' : '中', cause: `提前一小时估计到店时刻的平均误差升到 ${lastP.eta.toFixed(1)} 分钟：常见原因是路况突变、车辆故障，或者数据通道丢点、晚到`, links: [{ kind: 'time', t: first.t, label: `跳到 ${clock(first.t)}` }] });
    }
  }
  for (const d of ctx.hubs?.() ?? []) if (!hub || d.key === hub) out.push(...hubAnomalies(d, t));
  if (!hub)
    for (const a of ctx.alerts?.() ?? []) out.push({ key: `board:${a.label}`, source: 'board', label: `分层看板 · ${a.label}`, t0: a.since, t1: t, value: NaN, baseline: NaN, z: NaN, unit: '', severity: a.state === 'alarm' ? '高' : '中', cause: `${a.level}层${a.state === 'alarm' ? '告警' : '注意'}，${clock(a.since)} 起，归${a.owner}`, links: [] });
  return out.filter((x) => x.t1 <= t + 1 || x.source === 'board').sort((a, b) => (a.severity === b.severity ? b.t1 - a.t1 : a.severity === '高' ? -1 : 1)).slice(0, 10);
}
