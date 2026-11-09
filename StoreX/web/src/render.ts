import type { AgentKind, AgentTrace } from '../../src/ops/trace';
import { TraceCursor } from './tracePos';
export { onDuty } from './tracePos';
import type { Category, Layout, Rect } from '../../src/world/layout';

/**
 * 门店俯视图：静态层（地面、货架、墙、区域文字）画一次，每帧只画人、机器人和车。
 * 形状区分人和机器人（圆 = 人，方 = 机器人），颜色区分工作内容。
 */
export interface Group {
  key: string;
  label: string;
  kinds: AgentKind[];
  shape: 'circle' | 'square' | 'dot' | 'vehicle';
  color: string;
}

/** 颜色按固定顺序取（CSS 变量 --c1…--c5），不轮换 */
export const GROUPS: Group[] = [
  { key: 'online', label: '线上履约员工', kinds: ['picker', 'dispenser', 'porter', 'decanter', 'freshPicker', 'handoff'], shape: 'circle', color: '--c1' },
  { key: 'floor', label: '门店员工', kinds: ['stocker', 'receiver', 'cashier', 'host', 'robotTech'], shape: 'circle', color: '--c2' },
  { key: 'mfc', label: '货格机器人', kinds: ['mfcBot'], shape: 'square', color: '--c4' },
  { key: 'robots', label: '补货、送框、装柜、托盘机器人', kinds: ['amr', 'cart', 'loader', 'pallet'], shape: 'square', color: '--c3' },
  { key: 'clean', label: '盘点、洗地机器人', kinds: ['scanner', 'scrubber'], shape: 'square', color: '--c5' },
  { key: 'shopper', label: '到店顾客', kinds: ['shopper'], shape: 'dot', color: '--muted' },
  { key: 'vehicle', label: '货车、配送车、顾客车辆', kinds: ['truck', 'van', 'car'], shape: 'vehicle', color: '--ink2' },
];
const GROUP_OF = new Map<AgentKind, Group>();
for (const g of GROUPS) for (const k of g.kinds) GROUP_OF.set(k, g);
export const groupOf = (k: AgentKind): Group => GROUP_OF.get(k) as Group;


// 格子类型（与 src/world/layout.ts 的 Cell 一致）
const OUTSIDE = 0;
const WALL = 2;
const SHELF = 3;
const FIXTURE = 4;

const CHILLED: Category[] = ['dairy', 'meat', 'produce'];

export interface Placed {
  agent: AgentTrace;
  x: number;
  y: number;
  act?: string;
  moving: boolean;
}

export class MapView {
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement | undefined;
  private layout: Layout | undefined;
  private agents: AgentTrace[] = [];
  private cursor = new TraceCursor([]);
  private scale = 10;
  private dpr = 1;
  private colors: Record<string, string> = {};
  placed: Placed[] = [];
  hidden = new Set<string>();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  }

  setLayout(layout: Layout): void {
    this.layout = layout;
    this.resize();
  }

  setAgents(agents: AgentTrace[]): void {
    this.agents = agents;
    this.cursor = new TraceCursor(agents);
  }

  /** 按容器宽度定比例；颜色从 CSS 变量读（浅色 / 深色切换后重画静态层） */
  resize(): void {
    const l = this.layout;
    if (!l) return;
    // 用容器的内宽（不含边框），画布不会被裁掉
    const width = Math.max(280, this.canvas.parentElement?.clientWidth ?? 840);
    this.scale = width / l.width;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${this.scale * l.height}px`;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(this.scale * l.height * this.dpr);
    const css = getComputedStyle(document.documentElement);
    for (const v of ['--map-outside', '--map-floor', '--map-back', '--map-wall', '--map-shelf', '--map-chill', '--map-frozen', '--map-bakery', '--map-fixture', '--map-mfc', '--map-locker', '--map-lane', '--map-zone', '--map-label', '--c1', '--c2', '--c3', '--c4', '--c5', '--muted', '--ink2', '--surface']) this.colors[v] = css.getPropertyValue(v).trim() || '#888';
    this.base = this.drawBase();
  }

  private px(v: number): number {
    return (v + 0.5) * this.scale;
  }

  private drawBase(): HTMLCanvasElement {
    const l = this.layout as Layout;
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    g.scale(this.dpr, this.dpr);
    const s = this.scale;
    const col = this.colors;
    g.fillStyle = col['--map-outside'] as string;
    g.fillRect(0, 0, l.width * s, l.height * s);
    for (let y = 0; y < l.height; y++)
      for (let x = 0; x < l.width; x++) {
        const cell = l.cells[y * l.width + x];
        if (cell === OUTSIDE || cell === WALL) continue;
        g.fillStyle = col['--map-floor'] as string;
        g.fillRect(x * s, y * s, s + 0.5, s + 0.5);
      }
    const fillRect = (r: Rect, color: string) => {
      g.fillStyle = color;
      g.fillRect(r.x * s, r.y * s, r.w * s, r.h * s);
    };
    for (const r of l.rects) {
      switch (r.kind) {
        case 'backroom':
          fillRect(r, col['--map-back'] as string);
          break;
        case 'lane':
          fillRect(r, col['--map-lane'] as string);
          break;
        case 'checkout':
        case 'zone':
          g.fillStyle = col['--map-zone'] as string;
          g.fillRect(r.x * s, r.y * s, r.w * s, r.h * s);
          break;
        case 'lockers':
          fillRect(r, col['--map-locker'] as string);
          break;
        case 'mfc': {
          fillRect(r, col['--map-mfc'] as string);
          // 货格：细网格
          g.strokeStyle = col['--map-fixture'] as string;
          g.lineWidth = 0.5;
          g.beginPath();
          for (let x = r.x; x <= r.x + r.w; x++) {
            g.moveTo(x * s, r.y * s);
            g.lineTo(x * s, (r.y + r.h) * s);
          }
          for (let y = r.y; y <= r.y + r.h; y++) {
            g.moveTo(r.x * s, y * s);
            g.lineTo((r.x + r.w) * s, y * s);
          }
          g.stroke();
          break;
        }
        default:
          break;
      }
    }
    // 货架和固定设施按格子画（温区用颜色区分）
    const catAt = new Map<number, Category>();
    for (const r of l.rects) if (r.kind === 'shelf' && r.category) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) catAt.set(y * l.width + x, r.category);
    for (let y = 0; y < l.height; y++)
      for (let x = 0; x < l.width; x++) {
        const cell = l.cells[y * l.width + x];
        if (cell === SHELF) {
          const cat = catAt.get(y * l.width + x);
          g.fillStyle = (cat === 'frozen' ? col['--map-frozen'] : cat && CHILLED.includes(cat) ? col['--map-chill'] : cat === 'bakery' ? col['--map-bakery'] : col['--map-shelf']) as string;
          g.fillRect(x * s + 0.5, y * s + 0.5, s - 1, s - 1);
        } else if (cell === FIXTURE) {
          g.fillStyle = col['--map-fixture'] as string;
          g.fillRect(x * s + 0.5, y * s + 0.5, s - 1, s - 1);
        } else if (cell === WALL) {
          g.fillStyle = col['--map-wall'] as string;
          g.fillRect(x * s, y * s, s + 0.5, s + 0.5);
        }
      }
    // 区域文字：放得下就横着写；又高又窄的区域竖着写；放不下的小设施写在旁边
    g.textBaseline = 'middle';
    g.fillStyle = col['--map-label'] as string;
    const base = Math.max(9, Math.min(12, s * 1.05));
    const setFont = (px: number) => (g.font = `${px}px system-ui, -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif`);
    for (const r of l.rects) {
      if (!r.label) continue;
      // 手机上地图很小：只写区域名，不写货架和设施
      if (s < 6 && (r.kind === 'shelf' || r.kind === 'fixture' || r.kind === 'backroom')) continue;
      const rw = r.w * s;
      const rh = r.h * s;
      const cx = (r.x + r.w / 2) * s;
      const cy = (r.y + r.h / 2) * s;
      let px = r.kind === 'shelf' ? base - 1 : base;
      setFont(px);
      let tw = g.measureText(r.label).width;
      g.save();
      g.textAlign = 'center';
      if (r.kind === 'backroom') {
        // 后仓：左上角，不和里面的设施文字重叠
        g.textAlign = 'left';
        g.fillText(r.label, r.x * s + 6, r.y * s + px);
      } else if (tw <= rw - 4) {
        // 区域的名字写在上沿，设施和货架写在中间
        g.fillText(r.label, cx, r.kind === 'zone' && rh > px * 3 ? r.y * s + px : cy);
      } else {
        const room = rh > rw ? rh : rw;
        while (tw > room - 4 && px > 8) {
          setFont(--px);
          tw = g.measureText(r.label).width;
        }
        if (tw <= room - 4 && rh > rw) {
          g.translate(cx, cy);
          g.rotate(-Math.PI / 2);
          g.fillText(r.label, 0, 0);
        } else if (tw <= room - 4) g.fillText(r.label, cx, cy);
        else {
          // 放不下：写在设施上方
          setFont(Math.max(9, base - 2));
          g.fillText(r.label, cx, r.y * s - 6);
        }
      }
      g.restore();
    }
    return c;
  }

  /** 画时刻 t 的门店 */
  draw(t: number): void {
    const g = this.ctx;
    if (!this.base) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.base, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const s = this.scale;
    const col = this.colors;
    this.placed = [];
    // 先画顾客（最底层），再画车、机器人、员工
    const order = ['shopper', 'vehicle', 'mfc', 'robots', 'clean', 'floor', 'online'];
    const byGroup = new Map<string, Placed[]>();
    this.agents.forEach((a, i) => {
      const grp = groupOf(a.kind);
      if (this.hidden.has(grp.key)) return;
      const pose = this.cursor.pose(i, t);
      const p: Placed | undefined = pose ? { agent: a, x: pose.x, y: pose.y, ...(pose.act ? { act: pose.act } : {}), moving: pose.moving } : undefined;
      if (!p) return;
      const list = byGroup.get(grp.key) ?? [];
      list.push(p);
      byGroup.set(grp.key, list);
      this.placed.push(p);
    });
    for (const key of order) {
      const list = byGroup.get(key);
      if (!list) continue;
      const grp = GROUPS.find((x) => x.key === key) as Group;
      const color = col[grp.color] as string;
      for (const p of list) {
        const x = this.px(p.x);
        const y = this.px(p.y);
        g.fillStyle = color;
        g.strokeStyle = col['--surface'] as string;
        g.lineWidth = 1.2;
        switch (grp.shape) {
          case 'dot':
            g.globalAlpha = 0.75;
            g.beginPath();
            g.arc(x, y, Math.max(1.6, s * 0.22), 0, Math.PI * 2);
            g.fill();
            g.globalAlpha = 1;
            break;
          case 'circle':
            g.beginPath();
            g.arc(x, y, Math.max(2.6, s * 0.38), 0, Math.PI * 2);
            g.fill();
            g.stroke();
            if (!p.moving && p.act) {
              // 原地作业：外面加一圈
              g.beginPath();
              g.arc(x, y, Math.max(4, s * 0.6), 0, Math.PI * 2);
              g.strokeStyle = color;
              g.lineWidth = 1;
              g.stroke();
            }
            break;
          case 'square': {
            const h = Math.max(2.6, s * (key === 'mfc' ? 0.32 : 0.4));
            g.beginPath();
            g.roundRect(x - h, y - h, h * 2, h * 2, Math.max(1, h * 0.35));
            g.fill();
            g.stroke();
            break;
          }
          case 'vehicle': {
            const w = s * (p.agent.kind === 'truck' ? 2.4 : 1.6);
            const h = s * 1.1;
            g.beginPath();
            g.roundRect(x - w / 2, y - h / 2, w, h, 2);
            g.fill();
            break;
          }
        }
      }
    }
  }

  /** 鼠标附近的人或机器人 */
  hit(clientX: number, clientY: number): Placed | undefined {
    const box = this.canvas.getBoundingClientRect();
    const mx = clientX - box.left;
    const my = clientY - box.top;
    let best: Placed | undefined;
    let bestD = 12 * 12;
    for (const p of this.placed) {
      if (p.agent.kind === 'shopper') continue;
      const dx = this.px(p.x) - mx;
      const dy = this.px(p.y) - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }
}
