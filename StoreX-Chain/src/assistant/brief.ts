import { STORE } from '../region/network';
import type { Issue } from '../sim/board';
import { clock, sumScore } from '../twin/twin';
import { ISSUE_LABEL, type Option, type Rec } from '../twin/types';
import { soldOutAt } from './context';
import type { AssistCtx, Link, Proposal } from './types';

/**
 * 「此刻要关注」：把待处理的建议卡、晚点和超温的车、调度台接下来两小时的问题、路况、快卖空的商品族、设施的异常指标
 * 排成一张短清单（紧急的在前，同样紧急的先发生的在前），能处理的附带提议。
 */
export const statusAt = (r: Rec, t: number): Rec['status'] => (r.doneAt !== undefined && r.doneAt <= t ? r.status : 'proposed');

/** 此刻还待处理的建议卡（按出卡时刻） */
export const pendingCards = (ctx: AssistCtx): Rec[] => (ctx.twin?.recs ?? []).filter((r) => r.t <= ctx.t && statusAt(r, ctx.t) === 'proposed');

/** 「不处理」的那个做法（等修好、等这樘门、接受） */
export const noAction = (r: Rec): Option | undefined => r.options.find((o) => o.key === 'accept') ?? r.options.find((o) => o.key === 'wait') ?? r.options.find((o) => !o.cmds.length);

const n0 = (x: number) => Math.round(x).toLocaleString('en-US');

/** 一个做法的推演结果写成一句话 */
export function outcome(o: Option): string {
  const parts: string[] = [];
  if (o.late >= 0.5) parts.push(`迟到 ${n0(o.late)} 分钟`);
  if (o.hot >= 0.5) parts.push(`超温 ${n0(o.hot)} 分钟`);
  if (o.short >= 0.5) parts.push(`缺货 ${n0(o.short)} 分钟`);
  if (o.cost >= 0.5) parts.push(`多花 $${n0(o.cost)}`);
  return parts.length ? parts.join('、') : '没有影响';
}

let seq = 0;
/** 对建议卡做决定的提议（执行某个做法，或者否决） */
export function cardProposal(r: Rec, optionKey?: string, reject = false): Proposal {
  const best = r.options[r.best] as Option;
  if (reject) {
    const none = noAction(r);
    return {
      id: `p${++seq}`,
      title: `否决「${r.title}」`,
      effect: none ? `不处理的推演结果：${outcome(none)}（推荐的「${best.label}」：${outcome(best)}）` : '否决后孪生不再为这个问题出建议',
      actions: [{ kind: 'decide', key: r.key, action: 'reject' }],
      risk: 'low',
      cost: 0,
    };
  }
  const o = r.options.find((x) => x.key === optionKey) ?? best;
  const none = noAction(r);
  const vs = none && none !== o ? `；不处理的话${outcome(none)}` : '';
  return {
    id: `p${++seq}`,
    title: o.cmds.length ? `执行「${o.label}」（${r.title}）` : `确认「${o.label}」，不发指令（${r.title}）`,
    effect: `推演结果：${outcome(o)}${vs}。${o.note}`,
    actions: [{ kind: 'decide', key: r.key, action: 'approve', option: o.key }],
    risk: o.auto ? 'low' : 'high',
    cost: o.cost,
  };
}

/** 套用调度台给出的修法 */
export function fixProposal(i: Issue): Proposal | undefined {
  if (!i.fix || i.code === 'wait') return undefined;
  const rerun = i.fix.kind === 'depart' || i.fix.kind === 'arrive';
  return { id: `p${++seq}`, title: i.fix.text, effect: `${i.title}：${i.text}${rerun ? '（改时刻要重新仿真，约几秒）' : ''}`, actions: [{ kind: 'fix', fix: i.fix }], risk: rerun ? 'high' : 'low', cost: 0 };
}

export interface WatchItem {
  key: string;
  /** 3 紧急、2 重要、1 留意 */
  level: 1 | 2 | 3;
  text: string;
  /** 多久以后会发生（秒；正在发生是 0） */
  due: number;
  links: Link[];
  proposal?: Proposal;
}

const LEVEL_OF: Record<Rec['kind'], 1 | 2 | 3> = { breakdown: 3, temp: 3, late: 2, stockout: 2, dock: 2, door: 1 };

export function watchList(ctx: AssistCtx, limit = 8): WatchItem[] {
  const t = ctx.t;
  const out: WatchItem[] = [];
  const covered = new Set<number>();
  // —— 待处理的建议卡 ——
  for (const r of pendingCards(ctx)) {
    const best = r.options[r.best] as Option;
    const none = noAction(r);
    const save = none && none !== best ? sumScore(none) - sumScore(best) : 0;
    const links: Link[] = [{ kind: 'card', key: r.key, label: `看建议卡：${r.title.length > 14 ? `${r.title.slice(0, 14)}…` : r.title}` }];
    if (r.vid !== undefined) {
      links.push({ kind: 'vehicle', vid: r.vid, label: `看 ${ctx.rows.find((v) => v.vid === r.vid)?.id ?? '车'}` });
      covered.add(r.vid);
    }
    const text = `${ISSUE_LABEL[r.kind]}：${r.title}。${best.cmds.length ? `推荐「${best.label}」` : '推荐不处理'}${save > 1 ? `，合计分少 ${n0(save)}` : ''}`;
    out.push({ key: `card:${r.key}`, level: r.kind === 'door' && (none?.late ?? 0) >= 15 ? 2 : LEVEL_OF[r.kind], text, due: 0, links, proposal: cardProposal(r) });
  }
  // —— 晚点、超温的车（已经有建议卡的不重复列） ——
  for (const v of ctx.rows) {
    if (covered.has(v.vid) || (v.status !== 'moving' && v.status !== 'working')) continue;
    if (v.temp && v.temp.value > v.temp.limit) out.push({ key: `temp:${v.vid}`, level: 3, text: `${v.id} 货温 ${v.temp.value.toFixed(1)} °C，超过 ${v.temp.limit} °C（${v.act}）`, due: 0, links: [{ kind: 'vehicle', vid: v.vid, label: `看 ${v.id}` }] });
    else if ((v.delayMin ?? 0) >= 10) {
      const eta = v.nextEta ?? v.nextPlan;
      out.push({ key: `late:${v.vid}`, level: (v.delayMin ?? 0) >= 20 ? 2 : 1, text: `${v.id} 晚了 ${v.delayMin} 分钟，${v.next ? `下一站${v.next}${eta !== undefined ? `，预计 ${clock(eta)} 到` : ''}` : v.act}`, due: 0, links: [{ kind: 'vehicle', vid: v.vid, label: `看 ${v.id}` }] });
    }
  }
  // —— 调度台接下来两小时的问题 ——
  for (const i of ctx.board.issues) {
    if (i.code === 'wait' || i.at < t - 600 || i.at > t + 2 * 3600) continue;
    if (i.level === 'info') continue;
    const fix = fixProposal(i);
    const op = ctx.board.byId.get(i.ops[0] as string);
    const links: Link[] = [{ kind: 'time', t: i.at, label: `跳到 ${clock(i.at)}` }];
    if (op) links.push({ kind: 'op', id: op.id, label: `看 ${op.id}` });
    out.push({ key: `issue:${i.code}:${i.ops.join(',')}:${i.at}`, level: i.level === 'error' ? 2 : 1, text: `${clock(i.at)} ${i.title}：${i.text}`, due: Math.max(0, i.at - t), links, ...(fix ? { proposal: fix } : {}) });
  }
  // —— 路况 ——
  for (const x of ctx.twin?.incidents ?? []) {
    if (x.t0 > t || x.t1 <= t) continue;
    // f 是慢了几倍：慢一倍半以上的算重要
    out.push({ key: `inc:${x.id}`, level: x.f >= 2.5 ? 2 : 1, text: `路况：${x.text}，到 ${clock(x.t1)} 左右`, due: 0, links: [] });
  }
  // —— 快卖空的商品族（已经有缺货建议卡的不重复列；门店营业时段才算） ——
  const cardFams = new Set(pendingCards(ctx).filter((r) => r.kind === 'stockout').map((r) => r.key.split(':')[1]));
  if (t >= 7 * 3600 && t < 21 * 3600)
    for (const s of ctx.twin?.stock ?? []) {
      if (cardFams.has(s.fam)) continue;
      const have = s.est ?? s.units;
      const at = soldOutAt(have, s.daily, t);
      if (at !== undefined && at < t + 2 * 3600) out.push({ key: `stock:${s.fam}`, level: 2, text: `${s.label}按每小时的卖货曲线约 ${clock(at)} 卖空（孪生估计还有 ${n0(have)} 件）`, due: at - t, links: [{ kind: 'facility', fac: 'store', label: `看${STORE.name}` }] });
    }
  // —— 设施的异常指标 ——
  const fac = ctx.fac?.() ?? {};
  for (const f of Object.values(fac)) {
    if (!f) continue;
    for (const k of f.kpi)
      if (k.bad) out.push({ key: `fac:${f.key}:${k.label}`, level: 1, text: `${f.name}：${k.label} ${k.value}`, due: 0, links: [{ kind: 'facility', fac: f.key === 'airport' ? 'air' : f.key, label: `看${f.name}` }] });
  }
  return out.sort((a, b) => b.level - a.level || a.due - b.due).slice(0, limit);
}
