/**
 * 门店布局：1 米一格的栅格。两代门店用同一个建筑外壳（71 × 56 米）和同样的停车场、卸货场，
 * 只有内部布置不同，所以走路距离可以直接比较。
 *
 * - gen1（上一代，Storewright 中型店的布置）：后仓货架 + 线上订单暂存间，员工推车拣货，路边车位交付；
 * - storex（本方案）：后仓里的立体货格仓（机器人在货格顶上取箱），西墙的分温区自提柜和免下车取货车道，
 *   中间货架少而宽（机器人和员工共用），生鲜区更大，出口是免排队通道 + 自助结账 + 两条人工通道。
 */
export type Generation = 'gen1' | 'storex';

export const enum Cell {
  Outside = 0,
  Floor = 1,
  Wall = 2,
  Shelf = 3,
  Fixture = 4,
  Door = 5,
}

/** 商品大类（决定在哪里陈列、存放在哪个温区、能不能进立体货格仓） */
export type Category = 'ambient' | 'household' | 'beverage' | 'dairy' | 'frozen' | 'produce' | 'meat' | 'bakery';
export const CATEGORIES: readonly Category[] = ['ambient', 'household', 'beverage', 'dairy', 'frozen', 'produce', 'meat', 'bakery'];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: 'floor' | 'backroom' | 'shelf' | 'fixture' | 'mfc' | 'lockers' | 'checkout' | 'outside' | 'lane' | 'zone';
  label?: string;
  category?: Category;
}

export interface Pt {
  x: number;
  y: number;
}

export interface Layout {
  generation: Generation;
  width: number;
  height: number;
  /** 每格的类型（Cell） */
  cells: Uint8Array;
  /** 画图用的区块和文字 */
  rects: Rect[];
  /** 每个商品大类的陈列面（员工、顾客站的格子） */
  faces: Record<Category, Pt[]>;
  poi: {
    entrance: Pt;
    exit: Pt;
    parking: Pt[];
    staffedLanes: Pt[];
    selfCheckouts: Pt[];
    gates: Pt[];
    service: Pt;
    docks: { outside: Pt; inside: Pt }[];
    backroomDoors: Pt[];
    backroomStock: Pt[];
    freshPrep: Pt;
    /** 上一代：暂存间、交付门、路边车位 */
    staging?: Pt;
    pickupDoor?: Pt;
    curbsideBays: Pt[];
    /** 本方案：货格仓站台、拆箱站、合流台、自提柜（柜内装柜位、柜外取货位）、免下车取货车位、充电位 */
    mfcPorts: Pt[];
    decant?: Pt;
    consolidation?: Pt;
    /** 本方案：生鲜投放口（生鲜区旁，框经输送线送到合流台） */
    freshDrop?: Pt;
    lockerLoad: Pt[];
    lockerAccess: Pt[];
    driveBays: Pt[];
    driveHatch?: Pt;
    chargers: Pt[];
    /** 本方案：立体货格仓的范围（画机器人用） */
    mfc?: Rect;
  };
}

export const W = 84;
export const HGT = 70;
/** 建筑外壳 */
const BX0 = 6;
const BY0 = 4;
const BX1 = 77;
const BY1 = 56;
/** 建筑外壳的范围（三维场景画外墙和屋顶用） */
export const BUILDING = { x0: BX0, y0: BY0, x1: BX1, y1: BY1 } as const;

class Builder {
  cells = new Uint8Array(W * HGT);
  rects: Rect[] = [];
  faces = Object.fromEntries(CATEGORIES.map((c) => [c, [] as Pt[]])) as Record<Category, Pt[]>;
  shelfCat = new Map<number, Category>();

  constructor() {
    this.fill(0, 0, W, HGT, Cell.Outside);
    this.fill(BX0, BY0, BX1 - BX0 + 1, BY1 - BY0 + 1, Cell.Floor);
    // 外墙
    for (let x = BX0; x <= BX1; x++) {
      this.set(x, BY0, Cell.Wall);
      this.set(x, BY1, Cell.Wall);
    }
    for (let y = BY0; y <= BY1; y++) {
      this.set(BX0, y, Cell.Wall);
      this.set(BX1, y, Cell.Wall);
    }
  }

  set(x: number, y: number, c: Cell): void {
    if (x >= 0 && y >= 0 && x < W && y < HGT) this.cells[y * W + x] = c;
  }

  get(x: number, y: number): Cell {
    return this.cells[y * W + x] as Cell;
  }

  fill(x: number, y: number, w: number, h: number, c: Cell): void {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c);
  }

  rect(r: Rect, cell?: Cell): void {
    this.rects.push(r);
    if (cell !== undefined) this.fill(r.x, r.y, r.w, r.h, cell);
  }

  /** 横向的墙，留出门洞 */
  hwall(y: number, x0: number, x1: number, doors: number[]): void {
    for (let x = x0; x <= x1; x++) this.set(x, y, Cell.Wall);
    for (const d of doors) {
      this.set(d, y, Cell.Door);
      this.set(d + 1, y, Cell.Door);
    }
  }

  vwall(x: number, y0: number, y1: number, doors: number[]): void {
    for (let y = y0; y <= y1; y++) this.set(x, y, Cell.Wall);
    for (const d of doors) {
      this.set(x, d, Cell.Door);
      this.set(x, d + 1, Cell.Door);
    }
  }

  /** 竖排货架：一格宽，左右两面都能取货 */
  shelfColumn(x: number, y0: number, y1: number, category: Category, label?: string): void {
    this.rect({ x, y: y0, w: 1, h: y1 - y0 + 1, kind: 'shelf', category, ...(label ? { label } : {}) }, Cell.Shelf);
    for (let y = y0; y <= y1; y++) this.shelfCat.set(y * W + x, category);
  }

  shelfRow(y: number, x0: number, x1: number, category: Category, label?: string): void {
    this.rect({ x: x0, y, w: x1 - x0 + 1, h: 1, kind: 'shelf', category, ...(label ? { label } : {}) }, Cell.Shelf);
    for (let x = x0; x <= x1; x++) this.shelfCat.set(y * W + x, category);
  }

  /** 每个货架格旁边能站人的格子就是陈列面 */
  computeFaces(): void {
    const seen = new Set<number>();
    for (const [idx, cat] of this.shelfCat) {
      const x = idx % W;
      const y = Math.floor(idx / W);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (this.get(nx, ny) !== Cell.Floor) continue;
        const key = (ny * W + nx) * 8 + CATEGORIES.indexOf(cat);
        if (seen.has(key)) continue;
        seen.add(key);
        this.faces[cat].push({ x: nx, y: ny });
      }
    }
    // 蛇形顺序：先按 x 再按 y，商品按这个顺序摆放，同类商品挨在一起
    for (const c of CATEGORIES) this.faces[c].sort((a, b) => a.x - b.x || a.y - b.y);
  }
}

export function buildLayout(generation: Generation): Layout {
  return generation === 'gen1' ? buildGen1() : buildStoreX();
}

function common(b: Builder): Pick<Layout['poi'], 'entrance' | 'exit' | 'parking' | 'service' | 'docks'> {
  // 停车场（南侧）和卸货场（北侧）
  b.rect({ x: 8, y: 58, w: 68, h: 11, kind: 'outside', label: '停车场' });
  b.rect({ x: 14, y: 0, w: 56, h: 3, kind: 'outside', label: '卸货场' });
  const parking: Pt[] = [];
  for (let x = 12; x <= 72; x += 3) for (const y of [60, 64, 68]) parking.push({ x, y });
  // 入口、出口（南墙）
  b.set(32, BY1, Cell.Door);
  b.set(33, BY1, Cell.Door);
  b.set(44, BY1, Cell.Door);
  b.set(45, BY1, Cell.Door);
  return {
    entrance: { x: 32, y: BY1 + 1 },
    exit: { x: 44, y: BY1 + 1 },
    parking,
    service: { x: 56, y: 52 },
    docks: [],
  };
}

function buildGen1(): Layout {
  const b = new Builder();
  const base = common(b);
  b.rect({ x: BX0 + 1, y: BY0 + 1, w: BX1 - BX0 - 1, h: 11, kind: 'backroom', label: '后仓' });
  b.hwall(16, BX0, BX1, [21, 44, 68]);
  // 卸货门（北墙）
  for (const x of [30, 38]) {
    b.set(x, BY0, Cell.Door);
    b.set(x + 1, BY0, Cell.Door);
  }
  const docks = [30, 38].map((x) => ({ outside: { x, y: BY0 - 2 }, inside: { x, y: BY0 + 2 } }));
  // 后仓货架
  for (const y of [7, 10, 13]) {
    b.rect({ x: 9, y, w: 18, h: 1, kind: 'fixture', label: y === 7 ? '后仓货架' : '' }, Cell.Fixture);
    b.rect({ x: 46, y, w: 12, h: 1, kind: 'fixture' }, Cell.Fixture);
  }
  b.rect({ x: 61, y: 6, w: 15, h: 8, kind: 'zone', label: '面包熟食加工' });
  // 线上订单暂存间（西侧）：暂存格位 + 冷藏冷冻柜，西墙上的交付门通往路边车位
  b.rect({ x: 7, y: 17, w: 10, h: 15, kind: 'zone', label: '线上暂存间' });
  b.vwall(17, 17, 32, [24]);
  b.hwall(32, BX0, 17, []);
  for (const y of [18, 21]) b.rect({ x: 8, y, w: 8, h: 1, kind: 'fixture' }, Cell.Fixture);
  for (const y of [27, 30]) b.rect({ x: 8, y, w: 8, h: 1, kind: 'fixture' }, Cell.Fixture);
  b.set(BX0, 24, Cell.Door);
  b.set(BX0, 25, Cell.Door);
  b.rect({ x: 0, y: 18, w: 5, h: 18, kind: 'lane', label: '路边车位' });
  const curbsideBays = [19, 22, 25, 28, 31, 34].map((y) => ({ x: 2, y }));
  // 卖场：北侧肉类海鲜柜，东墙乳品冷柜，东侧面包熟食和果蔬，中间 12 条货架通道 + 冷冻区
  b.shelfRow(18, 22, 60, 'meat', '肉类 · 海鲜');
  b.shelfColumn(76, 19, 50, 'dairy', '乳品冷柜');
  const center: Category[] = ['ambient', 'ambient', 'ambient', 'ambient', 'ambient', 'ambient', 'household', 'household', 'beverage', 'beverage', 'ambient', 'ambient', 'ambient'];
  center.forEach((c, i) => b.shelfColumn(20 + i * 3, 22, 43, c, i === 0 ? '常温食品' : i === 6 ? '日用品' : i === 8 ? '饮料' : undefined));
  b.shelfColumn(59, 22, 43, 'frozen', '冷冻');
  b.shelfColumn(62, 22, 43, 'frozen');
  for (const y of [21, 25, 29]) b.shelfRow(y, 66, 73, 'bakery', y === 21 ? '面包熟食' : undefined);
  for (const [x, y] of [
    [66, 36],
    [70, 36],
    [66, 41],
    [70, 41],
    [66, 46],
    [70, 46],
  ] as const) {
    b.rect({ x, y, w: 2, h: 3, kind: 'shelf', category: 'produce', ...(x === 66 && y === 36 ? { label: '果蔬' } : {}) }, Cell.Shelf);
    for (let j = y; j < y + 3; j++) for (let i = x; i < x + 2; i++) b.shelfCat.set(j * W + i, 'produce');
  }
  // 收银区：6 条人工通道 + 6 台自助结账
  b.rect({ x: 19, y: 47, w: 40, h: 6, kind: 'checkout', label: '收银区' });
  const staffedLanes: Pt[] = [];
  for (let i = 0; i < 6; i++) {
    const x = 21 + i * 4;
    b.fill(x, 48, 1, 3, Cell.Fixture);
    staffedLanes.push({ x: x + 1, y: 49 });
  }
  const selfCheckouts: Pt[] = [];
  for (let i = 0; i < 6; i++) {
    const x = 46 + (i % 3) * 3;
    const y = 48 + Math.floor(i / 3) * 3;
    b.fill(x, y, 1, 1, Cell.Fixture);
    selfCheckouts.push({ x: x + 1, y });
  }
  b.fill(55, 51, 3, 2, Cell.Fixture);
  b.computeFaces();
  return {
    generation: 'gen1',
    width: W,
    height: HGT,
    cells: b.cells,
    rects: b.rects,
    faces: b.faces,
    poi: {
      ...base,
      service: { x: 56, y: 50 },
      docks,
      staffedLanes,
      selfCheckouts,
      gates: [],
      backroomDoors: [21, 44, 68].map((x) => ({ x, y: 16 })),
      backroomStock: [
        { x: 18, y: 8 },
        { x: 18, y: 11 },
        { x: 52, y: 8 },
        { x: 52, y: 11 },
      ],
      freshPrep: { x: 68, y: 14 },
      staging: { x: 12, y: 24 },
      pickupDoor: { x: 7, y: 24 },
      curbsideBays,
      mfcPorts: [],
      lockerLoad: [],
      lockerAccess: [],
      driveBays: [],
      chargers: [],
    },
  };
}

function buildStoreX(): Layout {
  const b = new Builder();
  const base = common(b);
  // 后仓加深到 y=19：立体货格仓、拆箱站、充电维护间、少量后仓货架、面包熟食加工
  b.rect({ x: BX0 + 1, y: BY0 + 1, w: BX1 - BX0 - 1, h: 14, kind: 'backroom', label: '后仓' });
  b.hwall(20, BX0, BX1, [20, 62]);
  for (const x of [22, 58]) {
    b.set(x, BY0, Cell.Door);
    b.set(x + 1, BY0, Cell.Door);
  }
  const docks = [22, 58].map((x) => ({ outside: { x, y: BY0 - 2 }, inside: { x, y: BY0 + 2 } }));
  const mfc: Rect = { x: 30, y: 6, w: 24, h: 12, kind: 'mfc', label: '立体货格仓' };
  b.rect(mfc, Cell.Fixture);
  // 站台在货格仓西侧：3 个拣货站台 + 1 个拆箱站台
  const mfcPorts = [7, 10, 13].map((y) => ({ x: 28, y }));
  const decant = { x: 28, y: 16 };
  b.rect({ x: 8, y: 6, w: 10, h: 5, kind: 'zone', label: '充电维护' });
  const chargers = [8, 10, 12, 14, 16].map((x) => ({ x, y: 9 }));
  for (const y of [13, 16]) b.rect({ x: 9, y, w: 14, h: 1, kind: 'fixture', label: y === 13 ? '后仓货架' : '' }, Cell.Fixture);
  b.rect({ x: 60, y: 6, w: 16, h: 12, kind: 'zone', label: '面包熟食加工' });
  // 自提中心：西墙上的分温区自提柜（柜内一侧装柜，柜外一侧取货）、合流台、免下车取货车道
  b.rect({ x: 7, y: 21, w: 9, h: 22, kind: 'zone', label: '自提中心' });
  b.vwall(16, 21, 43, [30]);
  b.hwall(43, BX0, 16, []);
  b.rect({ x: BX0, y: 22, w: 1, h: 20, kind: 'lockers', label: '自提柜' }, Cell.Fixture);
  const lockerLoad: Pt[] = [];
  const lockerAccess: Pt[] = [];
  for (let y = 23; y <= 40; y += 3) {
    lockerLoad.push({ x: BX0 + 1, y });
    lockerAccess.push({ x: BX0 - 1, y });
  }
  b.rect({ x: 10, y: 25, w: 3, h: 6, kind: 'fixture', label: '合流台' }, Cell.Fixture);
  const consolidation = { x: 13, y: 28 };
  b.rect({ x: 0, y: 21, w: 5, h: 21, kind: 'lane', label: '自提柜取货' });
  b.rect({ x: 0, y: 44, w: 5, h: 13, kind: 'lane', label: '免下车取货' });
  b.set(BX0, 47, Cell.Door);
  b.set(BX0, 48, Cell.Door);
  const driveBays = [46, 49, 52, 55].map((y) => ({ x: 2, y }));
  // 卖场：北侧肉类海鲜，东墙乳品，中间 10 排货架（通道 2 米，机器人和人共用），冷冻两排，东侧更大的生鲜市场
  b.shelfRow(22, 20, 50, 'meat', '肉类 · 海鲜');
  b.shelfColumn(76, 22, 50, 'dairy', '乳品冷柜');
  const center: Category[] = ['ambient', 'ambient', 'ambient', 'ambient', 'household', 'household', 'beverage', 'beverage', 'ambient', 'ambient'];
  center.forEach((c, i) => b.shelfColumn(21 + i * 3, 26, 43, c, i === 0 ? '常温食品' : i === 4 ? '日用品' : i === 6 ? '饮料' : undefined));
  b.shelfColumn(52, 26, 43, 'frozen', '冷冻');
  b.shelfColumn(55, 26, 43, 'frozen');
  for (const y of [24, 28, 32]) b.shelfRow(y, 60, 73, 'bakery', y === 24 ? '面包熟食 · 现做' : undefined);
  for (const [x, y] of [
    [60, 37],
    [64, 37],
    [68, 37],
    [60, 42],
    [64, 42],
    [68, 42],
  ] as const) {
    b.rect({ x, y, w: 2, h: 3, kind: 'shelf', category: 'produce', ...(x === 60 && y === 37 ? { label: '生鲜市场 · 果蔬' } : {}) }, Cell.Shelf);
    for (let j = y; j < y + 3; j++) for (let i = x; i < x + 2; i++) b.shelfCat.set(j * W + i, 'produce');
  }
  // 出口：4 条免排队通道（摄像头识别，走出即结账）、6 台视觉辅助自助结账、2 条人工通道
  b.rect({ x: 19, y: 47, w: 40, h: 6, kind: 'checkout', label: '免排队出口 · 自助 · 人工' });
  const gates: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    const x = 21 + i * 3;
    b.fill(x, 49, 1, 2, Cell.Fixture);
    gates.push({ x: x + 1, y: 50 });
  }
  const selfCheckouts: Pt[] = [];
  for (let i = 0; i < 6; i++) {
    const x = 34 + (i % 3) * 3;
    const y = 48 + Math.floor(i / 3) * 3;
    b.fill(x, y, 1, 1, Cell.Fixture);
    selfCheckouts.push({ x: x + 1, y });
  }
  const staffedLanes: Pt[] = [];
  for (let i = 0; i < 2; i++) {
    const x = 47 + i * 4;
    b.fill(x, 48, 1, 3, Cell.Fixture);
    staffedLanes.push({ x: x + 1, y: 49 });
  }
  b.fill(55, 51, 3, 2, Cell.Fixture);
  b.rect({ x: 57, y: 45, w: 2, h: 1, kind: 'fixture', label: '生鲜投放口' }, Cell.Fixture);
  b.computeFaces();
  return {
    generation: 'storex',
    width: W,
    height: HGT,
    cells: b.cells,
    rects: b.rects,
    faces: b.faces,
    poi: {
      ...base,
      service: { x: 56, y: 50 },
      docks,
      staffedLanes,
      selfCheckouts,
      gates,
      backroomDoors: [20, 62].map((x) => ({ x, y: 20 })),
      backroomStock: [
        { x: 16, y: 14 },
        { x: 20, y: 17 },
      ],
      freshPrep: { x: 66, y: 18 },
      curbsideBays: [],
      mfcPorts,
      decant,
      consolidation,
      freshDrop: { x: 58, y: 46 },
      lockerLoad,
      lockerAccess,
      driveBays,
      driveHatch: { x: BX0 + 1, y: 47 },
      chargers,
      mfc,
    },
  };
}

/** 能走的格子：员工和机器人走室内，顾客和车辆也能走室外 */
export function walkable(l: Layout, x: number, y: number, outdoors = true): boolean {
  if (x < 0 || y < 0 || x >= l.width || y >= l.height) return false;
  const c = l.cells[y * l.width + x] as Cell;
  return c === Cell.Floor || c === Cell.Door || (outdoors && c === Cell.Outside);
}
