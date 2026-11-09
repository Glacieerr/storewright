import { STORES } from '../region/network';
import { FAMILIES } from '../region/products';
import type { LoopResult } from '../twin/loop';
import { clock } from '../twin/twin';
import type { Cmd } from '../twin/types';

/**
 * 指令跟踪：每条发给现场的指令，下发 → 现场回执 → 完成 → 效果，一步步对上。
 *
 * 回执、完成来自现场发回的事件（司机、门店、配送中心的确认）；效果按指令的种类看现场的结果
 * （货温、等门、到店晚了多少、缺货）。只用到此刻为止发生的事：还没回执的写「等回执」，效果要等到发生以后才有。
 */
export interface TrailStep {
  t: number;
  text: string;
}
export interface Trail {
  t: number;
  kind: Cmd['kind'];
  /** 指令写成一句话 */
  text: string;
  /** 谁下发的：自动、调度员、指令接口；对应哪张建议卡 */
  by: string;
  card?: string;
  ack?: TrailStep;
  done?: TrailStep;
  effect?: string;
  /** 这条指令走完了（有效果，或者不需要回执） */
  closed: boolean;
}

export const CMD_LABEL: Record<Cmd['kind'], string> = { notifyStore: '通知门店顺延收货', resequence: '调整送货顺序', rescue: '派救援车', driverCheck: '提醒司机停车检查', setpoint: '调冷机设定温度', reassignDoor: '改月台门', restock: '追加补货', divert: '改去处', hold: '让车晚点到' };
const storeName = (k: string) => STORES.find((s) => s.key === k)?.name ?? k;
const famName = (k: string) => FAMILIES.find((f) => f.key === k)?.label ?? k;

export function cmdText(c: Cmd, labelOf: (vid: number) => string): string {
  switch (c.kind) {
    case 'notifyStore':
      return `通知${storeName(c.store)}收货顺延到 ${clock(c.until)}`;
    case 'resequence':
      return `${labelOf(c.vid)} 改送货顺序：${c.order.map(storeName).join(' → ')}`;
    case 'rescue':
      return `派救援车接 ${labelOf(c.vid)} 的货`;
    case 'driverCheck':
      return `提醒 ${labelOf(c.vid)} 的司机停车检查车门`;
    case 'setpoint':
      return `${labelOf(c.vid)} 冷机设定温度调${c.delta < 0 ? '低' : '高'} ${Math.abs(c.delta)} °C`;
    case 'reassignDoor':
      return `${labelOf(c.vid)} 改到 ${c.door} 门`;
    case 'restock':
      return `配送中心追加补货：${famName(c.fam)} ${Math.round(c.units)} 件`;
    case 'divert':
      return `${labelOf(c.vid)} 改${c.to === 'store' ? '直送门店' : '送配送中心'}`;
    case 'hold':
      return `${labelOf(c.vid)} 在路边等到 ${clock(c.until)} 再进门店`;
  }
}

/** 某辆车 T 时刻的货温（现场真值，每 5 分钟一个） */
const tempAt = (res: LoopResult, vid: number, T: number): number | undefined => {
  const a = res.temps.get(vid)?.truth;
  const v = a?.[Math.max(0, Math.floor(T / 300) - 1)];
  return v !== undefined && Number.isFinite(v) ? v : undefined;
};

export function commandTrail(res: LoopResult, now: number, labelOf: (vid: number) => string): Trail[] {
  const events = res.msgs.flatMap((m) => (m.kind === 'event' && m.t <= now ? [m] : []));
  const used = new Set<(typeof events)[number]>();
  const out: Trail[] = [];
  for (const c of res.cmds) {
    if (c.t > now) continue;
    const rec = res.recs.find((r) => r.doneAt === c.t && r.options.find((o) => o.key === r.chosen)?.cmds.some((x) => x.kind === c.kind)) ?? res.recs.find((r) => r.interim?.t === c.t);
    const by = rec ? (rec.by === 'user' ? '调度员' : '自动') : '指令接口';
    // 回执：指令之后 40 分钟内、对得上的第一条确认
    const pick = (ev: string, ok: (e: (typeof events)[number]) => boolean, within = 40 * 60) => {
      const e = events.find((x) => !used.has(x) && x.ev === ev && x.t >= c.t && x.t <= c.t + within && ok(x));
      if (e) used.add(e);
      return e ? { t: e.t, text: e.note ?? '' } : undefined;
    };
    let ack: TrailStep | undefined;
    let done: TrailStep | undefined;
    let effect: string | undefined;
    let rescueVid: number | undefined;
    switch (c.kind) {
      case 'notifyStore': {
        ack = pick('ack', (e) => e.place === c.store);
        const after = res.stops.filter((s) => s.store === c.store && s.t >= c.t && s.t <= now);
        const declined = /没法顺延/.test(ack?.text ?? '');
        if (after.length) effect = `${declined ? '门店没能顺延；' : ''}之后 ${after.length} 车次到店，${declined ? '' : '按顺延后的截止'}晚 ${Math.round(after.reduce((a, s) => a + s.late, 0))} 分钟`;
        break;
      }
      case 'rescue': {
        const e = events.find((x) => !used.has(x) && x.ev === 'ack' && x.t >= c.t && x.t <= c.t + 600 && (x.note ?? '').startsWith('救援车出发'));
        if (e) {
          used.add(e);
          ack = { t: e.t, text: e.note ?? '' };
          rescueVid = e.vid;
        }
        done = pick('done', (x) => x.vid === c.vid && (x.note ?? '').startsWith('货已转到'), 6 * 3600);
        const st = res.stops.filter((s) => s.vid === rescueVid && s.t <= now);
        if (st.length) effect = `救援车 ${clock(st[0]!.t)} 开始在门店卸货，晚 ${Math.round(st.reduce((a, s) => a + s.late, 0))} 分钟`;
        break;
      }
      case 'driverCheck':
      case 'setpoint': {
        if (c.kind === 'driverCheck') {
          ack = pick('ack', (x) => x.vid === c.vid);
          done = pick('done', (x) => x.vid === c.vid && (x.note ?? '').startsWith('司机检查'), 3 * 3600);
        }
        const T = c.t + 30 * 60;
        const a = tempAt(res, c.vid, c.t);
        const b = T <= now ? tempAt(res, c.vid, T) : undefined;
        const limit = res.temps.get(c.vid)?.limit;
        if (a !== undefined && b !== undefined) effect = `30 分钟后货温 ${b.toFixed(1)} °C（下发时 ${a.toFixed(1)} °C${limit !== undefined ? `，上限 ${limit} °C` : ''}）`;
        break;
      }
      case 'reassignDoor': {
        if (now >= c.t + 3600) effect = `这辆车全天等门 ${Math.round(res.by.door.get(c.vid) ?? 0)} 分钟`;
        break;
      }
      case 'restock': {
        ack = pick('ack', (x) => x.place === 'DC' && x.fam === c.fam);
        const a = res.by.short.get(c.fam);
        if (a && now >= c.t + 2 * 3600) {
          let s = 0;
          for (let k = Math.floor(c.t / 300); k < Math.min(a.length, Math.floor(now / 300)); k++) s += a[k] as number;
          effect = `之后到此刻缺货 ${Math.round(s)} 分钟`;
        }
        break;
      }
      case 'divert':
      case 'hold':
      case 'resequence': {
        ack = pick('ack', (x) => x.vid === c.vid);
        const st = res.stops.filter((s) => s.vid === c.vid && s.t >= c.t && s.t <= now);
        if (st.length) effect = `之后到店 ${st.length} 站，晚 ${Math.round(st.reduce((a, s) => a + s.late, 0))} 分钟`;
        break;
      }
    }
    out.push({ t: c.t, kind: c.kind, text: cmdText(c, labelOf), by, ...(rec ? { card: rec.title } : {}), ...(ack ? { ack } : {}), ...(done ? { done } : {}), ...(effect ? { effect } : {}), closed: !!effect });
  }
  return out;
}
