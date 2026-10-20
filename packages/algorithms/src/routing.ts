import type { StoreModel } from '@storewright/store-config';

export interface RouteResult {
  /** 访问顺序（不含起点和终点） */
  order: number[];
  distanceM: number;
}

function routeLength(model: StoreModel, start: number, seq: readonly number[], end: number): number {
  let d = 0;
  let prev = start;
  for (const n of seq) {
    d += model.distance(prev, n);
    prev = n;
  }
  return d + model.distance(prev, end);
}

/**
 * 在门店行走网络上求一条经过所有节点的短路线（旅行商问题的启发式解）：
 * 最近邻构造 + 2-opt 改进。只在批次确定之后调用（工程约束 EC-3）。
 * 结果是确定性的：相同输入永远得到相同路线。
 */
export function routeTsp(model: StoreModel, nodes: readonly number[], start: number, end: number, maxPasses = 50): RouteResult {
  const unique = [...new Set(nodes)].sort((a, b) => a - b);
  if (unique.length === 0) return { order: [], distanceM: model.distance(start, end) };

  // 最近邻
  const remaining = new Set(unique);
  const seq: number[] = [];
  let cur = start;
  while (remaining.size) {
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (const n of remaining) {
      const d = model.distance(cur, n);
      if (d < bestD || (d === bestD && n < best)) {
        bestD = d;
        best = n;
      }
    }
    seq.push(best);
    remaining.delete(best);
    cur = best;
  }

  // 2-opt：反转一段路线，如果总长度变短就接受（只优化路线顺序，不涉及框和商品）
  const pts = [start, ...seq, end];
  const dist = (i: number, j: number) => model.distance(pts[i] as number, pts[j] as number);
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (let i = 1; i < pts.length - 2; i++) {
      for (let k = i + 1; k < pts.length - 1; k++) {
        const delta = dist(i - 1, k) + dist(i, k + 1) - dist(i - 1, i) - dist(k, k + 1);
        if (delta < -1e-6) {
          for (let a = i, b = k; a < b; a++, b--) {
            const tmp = pts[a] as number;
            pts[a] = pts[b] as number;
            pts[b] = tmp;
          }
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  const order = pts.slice(1, -1);
  return { order, distanceM: routeLength(model, start, order, end) };
}

/**
 * 基线路线：按货架通道的蛇形顺序（S 形）逐条走，代表「按类别顺序拣货」的通用做法。
 * `keys` 为每个节点的 [通道顺序, 通道内位置]。
 */
export function routeSShape(model: StoreModel, nodes: ReadonlyArray<{ node: number; runSequence: number; along: number }>, start: number, end: number): RouteResult {
  const runs = [...new Set(nodes.map((n) => n.runSequence))].sort((a, b) => a - b);
  const order: number[] = [];
  runs.forEach((run, i) => {
    const inRun = nodes.filter((n) => n.runSequence === run).sort((a, b) => (i % 2 === 0 ? a.along - b.along : b.along - a.along));
    for (const n of inRun) if (order[order.length - 1] !== n.node) order.push(n.node);
  });
  return { order, distanceM: routeLength(model, start, order, end) };
}
