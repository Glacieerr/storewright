import { moveRuns, runSpan, type DrawResult } from '@storewright/store-config';
import { useApp } from '../state/store';
import { nudgeSelected, previewRun, drawRun } from '../state/editOps';

/**
 * 布局编辑中的拖拽：按下已选中的通道后在地面上移动指针，松开时把位移写入草稿（选中多条时一起移动）。
 * 全是竖向通道时只左右移动，全是横向通道时只前后移动，混合时自由移动；
 * 拖动中按吸附后的结果预览，松开后两端重新吸附到走廊上。
 */
/** 当前视角的镜头控制器（拖拽通道时暂停平移） */
export const activeControls: { current: { enabled: boolean } | null } = { current: null };

/** 刚拖完彩色把手：松开时不要再当成点选地面 */
export const handleState = { busy: false, justDragged: false };

export interface PreviewRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** 通道中线两侧的货架范围（预览用） */
function rectOf(r: { start: { x: number; y: number }; end: { x: number; y: number }; sides: 1 | 2 }): PreviewRect {
  const ext = r.sides === 2 ? 1.5 : 0.9;
  return { x0: Math.min(r.start.x, r.end.x) - ext, x1: Math.max(r.start.x, r.end.x) + ext, z0: Math.min(r.start.y, r.end.y) - ext, z1: Math.max(r.start.y, r.end.y) + ext };
}

const snap = (v: number) => Math.round(v * 10) / 10;

export const dragState = {
  ids: [] as string[],
  startX: 0,
  startZ: 0,
  dx: 0,
  dz: 0,
  justDragged: false,
  preview: [] as PreviewRect[],

  begin(ids: string[], x: number, z: number): void {
    this.ids = ids;
    this.startX = x;
    this.startZ = z;
    this.dx = 0;
    this.dz = 0;
    this.preview = [];
    if (activeControls.current) activeControls.current.enabled = false;
  },

  move(x: number, z: number): void {
    if (!this.ids.length) return;
    const draft = useApp.getState().draft;
    if (!draft) return;
    const runs = draft.layout.runs.filter((r) => this.ids.includes(r.id));
    const axes = new Set(runs.map((r) => runSpan(r).axis));
    const dx = axes.size === 1 && axes.has('H') ? 0 : snap(x - this.startX);
    const dz = axes.size === 1 && axes.has('V') ? 0 : snap(z - this.startZ);
    if (dx === this.dx && dz === this.dz) return;
    this.dx = dx;
    this.dz = dz;
    // 在副本上试移动，按吸附后的位置预览
    const trial = structuredClone(draft);
    moveRuns(trial, this.ids, dx, dz);
    this.preview = trial.layout.runs.filter((r) => this.ids.includes(r.id)).map(rectOf);
  },

  end(): void {
    const { ids, dx, dz } = this;
    this.ids = [];
    this.preview = [];
    if (activeControls.current) activeControls.current.enabled = true;
    if (!ids.length || (dx === 0 && dz === 0)) return;
    this.justDragged = true;
    window.setTimeout(() => (this.justDragged = false), 50);
    nudgeSelected(dx, dz);
  },
};

/** 画新通道：按下处为起点，拖到松开处；预览吸附后的结果 */
export const drawState = {
  active: false,
  p: { x: 0, y: 0 },
  q: { x: 0, y: 0 },
  plan: undefined as DrawResult | undefined,

  begin(x: number, z: number): void {
    this.active = true;
    this.p = { x, y: z };
    this.q = { x, y: z };
    this.plan = previewRun(this.p, this.q);
    if (activeControls.current) activeControls.current.enabled = false;
  },

  move(x: number, z: number): void {
    if (!this.active) return;
    if (Math.abs(x - this.q.x) < 0.05 && Math.abs(z - this.q.y) < 0.05) return;
    this.q = { x, y: z };
    this.plan = previewRun(this.p, this.q);
  },

  end(): void {
    if (!this.active) return;
    this.active = false;
    this.plan = undefined;
    if (activeControls.current) activeControls.current.enabled = true;
    this.justDrew = true;
    window.setTimeout(() => (this.justDrew = false), 50);
    drawRun(this.p, this.q);
  },

  cancel(): void {
    this.active = false;
    this.plan = undefined;
    if (activeControls.current) activeControls.current.enabled = true;
  },

  justDrew: false,
};

export { rectOf as previewRectOf };

/** 离点 (x, z) 最近的货架通道（按行走中线的点到线段距离），超过 maxDist 米返回 undefined */
export function nearestRun(x: number, z: number, floorId: string, maxDist = 2.6): string | undefined {
  const draft = useApp.getState().draft ?? useApp.getState().config;
  let best: string | undefined;
  let bestD = maxDist;
  for (const r of draft.layout.runs) {
    if (floorId !== 'ALL' && r.floorId !== floorId) continue;
    const dx = r.end.x - r.start.x;
    const dz = r.end.y - r.start.y;
    const len2 = dx * dx + dz * dz;
    const k = len2 > 0 ? Math.max(0, Math.min(1, ((x - r.start.x) * dx + (z - r.start.y) * dz) / len2)) : 0;
    const d = Math.hypot(x - (r.start.x + k * dx), z - (r.start.y + k * dz));
    if (d < bestD) {
      bestD = d;
      best = r.id;
    }
  }
  return best;
}
