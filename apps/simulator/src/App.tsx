import { lazy, Suspense, useEffect, useRef, type CSSProperties } from 'react';
import { TopBar } from './ui/TopBar';
import { Inspector, Legend } from './ui/Inspector';
import { TimelineBar } from './ui/TimelineBar';
import { DataPane } from './ui/DataPane';
import { Toasts } from './ui/Toasts';
import { Minimap } from './ui/Minimap';
import { ContextMenu } from './ui/ContextMenu';
import { ShortcutHelp } from './ui/ShortcutHelp';
import { IncidentBanner } from './ui/IncidentBanner';
import { Tour, TourInvite } from './ui/Tour';
import { CinematicOverlay } from './ui/CinematicOverlay';
import { useYourStore } from './extensions';
import { pendingMenu } from './scene/contextTarget';
import { useLabelDeclutter } from './scene/declutter';
import { useApp } from './state/store';
import { clock, setPlaying, setSpeed } from './state/clock';
import { copySelected, deleteSelected, duplicateSelected, nudgeSelected, paste, rotateSelected, selectAllOnFloor } from './state/editOps';
import { drawState } from './scene/drag';
import { cameraState } from './scene/cameraState';

/** 嵌在展示页里（浏览器内演示的门店实况）：只留场景和精简的顶栏 */
const EMBEDDED = typeof location !== 'undefined' && new URLSearchParams(location.search).get('live') === 'demo';
import { t } from './i18n';

// 三维场景（three.js 与 React Three Fiber）单独打包、按需加载：界面先出来，场景随后显示
const Scene = lazy(() => import('./scene/Scene').then((m) => ({ default: m.Scene })));

const SPEEDS = [1, 10, 60, 300, 900];
const BUILDING_VIEWS = ['interior', 'cutaway', 'exterior'] as const;

const DEFAULT_RATIO = 62;

/** 场景与数据面板之间的分隔条：拖动调整比例，双击复位，方向键微调 */
function Divider({ container }: { container: React.RefObject<HTMLDivElement> }) {
  const ratio = useApp((s) => s.ratio);
  const fromPointer = (clientX: number) => {
    const rect = container.current?.getBoundingClientRect();
    if (!rect) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    const { split, setRatio } = useApp.getState();
    setRatio(split === 'scene-left' ? pct : 100 - pct);
  };
  return (
    <div
      className="divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('调整场景与数据面板的宽度')}
      aria-valuenow={Math.round(ratio)}
      aria-valuemin={32}
      aria-valuemax={78}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        document.body.classList.add('resizing');
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e.clientX);
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        document.body.classList.remove('resizing');
      }}
      onDoubleClick={() => useApp.getState().setRatio(DEFAULT_RATIO)}
      onKeyDown={(e) => {
        const { split, setRatio } = useApp.getState();
        const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
        if (!dir) return;
        e.preventDefault();
        setRatio(ratio + dir * (split === 'scene-left' ? 2 : -2));
      }}
    >
      <span className="grip" aria-hidden />
    </div>
  );
}

/** 编辑模式的快捷键；处理了返回 true */
function editKey(e: KeyboardEvent): boolean {
  const app = useApp.getState();
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'c') return copySelected() > 0;
  if (mod && k === 'v') {
    paste();
    return true;
  }
  if (mod && k === 'd') {
    duplicateSelected();
    return true;
  }
  if (mod && k === 'a') {
    selectAllOnFloor();
    return true;
  }
  if (mod || e.altKey) return false;
  if (k === 'n') {
    app.setEditTool(app.editTool === 'draw' ? 'select' : 'draw');
    return true;
  }
  if (!app.editSel.length) return false;
  if (k === 'delete' || k === 'backspace') {
    deleteSelected();
    return true;
  }
  if (k === 't') {
    rotateSelected();
    return true;
  }
  // 按屏幕方向微调：取屏幕右 / 上方向在地面上更接近的那条坐标轴
  const screen: Record<string, { x: number; z: number }> = {
    arrowright: cameraState.right,
    arrowleft: { x: -cameraState.right.x, z: -cameraState.right.z },
    arrowup: cameraState.up,
    arrowdown: { x: -cameraState.up.x, z: -cameraState.up.z },
  };
  const v = screen[k];
  if (v) {
    const step = e.shiftKey ? 1 : 0.1;
    if (Math.abs(v.x) >= Math.abs(v.z)) nudgeSelected(Math.sign(v.x) * step, 0);
    else nudgeSelected(0, Math.sign(v.z) * step);
    return true;
  }
  return false;
}

export function App() {
  const mode = useApp((s) => s.mode);
  const status = useApp((s) => s.status);
  const error = useApp((s) => s.error);
  const split = useApp((s) => s.split);
  const ratio = useApp((s) => s.ratio);
  const workspace = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLElement>(null);
  // 重叠的场景标签只显示重要的那个（决策记录 0015）
  useLabelDeclutter(stage);
  const view = useApp((s) => s.view);
  const minimap = useApp((s) => s.minimap);
  // 订阅界面语言：切换后整个界面（含场景里的标签）重新渲染
  useApp((s) => s.lang);
  const cinematic = useApp((s) => s.cinematic);
  const yourStore = useApp((s) => s.yourStore);
  const project = useApp((s) => s.project);
  // 「你的商店」在私有模块里；公开仓库的构建没有它
  const ext = useYourStore();
  const sound = useApp((s) => s.sound);
  // 环境音模块只在第一次打开声音时下载
  const soundLoaded = useRef(false);
  useEffect(() => {
    if (!sound && !soundLoaded.current) return;
    soundLoaded.current = true;
    void import('./ui/sound').then((m) => m.setSound(sound));
  }, [sound]);

  // 右键菜单：右键按下后几乎没移动就松开时打开（右键拖动用于平移镜头）
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    let down: { x: number; y: number } | undefined;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 2) return;
      down = { x: e.clientX, y: e.clientY };
      pendingMenu.target = undefined;
    };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 2 || !down) return;
      const still = Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6;
      down = undefined;
      if (!still) return;
      const r = el.getBoundingClientRect();
      const x = Math.min(r.width - 230, e.clientX - r.left);
      const y = Math.min(r.height - 220, e.clientY - r.top);
      // contextmenu 事件可能在松开之后才到达，稍等再读取被点中的对象
      window.setTimeout(() => {
        const target = pendingMenu.target;
        if (target) useApp.getState().setMenu({ x: Math.max(4, x), y: Math.max(4, y), target });
      }, 30);
    };
    const prevent = (e: Event) => e.preventDefault();
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('contextmenu', prevent);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('contextmenu', prevent);
    };
  }, []);

  useEffect(() => {
    void useApp
      .getState()
      .simulate()
      .then(() => setPlaying(true));
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      const app = useApp.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && app.mode === 'edit' && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
        e.preventDefault();
        if (e.key === 'y' || e.shiftKey) app.redo();
        else app.undo();
        return;
      }
      // 布局编辑：复制粘贴、全选、删除、旋转、微调、画通道
      if (app.mode === 'edit' && editKey(e)) {
        e.preventDefault();
        return;
      }
      if (mod || e.altKey) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying(!clock.playing);
      }
      if (app.cinematic) {
        // 巡游中：Esc 退出，其他按键不响应
        if (e.key === 'Escape') app.setCinematic(false);
        return;
      }
      if (e.key === 'Escape') {
        if (app.help) app.toggle('help');
        else if (app.mode === 'edit' && (app.editTool === 'draw' || app.editSel.length)) {
          drawState.cancel();
          app.setEditTool('select');
          app.setEditSel([]);
        } else app.select(undefined);
      }
      // 视角、跟随、倍速、复位、建筑查看方式、小地图、帮助
      if (e.key === '1') app.setView('iso');
      if (e.key === '2') app.setView('3d');
      if (e.key === '3') app.setView('top');
      if (e.key === 'g' && app.selection && (app.selection.type === 'associate' || app.selection.type === 'car')) app.setFollow(app.follow ? undefined : app.selection.id);
      if (e.key === '[' || e.key === ']') {
        const i = SPEEDS.indexOf(clock.speed);
        const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? 2 : i) + (e.key === ']' ? 1 : -1)))];
        if (next) setSpeed(next);
      }
      if (e.key === 'h') app.zoom('reset');
      if (e.key === 'b') app.setBuildingView(BUILDING_VIEWS[(BUILDING_VIEWS.indexOf(app.buildingView) + 1) % 3] as (typeof BUILDING_VIEWS)[number]);
      if (e.key === 'm') app.toggle('minimap');
      if (e.key === '?') app.toggle('help');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`app mode-${mode}${cinematic ? ' cinematic' : ''}${EMBEDDED ? ' embedded' : ''}`}>
      <TopBar />
      {project && !EMBEDDED && ext && <ext.ProjectBar />}
      {yourStore && !EMBEDDED && ext && <ext.Page />}
      <div ref={workspace} className={`workspace ${split}`} style={{ '--ratio': `${ratio}%` } as CSSProperties}>
        <main ref={stage} className="stage" aria-label={t('门店场景')}>
          <Suspense fallback={<div className="overlay-note loading">{t('正在加载三维场景…')}</div>}>
            <Scene />
          </Suspense>
          <Inspector />
          <Toasts />
          {!minimap && <Legend />}
          <div className="map-dock">
            <Minimap />
          </div>
          <ContextMenu />
          <IncidentBanner />
          <ShortcutHelp />
          <TourInvite />
          <CinematicOverlay />
          <div className="view-tools" role="group" aria-label={t('镜头')}>
            <button aria-label={t('放大')} title={t('放大（+）')} onClick={() => useApp.getState().zoom('in')}>
              ＋
            </button>
            <button aria-label={t('缩小')} title={t('缩小（−）')} onClick={() => useApp.getState().zoom('out')}>
              −
            </button>
            <button aria-label={t('向左旋转 90 度')} title={t('向左转 90°（Q 连续旋转）')} onClick={() => useApp.getState().zoom('rotateLeft')}>
              ↺
            </button>
            <button aria-label={t('向右旋转 90 度')} title={t('向右转 90°（E 连续旋转）')} onClick={() => useApp.getState().zoom('rotateRight')}>
              ↻
            </button>
            <button aria-label={t('复位视角')} title={t('复位（H）')} onClick={() => useApp.getState().zoom('reset')}>
              ⟲
            </button>
            <button aria-label={t('小地图')} title={t('小地图（M）')} className={minimap ? 'vt-map on' : 'vt-map'} onClick={() => useApp.getState().toggle('minimap')}>
              ▦
            </button>
            <button aria-label={sound ? t('关闭环境音') : t('打开环境音')} title={t('环境音（车流、雨声、扫码、警报）')} className={sound ? 'on' : ''} onClick={() => useApp.getState().toggle('sound')}>
              {sound ? '🔊' : '🔈'}
            </button>
            <button aria-label={t('快捷键')} title={t('快捷键（?）')} className="vt-keys" onClick={() => useApp.getState().toggle('help')}>
              ⌨
            </button>
          </div>
          {view === '3d' && (
            <div className="camera-presets" role="group" aria-label={t('预设机位')}>
              {(
                [
                  ['front', '正面'],
                  ['side', '侧面'],
                  ['bird', '鸟瞰'],
                  ['street', '街景'],
                ] as const
              ).map(([k, label]) => (
                <button key={k} onClick={() => useApp.getState().zoom(k)}>
                  {t(label)}
                </button>
              ))}
            </div>
          )}
          {status === 'running' && <div className="overlay-note">{t('重新仿真中…')}</div>}
          {status === 'error' && <div className="overlay-note error">{t('仿真出错：{0}', error ?? '')}</div>}
        </main>
        <Divider container={workspace} />
        <DataPane />
      </div>
      <TimelineBar />
      <Tour />
    </div>
  );
}
