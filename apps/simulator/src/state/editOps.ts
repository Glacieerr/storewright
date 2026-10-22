import { addRun, distributeRuns, moveRuns, pasteRuns, planRun, rotateRun, type RunConfig, type StoreConfig } from '@storewright/store-config';
import { useApp } from './store';
import { t, translate } from '../i18n';

/**
 * 布局编辑的操作：画通道、旋转、删除、微调、复制粘贴、等距排列、全选。
 * 场景、属性面板和快捷键共用；每个操作都是一次可撤销的草稿修改。
 */

/** 正在编辑的楼层：画面只看全部楼层时按一楼编辑 */
export function editFloor(): string {
  const st = useApp.getState();
  const ids = (st.draft ?? st.config).layout.floors.map((f) => f.id);
  return st.floor !== 'ALL' && ids.includes(st.floor) ? st.floor : (ids[0] ?? 'F1');
}

/** 指针在编辑楼层地面上的最后位置（配置坐标），粘贴时放到这里 */
export const editPointer: { x: number; y: number; at: number } = { x: 0, y: 0, at: 0 };

let clipboard: { runs: RunConfig[]; floorId: string } | undefined;

const app = useApp.getState;

function selected(d: StoreConfig): RunConfig[] {
  const sel = new Set(app().editSel);
  return d.layout.runs.filter((r) => sel.has(r.id));
}

/** 当前选中通道的温区、层数等，作为新通道的默认值 */
function drawBase(floorId: string): Partial<RunConfig> | undefined {
  const st = app();
  const base = (st.draft ?? st.config).layout.runs.find((r) => r.id === st.editRunId && r.floorId === floorId);
  return base ? { tempZone: base.tempZone, levels: base.levels, endMarginM: base.endMarginM, sides: base.sides } : undefined;
}

/** 预览：从 p 拖到 q 会画出什么（不修改草稿） */
export function previewRun(p: { x: number; y: number }, q: { x: number; y: number }) {
  const st = app();
  if (!st.draft) return undefined;
  const floorId = editFloor();
  return planRun(st.draft, floorId, p, q, drawBase(floorId));
}

export function drawRun(p: { x: number; y: number }, q: { x: number; y: number }): void {
  const st = app();
  if (!st.draft) return;
  const floorId = editFloor();
  const base = drawBase(floorId);
  const plan = planRun(st.draft, floorId, p, q, base);
  if (!plan.run) {
    if (plan.reason) st.notifyEdit(translate(plan.reason));
    return;
  }
  let made: string | undefined;
  st.updateDraft((d) => {
    made = addRun(d, floorId, p, q, base).id;
  });
  if (made) app().setEditRun(made);
}

export function rotateSelected(): void {
  const st = app();
  if (!st.draft || !st.editSel.length) return;
  // 先在副本上试：全部接不上就不产生修改
  const trial = structuredClone(st.draft);
  const fails: string[] = [];
  const ok: string[] = [];
  for (const r of selected(trial)) {
    const why = rotateRun(trial, r.id);
    if (why) fails.push(`${r.label ?? r.id}${t('：')}${translate(why)}`);
    else ok.push(r.id);
  }
  if (ok.length) st.updateDraft((d) => ok.forEach((id) => rotateRun(d, id)));
  if (fails.length) app().notifyEdit(fails.join(t('；')));
}

export function deleteSelected(): void {
  const st = app();
  if (!st.draft || !st.editSel.length) return;
  const sel = new Set(st.editSel);
  st.updateDraft((d) => {
    d.layout.runs = d.layout.runs.filter((r) => !sel.has(r.id));
  });
  st.setEditSel([]);
}

export function nudgeSelected(dx: number, dy: number): void {
  const st = app();
  if (!st.draft || !st.editSel.length) return;
  const ids = [...st.editSel];
  st.updateDraft((d) => moveRuns(d, ids, dx, dy));
}

export function copySelected(): number {
  const st = app();
  if (!st.draft) return 0;
  const runs = selected(st.draft);
  if (!runs.length) return 0;
  clipboard = { runs: runs.map((r) => ({ ...r, start: { ...r.start }, end: { ...r.end }, categoryIds: [...r.categoryIds] })), floorId: runs[0]?.floorId ?? editFloor() };
  app().notifyEdit(t('已复制 {0} 条通道，按 ⌘V / Ctrl+V 粘贴到指针位置（可切换楼层后粘贴）', runs.length));
  return runs.length;
}

export function hasClipboard(): boolean {
  return !!clipboard?.runs.length;
}

/** 粘贴：有最近的指针位置时以剪贴板中心对齐到指针，否则在原位置旁边错开一条通道 */
export function paste(atPointer = true): void {
  const st = app();
  if (!st.draft || !clipboard) return;
  const floorId = editFloor();
  const { runs } = clipboard;
  const cx = runs.reduce((n, r) => n + (r.start.x + r.end.x) / 2, 0) / runs.length;
  const cy = runs.reduce((n, r) => n + (r.start.y + r.end.y) / 2, 0) / runs.length;
  const fresh = atPointer && performance.now() - editPointer.at < 60_000;
  const vertical = runs.every((r) => Math.abs(r.end.x - r.start.x) < 1e-6);
  const horizontal = runs.every((r) => Math.abs(r.end.y - r.start.y) < 1e-6);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  let dx = 0;
  let dy = 0;
  if (fresh) {
    // 竖向通道只左右对齐指针（两端吸附回走廊），横向通道只前后对齐
    dx = horizontal ? 0 : r1(editPointer.x - cx);
    dy = vertical ? 0 : r1(editPointer.y - cy);
  } else if (clipboard.floorId === floorId) {
    // 原楼层：错开一条通道的间距
    dx = vertical ? 3.2 : 0;
    dy = vertical ? 0 : 3.2;
  }
  let ids: string[] = [];
  st.updateDraft((d) => {
    ids = pasteRuns(d, runs, floorId, dx, dy);
  });
  app().setEditSel(ids);
}

export function duplicateSelected(): void {
  if (copySelected()) paste(false);
}

export function distributeSelected(): void {
  const st = app();
  if (!st.draft) return;
  const ids = [...st.editSel];
  const why = distributeRuns(structuredClone(st.draft), ids);
  if (why) {
    st.notifyEdit(translate(why));
    return;
  }
  st.updateDraft((d) => distributeRuns(d, ids));
}

export function selectAllOnFloor(): void {
  const st = app();
  const d = st.draft;
  if (!d) return;
  const floorId = editFloor();
  st.setEditSel(d.layout.runs.filter((r) => r.floorId === floorId && r.kind === 'AISLE').map((r) => r.id));
}

/** 批量修改选中通道的属性 */
export function patchSelected(fn: (r: RunConfig) => void): void {
  const st = app();
  if (!st.draft || !st.editSel.length) return;
  st.updateDraft((d) => selected(d).forEach(fn));
}
