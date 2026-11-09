import type { WVehicle } from '../sim/trace';

/**
 * 到门店收货场的车（配送中心的车、长途直送车、面包房的车……）：按区域仿真的轨迹，每次停靠是一次访问——
 * 到收货场的时刻（行驶段结束）、靠稳开始卸货的时刻、开始拉出的时刻（停留段结束），用哪个收货口（调度台排的）。
 * 和三维收货场（web/src/three/store、yard 引擎）、门店收货区动画（ops/storeDocks.ts）用同一份。
 */
export type TruckType = 'semi' | 'reefer' | 'truck' | 'van';

export interface TruckVisit {
  vid: number;
  label: string;
  kind: string;
  type: TruckType;
  dock: number;
  /** 车在收货口的那一段停留是轨迹的第几段（收货场引擎的访问编号用它）；调度台的作业编号（没有就用车名） */
  seg: number;
  job?: string;
  /** 到收货场（进场点）、靠稳开始卸货、开始拉出（秒） */
  arrive: number;
  dockAt: number;
  leaveAt: number;
  pallets: number;
}

/** 车型（仿真的车辆类别）：truck 是常温半挂车、reefer 冷藏半挂车、ev 电动厢式货车、van 面包车 */
export function truckType(kind: string): TruckType {
  if (kind === 'reefer') return 'reefer';
  if (kind === 'ev') return 'truck';
  if (kind === 'van') return 'van';
  return 'semi';
}

/**
 * 当天到门店 store（门店编号）卸货的车：resolve 把仿真的地点换成调度台排的收货口（`S01#2` 是 2 号口），
 * typeOf 给出车型（三维按车辆的造型），palletsOf 给托盘数。
 */
export function storeTruckVisits(list: readonly WVehicle[], store: string, docks: number, resolve: (vid: number, key: string) => string | undefined, typeOf: (v: WVehicle) => TruckType = (v) => truckType(v.kind), palletsOf: (vid: number) => number | undefined = () => undefined, jobOf: (vid: number) => string | undefined = () => undefined): TruckVisit[] {
  const out: TruckVisit[] = [];
  for (const v of list) {
    v.segs.forEach((sg, si) => {
      if (!sg.place || sg.route || sg.loop) return;
      const key = resolve(v.id, sg.place) ?? sg.place;
      const [code, k] = key.split('#');
      if (code !== store || key.includes(':')) return;
      const dock = k ? Number(k) - 1 : 0;
      if (dock < 0 || dock >= docks) return;
      const prev = v.segs[si - 1];
      const dur = sg.t1 - sg.t0;
      // 靠台用时：和三维、收货区动画一样，最多 100 秒、不超过停留的 35%（一开始就停在这里的车已经靠好）
      const back = prev && (prev.route || prev.pts.length > 2) ? Math.min(100, dur * 0.35) : 0;
      const job = jobOf(v.id);
      out.push({ vid: v.id, label: v.label, kind: v.kind, type: typeOf(v), dock, seg: si, ...(job ? { job } : {}), arrive: sg.t0, dockAt: sg.t0 + back, leaveAt: sg.t1, pallets: Math.max(2, Math.min(26, Math.round(palletsOf(v.id) ?? 10))) });
    });
  }
  return out.sort((a, b) => a.arrive - b.arrive || a.vid - b.vid);
}

/**
 * 调度台的作业 → 作业编号：一辆车一天可能跑几趟，按到店的时刻挑最近的那一趟（值班助手按编号把排队接到那一趟车上）。
 */
export function jobFromBoard(ops: ReadonlyArray<{ id: string; vehicle: number; stops?: ReadonlyArray<{ key: string; arrive: number }> }>, store: string): (vid: number, arrive: number) => string | undefined {
  return (vid, arrive) => {
    let best: string | undefined;
    let bd = Infinity;
    for (const o of ops) {
      if (o.vehicle !== vid) continue;
      for (const st of o.stops ?? []) {
        if (st.key !== store) continue;
        const d = Math.abs(st.arrive - arrive);
        if (d < bd) {
          bd = d;
          best = o.id;
        }
      }
    }
    return best;
  };
}

/** 进场靠台、拉出驶离的用时（秒，按车型；第一部分决策记录 0018 的假设） */
export const YARD_TIMES: Record<TruckType, { enter: number; prep: number; exit: number }> = {
  semi: { enter: 240, prep: 180, exit: 150 },
  reefer: { enter: 240, prep: 180, exit: 150 },
  truck: { enter: 150, prep: 120, exit: 90 },
  van: { enter: 100, prep: 60, exit: 75 },
};

export interface TruckTurn {
  visit: TruckVisit;
  /** 在待命车位排队的时段（没排队时两个时刻相等）、占着收货口的时段（开始倒车到拉出离开门口） */
  queue: [number, number];
  door: [number, number];
  /** 离开收货场的时刻 */
  gone: number;
}

/**
 * 收货场的先到先进：同一个收货口前一辆没拉走，后一辆在待命车位等；场地里同一时间只让一辆车调车（进场倒车或拉出驶离），驶离优先。
 * 仿真给的靠稳时刻是最早能开始卸货的时刻：门空着就按它，门占着就推后（三维的收货场引擎按同样的规则排）。
 */
export function yardTurns(visits: readonly TruckVisit[]): TruckTurn[] {
  const doorFree = new Map<number, number>();
  /** 场地里有车在调车的时段 */
  const busy: Array<[number, number]> = [];
  const clear = (t: number, d: number) => {
    let x = t;
    for (let guard = 0; guard < 50; guard++) {
      const hit = busy.find(([a, b]) => a < x + d && x < b);
      if (!hit) return x;
      x = hit[1];
    }
    return x;
  };
  const out: TruckTurn[] = [];
  for (const v of [...visits].sort((a, b) => a.arrive - b.arrive || a.vid - b.vid)) {
    const T = YARD_TIMES[v.type];
    const enter = Math.min(T.enter, Math.max(40, v.dockAt - v.arrive));
    // 最早开始进场调车：门空出来（前一辆拉出离开门口）、场地里没有别的车在调车
    const start = clear(Math.max(v.dockAt - enter, doorFree.get(v.dock) ?? -Infinity, v.arrive), enter);
    busy.push([start, start + enter]);
    const docked = start + enter;
    const unload = Math.max(120, v.leaveAt - v.dockAt);
    const leave = clear(Math.max(v.leaveAt, docked + unload), T.exit);
    busy.push([leave, leave + T.exit]);
    const gone = leave + T.exit;
    doorFree.set(v.dock, leave + T.exit * 0.4);
    out.push({ visit: v, queue: [v.arrive, start], door: [start, leave + T.exit * 0.4], gone });
  }
  return out;
}
