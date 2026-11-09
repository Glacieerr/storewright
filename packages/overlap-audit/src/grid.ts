import type { AABB } from './geom';

/**
 * Uniform-grid broad phase: every box is registered in each cell its bounds touch, so a pair can only overlap if it shares a
 * cell. The result is exact (no pair whose bounds intersect is missed), whatever the cell size; the cell size only changes speed.
 * Pairs come out ordered by the first index, then the second (i < j), which keeps reports stable.
 * 均匀网格粗筛：每个包围盒登记进它碰到的每一格，共用一格的两两才可能重叠；结果是精确的（格子大小只影响快慢）。
 * 输出按 (i, j)、i < j 从小到大，报告的顺序稳定。
 */
export function forEachCandidatePair(boxes: readonly AABB[], cell: number, fn: (i: number, j: number) => void): void {
  if (!(cell > 0)) throw new RangeError('cell must be a positive number');
  const grid = new Map<string, number[]>();
  const cellsOf: string[][] = boxes.map((b, i) => {
    const out: string[] = [];
    const x0 = Math.floor(b.minX / cell);
    const x1 = Math.floor(b.maxX / cell);
    const z0 = Math.floor(b.minZ / cell);
    const z1 = Math.floor(b.maxZ / cell);
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) {
        const k = `${x},${z}`;
        out.push(k);
        const list = grid.get(k);
        if (list) list.push(i);
        else grid.set(k, [i]);
      }
    return out;
  });
  const seen = new Set<number>();
  const cand: number[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i] as AABB;
    seen.clear();
    cand.length = 0;
    for (const k of cellsOf[i] as string[])
      for (const j of grid.get(k) as number[]) {
        if (j <= i || seen.has(j)) continue;
        seen.add(j);
        cand.push(j);
      }
    cand.sort((x, y) => x - y);
    for (const j of cand) {
      const b = boxes[j] as AABB;
      if (a.maxX < b.minX || b.maxX < a.minX || a.maxZ < b.minZ || b.maxZ < a.minZ) continue;
      fn(i, j);
    }
  }
}

/** All candidate pairs as an array (convenience wrapper). 全部候选对（数组）。 */
export function candidatePairs(boxes: readonly AABB[], cell: number): [number, number][] {
  const out: [number, number][] = [];
  forEachCandidatePair(boxes, cell, (i, j) => out.push([i, j]));
  return out;
}
