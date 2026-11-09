import type { Rng } from '../core/rng';
import { itemLiters, TOTE_KG, TOTE_LITERS, type Temp } from '../world/catalog';
import type { Order, OrderLine } from '../world/demand';
import type { Pt } from '../world/layout';
import { routeOrder, type Router } from '../world/path';
import type { Pool, Step } from './agents';
import type { Shelf } from './shelf';

/**
 * 卖场里的推车拣货（两代共用）：订单按温区拆成「部分」，同温区的部分装进一车（每车若干框），
 * 路线按最近邻 + 2-opt 排，逐个拣货点拣，拿的是和到店顾客共用的货架库存。
 */
export interface Part {
  order: Order;
  /** 要备好的时刻（自提是时段开始，配送是发车时刻）：决定装车顺序和优先级 */
  due: number;
  temp: Temp;
  lines: OrderLine[];
  totes: number;
  /** 拣完时调用：实拣、替代、缺货件数 */
  done: (picked: number, substituted: number, short: number) => void;
}

export interface Walk {
  temp: Temp;
  parts: Part[];
  totes: number;
  /** 最早的备好时刻（决定优先级） */
  due: number;
}

/** 框数：按体积和重量（每框不超过 15.9 公斤），日用化学品和食品分开装（上一代的装框规则） */
export function totesFor(lines: readonly OrderLine[]): number {
  const group = (ls: readonly OrderLine[]) => {
    if (!ls.length) return 0;
    let liters = 0;
    let kg = 0;
    for (const l of ls) {
      liters += itemLiters(l.sku) * l.qty;
      kg += l.sku.kg * l.qty;
    }
    return Math.max(1, Math.ceil(liters / TOTE_LITERS), Math.ceil(kg / TOTE_KG));
  };
  const chem = lines.filter((l) => l.sku.category === 'household');
  const food = lines.filter((l) => l.sku.category !== 'household');
  return Math.max(1, group(food) + group(chem));
}

/** 同温区的部分按时段先后装车，每车不超过 totesPerCart 框 */
export function planWalks(parts: readonly Part[], totesPerCart: number): Walk[] {
  const walks: Walk[] = [];
  const byTemp = new Map<Temp, Part[]>();
  for (const p of parts) {
    const list = byTemp.get(p.temp) ?? [];
    list.push(p);
    byTemp.set(p.temp, list);
  }
  for (const [temp, list] of byTemp) {
    list.sort((a, b) => a.due - b.due || firstX(a) - firstX(b));
    let cur: Walk | undefined;
    for (const p of list) {
      if (!cur || cur.totes + p.totes > totesPerCart) {
        cur = { temp, parts: [], totes: 0, due: p.due };
        walks.push(cur);
      }
      cur.parts.push(p);
      cur.totes += p.totes;
    }
  }
  return walks;
}

function firstX(p: Part): number {
  return p.lines[0]?.sku.face.x ?? 0;
}

export interface PickTimes {
  speed: number;
  perStopSec: number;
  perItemSec: number;
  /** 拣完在投放点（暂存间 / 生鲜投放口）放框的时间 */
  dropSecPerTote: number;
  dropSecPerWalk: number;
  /** 地面缺货时由拣货员替代的比例 */
  substitution: number;
  /** 地面缺货时去后仓补取（上一代的做法，本方案沿用）：回调里告诉结果 */
  retrieve?: (line: OrderLine, qty: number, done: (got: number) => void) => void;
  /** 加在优先级上的偏移（降级模式的拣货交给门店作业员时用） */
  priorityOffset?: number;
}

export interface WalkStats {
  walks: number;
  meters: number;
  items: number;
}

/** 把一车拣货交给拣货员；起点、终点都是投放点 */
export function submitWalk(pool: Pool, router: Router, shelf: Shelf, rng: Rng, walk: Walk, drop: Pt, t: PickTimes, stats: WalkStats): void {
  // 合并同一个陈列面的行
  const stops = new Map<string, { at: Pt; lines: { part: Part; line: OrderLine }[] }>();
  for (const part of walk.parts) {
    for (const line of part.lines) {
      const key = `${line.sku.face.x},${line.sku.face.y}`;
      const s = stops.get(key) ?? { at: line.sku.face, lines: [] };
      s.lines.push({ part, line });
      stops.set(key, s);
    }
  }
  const stopList = [...stops.values()];
  pool.submit({
    priority: walk.due / 60 + (t.priorityOffset ?? 0),
    label: `拣货（${walk.temp}）`,
    steps: () => {
      const route = routeOrder(router, drop, stopList.map((s) => s.at), drop);
      stats.walks++;
      stats.meters += route.meters;
      const result = new Map<Part, { picked: number; sub: number; short: number; pending: number; finished: boolean }>();
      for (const p of walk.parts) result.set(p, { picked: 0, sub: 0, short: 0, pending: 0, finished: false });
      const maybeDone = (p: Part) => {
        const r = result.get(p) as { picked: number; sub: number; short: number; pending: number; finished: boolean };
        if (r.finished && r.pending === 0) p.done(r.picked, r.sub, r.short);
      };
      const steps: Step[] = [];
      for (const idx of route.order) {
        const stop = stopList[idx] as (typeof stopList)[number];
        const items = stop.lines.reduce((s, x) => s + x.line.qty, 0);
        stats.items += items;
        steps.push({ kind: 'walk', to: stop.at, speed: t.speed, act: '拣货' });
        steps.push({ kind: 'work', sec: t.perStopSec + t.perItemSec * items, act: '拣货' });
        steps.push({
          kind: 'call',
          fn: () => {
            for (const { part, line } of stop.lines) {
              const got = shelf.take(line.sku, line.qty, 'picker');
              const r = result.get(part) as { picked: number; sub: number; short: number; pending: number; finished: boolean };
              r.picked += got;
              const miss = line.qty - got;
              if (miss <= 0) continue;
              const fallback = (n: number) => {
                if (rng.chance(t.substitution)) r.sub += n;
                else r.short += n;
              };
              if (!t.retrieve) {
                fallback(miss);
                continue;
              }
              // 去后仓补取：拿到的算实拣，拿不到的再替代或缺货
              r.pending++;
              t.retrieve(line, miss, (back) => {
                r.picked += back;
                if (miss - back > 0) fallback(miss - back);
                r.pending--;
                maybeDone(part);
              });
            }
          },
        });
      }
      steps.push({ kind: 'walk', to: drop, speed: t.speed, act: '回投放点' });
      steps.push({ kind: 'work', sec: t.dropSecPerWalk + t.dropSecPerTote * walk.totes, act: '放框' });
      steps.push({
        kind: 'call',
        fn: () => {
          for (const p of walk.parts) {
            (result.get(p) as { finished: boolean }).finished = true;
            maybeDone(p);
          }
        },
      });
      return steps;
    },
  });
}
