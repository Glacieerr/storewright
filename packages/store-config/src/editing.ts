import type { RunConfig, StoreConfig } from './schema';

/**
 * 布局编辑的几何操作（模拟器编辑器使用；纯函数，直接修改传入的草稿配置）。
 *
 * 行走线段 = 同一楼层的货架通道中线 + 走廊。通道只有端点落在别的行走线段上才连得进行走网络，
 * 所以新画、旋转、移动、粘贴的通道都会把两端吸附到附近与它垂直的行走线段上：
 * - 端点离垂直线段不超过 EDIT_SNAP_M 时吸附过去；
 * - 两端都没吸附上时，沿通道方向向外各找一条最近的线段（不超过 EDIT_EXTEND_M）延伸过去；
 * - 还是接不上就返回原因，由编辑器提示，不写入草稿。
 * 只处理横平竖直的通道（与模板一致）。
 */

export const EDIT_BAY_M = 1.22;
export const EDIT_SNAP_M = 3;
export const EDIT_EXTEND_M = 12;
export const EDIT_MIN_LEN_M = 4;
/** 点一下（几乎没拖动）时，向两端延伸到走廊的最远距离 */
const CLICK_EXTEND_M = 80;
const TOL = 0.05;

/** V：沿配置 y（场景里的前后方向）；H：沿 x（左右方向）；D：斜线（不参与吸附） */
export type Axis = 'V' | 'H';

export interface WalkSeg {
  id: string;
  axis: Axis | 'D';
  /** V 线段的 x，H 线段的 y */
  c: number;
  lo: number;
  hi: number;
}

export interface SnapResult {
  axis: Axis;
  c: number;
  a: number;
  b: number;
  /** 两端是否接到了行走线段上 */
  connected: [boolean, boolean];
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

export function axisOf(s: { start: { x: number; y: number }; end: { x: number; y: number } }): Axis | 'D' {
  if (Math.abs(s.end.x - s.start.x) < 1e-6) return 'V';
  if (Math.abs(s.end.y - s.start.y) < 1e-6) return 'H';
  return 'D';
}

function toSeg(id: string, s: { start: { x: number; y: number }; end: { x: number; y: number } }): WalkSeg {
  const axis = axisOf(s);
  if (axis === 'V') return { id, axis, c: s.start.x, lo: Math.min(s.start.y, s.end.y), hi: Math.max(s.start.y, s.end.y) };
  if (axis === 'H') return { id, axis, c: s.start.y, lo: Math.min(s.start.x, s.end.x), hi: Math.max(s.start.x, s.end.x) };
  return { id, axis, c: 0, lo: 0, hi: 0 };
}

/** 某层所有行走线段（可排除正在编辑的通道） */
export function walkSegments(cfg: StoreConfig, floorId: string, exclude?: ReadonlySet<string>): WalkSeg[] {
  const out: WalkSeg[] = [];
  for (const r of cfg.layout.runs) if (r.floorId === floorId && !exclude?.has(r.id)) out.push(toSeg(r.id, r));
  for (const c of cfg.layout.corridors) if (c.floorId === floorId && !exclude?.has(c.id)) out.push(toSeg(c.id, c));
  return out;
}

/** 通道的轴向、位置与范围 */
export function runSpan(r: RunConfig): { axis: Axis | 'D'; c: number; a: number; b: number } {
  const s = toSeg(r.id, r);
  return { axis: s.axis, c: s.c, a: s.lo, b: s.hi };
}

/**
 * 把沿 axis、位于 c、范围 [a, b] 的线段两端吸附到垂直的行走线段上。
 * extend 为两端都没吸附上时向外延伸的最远距离。
 */
export function snapEnds(cfg: StoreConfig, floorId: string, axis: Axis, c: number, a: number, b: number, exclude?: ReadonlySet<string>, extend = EDIT_EXTEND_M): SnapResult {
  const perp = walkSegments(cfg, floorId, exclude)
    .filter((s) => s.axis === (axis === 'V' ? 'H' : 'V') && c >= s.lo - TOL && c <= s.hi + TOL)
    .map((s) => s.c);
  let lo = Math.min(a, b);
  let hi = Math.max(a, b);
  const nearest = (v: number, max: number, side: -1 | 0 | 1, not?: number): number | undefined => {
    let best: number | undefined;
    let bd = max + 1e-9;
    for (const p of perp) {
      if (not !== undefined && Math.abs(p - not) < TOL) continue;
      if (side < 0 && p > v + TOL) continue;
      if (side > 0 && p < v - TOL) continue;
      const d = Math.abs(p - v);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  };
  let sa = nearest(lo, EDIT_SNAP_M, 0);
  let sb = nearest(hi, EDIT_SNAP_M, 0, sa);
  if (sa !== undefined && sb !== undefined && sb < sa) [sa, sb] = [sb, sa];
  // 两端吸到同一条线段（画得很短）：只保留近的一端
  if (sa === undefined && sb === undefined) {
    sa = nearest(lo, extend, -1);
    sb = nearest(hi, extend, 1, sa);
  }
  if (sa !== undefined) lo = sa;
  if (sb !== undefined) hi = sb;
  return { axis, c: r2(c), a: r2(lo), b: r2(hi), connected: [sa !== undefined, sb !== undefined] };
}

function applySpan(r: RunConfig, s: { axis: Axis; c: number; a: number; b: number }): void {
  const before = Math.hypot(r.end.x - r.start.x, r.end.y - r.start.y);
  if (s.axis === 'V') {
    r.start = { x: s.c, y: s.a };
    r.end = { x: s.c, y: s.b };
  } else {
    r.start = { x: s.a, y: s.c };
    r.end = { x: s.b, y: s.c };
  }
  const len = s.b - s.a;
  // 长度变了就按新长度重排货架段（段宽与模板一致）
  if (Math.abs(len - before) > TOL) r.bays = Math.max(1, Math.floor((len - 2 * r.endMarginM) / EDIT_BAY_M));
}

/** 下一个通道编号（同层 A01、A02…） */
export function nextRunId(cfg: StoreConfig, floorId: string): { id: string; n: number } {
  let n = 0;
  for (const r of cfg.layout.runs) {
    const m = r.id.match(/-A(\d+)/);
    if (r.floorId === floorId && m) n = Math.max(n, Number(m[1]));
  }
  n += 1;
  let id = `${floorId}-A${String(n).padStart(2, '0')}`;
  while (cfg.layout.runs.some((r) => r.id === id)) id += 'b';
  return { id, n };
}

/** 同一楼层的通道按位置重新编号蛇形顺序 */
export function renumberRuns(cfg: StoreConfig): void {
  let seq = 0;
  for (const f of [...cfg.layout.floors].sort((a, b) => a.level - b.level)) {
    const runs = cfg.layout.runs.filter((r) => r.floorId === f.id);
    runs.sort((a, b) => (a.start.x + a.end.x) / 2 - (b.start.x + b.end.x) / 2 || (a.start.y + a.end.y) / 2 - (b.start.y + b.end.y) / 2);
    for (const r of runs) r.sequence = seq++;
  }
}

export interface DrawResult {
  snap: SnapResult;
  run?: RunConfig;
  reason?: string;
}

/**
 * 从 p 拖到 q 画一条通道（配置坐标，y 为前后方向）。主方向决定横竖；几乎没拖动时视为点一下，
 * 在该处放一条竖向通道并延伸到前后走廊。base 提供温区、层数、类别等默认值。
 */
export function planRun(cfg: StoreConfig, floorId: string, p: { x: number; y: number }, q: { x: number; y: number }, base?: Partial<RunConfig>): DrawResult {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const click = Math.hypot(dx, dy) < 1;
  const axis: Axis = click || Math.abs(dy) >= Math.abs(dx) ? 'V' : 'H';
  const c = r1(axis === 'V' ? p.x : p.y);
  const a = axis === 'V' ? p.y : p.x;
  const b = click ? a : axis === 'V' ? q.y : q.x;
  const snap = snapEnds(cfg, floorId, axis, c, a, b, undefined, click ? CLICK_EXTEND_M : EDIT_EXTEND_M);
  if (!snap.connected[0] && !snap.connected[1]) return { snap, reason: '通道两端都没有接到走廊或其他通道上，拣货员走不进去' };
  if (snap.b - snap.a < EDIT_MIN_LEN_M) return { snap, reason: `通道太短（至少 ${EDIT_MIN_LEN_M} 米）` };
  const { id, n } = nextRunId(cfg, floorId);
  const margin = base?.endMarginM ?? 1.5;
  const run: RunConfig = {
    id,
    floorId,
    kind: 'AISLE',
    label: `Aisle ${n}`,
    start: { x: 0, y: 0 },
    end: { x: 0, y: 0 },
    sides: base?.sides ?? 2,
    bays: 1,
    levels: base?.levels ?? 5,
    endMarginM: margin,
    tempZone: base?.tempZone ?? 'AMBIENT',
    categoryIds: [...(base?.categoryIds ?? [])],
    sequence: 0,
  };
  applySpan(run, snap);
  run.bays = Math.max(1, Math.floor((snap.b - snap.a - 2 * margin) / EDIT_BAY_M));
  return { snap, run };
}

/** 画一条通道并写入草稿；成功返回新通道 id */
export function addRun(cfg: StoreConfig, floorId: string, p: { x: number; y: number }, q: { x: number; y: number }, base?: Partial<RunConfig>): { id?: string; reason?: string } {
  const plan = planRun(cfg, floorId, p, q, base);
  if (!plan.run) return { reason: plan.reason };
  cfg.layout.runs.push(plan.run);
  renumberRuns(cfg);
  return { id: plan.run.id };
}

/** 绕中心旋转 90°（横竖互换），两端重新吸附；接不上时不修改并返回原因 */
export function rotateRun(cfg: StoreConfig, id: string): string | undefined {
  const r = cfg.layout.runs.find((x) => x.id === id);
  if (!r) return '找不到这条通道';
  const s = runSpan(r);
  if (s.axis === 'D') return '只能旋转横平竖直的通道';
  const len = s.b - s.a;
  const mid = (s.a + s.b) / 2;
  const axis: Axis = s.axis === 'V' ? 'H' : 'V';
  // 原来的位置 c 变成新方向上的中点，原来的中点变成新位置
  const snap = snapEnds(cfg, r.floorId, axis, r1(mid), s.c - len / 2, s.c + len / 2, new Set([id]));
  if (!snap.connected[0] && !snap.connected[1]) return '旋转后两端都接不到走廊或其他通道上';
  applySpan(r, snap);
  renumberRuns(cfg);
  return undefined;
}

/**
 * 成组移动通道（配置坐标位移 dx、dy），每条通道移动后重新吸附两端。
 * 一起移动的通道之间按移动后的位置互相吸附；吸附不上的端点保持原样（交给校验提示）。
 */
export function moveRuns(cfg: StoreConfig, ids: readonly string[], dx: number, dy: number): void {
  const set = new Set(ids);
  const moving = cfg.layout.runs.filter((r) => set.has(r.id));
  for (const r of moving) {
    r.start = { x: r2(r.start.x + dx), y: r2(r.start.y + dy) };
    r.end = { x: r2(r.end.x + dx), y: r2(r.end.y + dy) };
  }
  for (const r of moving) {
    const s = runSpan(r);
    if (s.axis === 'D') continue;
    const snap = snapEnds(cfg, r.floorId, s.axis, s.c, s.a, s.b, new Set([r.id]), 0);
    if (snap.connected[0] || snap.connected[1]) applySpan(r, snap);
  }
  renumberRuns(cfg);
}

/** 粘贴通道副本到 floorId（可与原楼层不同），偏移 dx、dy；返回新通道 id */
export function pasteRuns(cfg: StoreConfig, runs: readonly RunConfig[], floorId: string, dx: number, dy: number): string[] {
  const ids: string[] = [];
  for (const src of runs) {
    const { id } = nextRunId(cfg, floorId);
    cfg.layout.runs.push({
      ...src,
      id,
      floorId,
      label: `${src.label ?? src.id} 副本`,
      start: { ...src.start },
      end: { ...src.end },
      categoryIds: [...src.categoryIds],
    });
    ids.push(id);
  }
  moveRuns(cfg, ids, dx, dy);
  return ids;
}

/** 选中的同向通道等距排开（首尾不动）；返回原因表示不能操作 */
export function distributeRuns(cfg: StoreConfig, ids: readonly string[]): string | undefined {
  const runs = cfg.layout.runs.filter((r) => ids.includes(r.id));
  if (runs.length < 3) return '至少选中 3 条通道';
  const axes = new Set(runs.map((r) => runSpan(r).axis));
  if (axes.size !== 1 || axes.has('D')) return '只能排列同一方向的通道';
  const sorted = runs.map((r) => ({ r, c: runSpan(r).c })).sort((p, q) => p.c - q.c);
  const first = (sorted[0] as { c: number }).c;
  const step = ((sorted[sorted.length - 1] as { c: number }).c - first) / (sorted.length - 1);
  sorted.forEach(({ r }, i) => {
    const d = r2(first + step * i) - runSpan(r).c;
    if (Math.abs(d) < 1e-6) return;
    if (axes.has('V')) {
      r.start.x = r2(r.start.x + d);
      r.end.x = r2(r.end.x + d);
    } else {
      r.start.y = r2(r.start.y + d);
      r.end.y = r2(r.end.y + d);
    }
  });
  renumberRuns(cfg);
  return undefined;
}

/** 货架占地矩形（通道中线两侧各 1.5 米；单侧货架 0.9 米），不含两端转弯留空 */
export function shelfRect(r: RunConfig): { x0: number; x1: number; y0: number; y1: number } | undefined {
  const s = runSpan(r);
  if (s.axis === 'D') return undefined;
  const ext = r.sides === 2 ? 1.5 : 0.9;
  const m = Math.min(r.endMarginM, (s.b - s.a) / 4);
  if (s.axis === 'V') return { x0: s.c - ext, x1: s.c + ext, y0: s.a + m, y1: s.b - m };
  return { x0: s.a + m, x1: s.b - m, y0: s.c - ext, y1: s.c + ext };
}

/**
 * 线上订单暂存区占地（与模拟器的暂存货架摆放一致）：从暂存点向店内排成每列 8 个货架的若干列。
 */
export const STAGING_PER_COLUMN = 8;
export const STAGING_COL_PITCH = 3.6;
export const STAGING_ROW_PITCH = 1.7;

export function stagingRackLength(slotsPerLevel: number): number {
  return Math.max(1.6, slotsPerLevel * 0.42);
}

export function stagingArea(cfg: StoreConfig): { x0: number; x1: number; y0: number; y1: number } | undefined {
  const racks = cfg.staging.racks;
  if (!racks.length) return undefined;
  const sp = cfg.layout.points.staging;
  const cols = Math.ceil(racks.length / STAGING_PER_COLUMN);
  const longest = Math.max(...racks.map((r) => stagingRackLength(r.slotsPerLevel)));
  const rows = Math.min(STAGING_PER_COLUMN, racks.length);
  return { x0: sp.x + 3, x1: sp.x + 3 + (cols - 1) * STAGING_COL_PITCH + longest, y0: sp.y + 2 - 0.5, y1: sp.y + 2 + (rows - 1) * STAGING_ROW_PITCH + 0.5 };
}

/** 把暂存点（同时也是拣货车存放点）移到 (x, y)，吸附到最近的行走线段上；返回吸附后的位置 */
export function moveStaging(cfg: StoreConfig, x: number, y: number): { x: number; y: number } {
  const floorId = cfg.layout.points.staging.floorId;
  let best = { x, y };
  let bd = Infinity;
  for (const s of walkSegments(cfg, floorId)) {
    if (s.axis === 'D') continue;
    // 沿线段方向按 0.1 米取整，垂直方向保持在线段上
    const along = Math.min(s.hi, Math.max(s.lo, r1(s.axis === 'V' ? y : x)));
    const p = s.axis === 'V' ? { x: s.c, y: along } : { x: along, y: s.c };
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  const p = { x: best.x, y: best.y };
  cfg.layout.points.staging = { ...cfg.layout.points.staging, ...p };
  cfg.layout.points.cartDepot = { ...cfg.layout.points.cartDepot, ...p };
  return p;
}
