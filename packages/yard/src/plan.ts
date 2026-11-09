import type { Pt, YardDoor, YardInput, YardMark, YardPlan, YardStall, YardVehicle } from './index';
import { DOCK_GAP, DOOR_LEAD, LANE_GAP, R_IN, R_PULL, R_ROAD, R_U, STALL_W } from './consts';
import { backOf, dimsOf, lengthOf, VEHICLE_DIMS } from './rig';
import { dockSetup, parkedNeighbours, type FaceGeo } from './setup';

/**
 * 场地的布置（第一部分 Storewright 决策记录 0018、0019 的卸货场，按车型尺寸和场地大小推广）。
 *
 * 车道从墙往外：靠台车道（向 +x）、驶离车道（向 −x）、待命车道（向 −x，先到的车在 −x 头）、顶部车道（向 +x）。
 * - 右侧进场（进场道路在 +x 头）：上来 → 右转（从远端下来是左转）进待命车道排队 → −x 头右转掉头下到靠台车道；
 *   驶离：拉出 → 右转上驶离车道 → −x 头左转掉头上顶部车道 → +x 头转下进场道路；
 * - 左侧进场（进场道路在 −x 头）：上来 → 左转（从远端下来是右转）上顶部车道 → +x 头左转掉头下到待命车道排队 →
 *   −x 头右转掉头下到靠台车道；驶离：拉出 → 右转上驶离车道 → 一直向 −x 到进场道路转出去。
 * 进深不够时：右侧进场去掉顶部车道（compact：拉出后左转上一条向 +x 的驶离车道，直接回进场道路）；
 * 左侧进场只留靠台车道和驶离车道（court：从进场道路直接拐进靠台车道，排队排在进场道路上）。
 *
 * 车道位置按设计车型（门能靠的最长的车）算：门口停着的车车头连成一线（noseLine），挂车在 alignZ（默认 24 米、
 * 不小于 noseLine + 1.75）以外摆正；拉出时挂车尾部越过车头线 1.2 米再转弯（半径 12.8 米）；车道之间掉头的半径不小于 12 米。
 * 靠台车道离墙多远，按每个门都能找到一组顺利倒进去的准备动作来定（从 alignZ + 6.5 起往外试）。
 */
const ALL: YardVehicle[] = ['semi', 'reefer', 'chassis', 'truck', 'van', 'shunter'];
const DESIGN_ORDER: YardVehicle[] = ['semi', 'reefer', 'chassis', 'truck', 'van'];

interface Geometry {
  level: YardPlan['level'];
  zCourt: number;
  zExit: number;
  zQueue: number;
  zTop: number;
  depthNeed: number;
}

/** 按靠台车道的位置排其余车道；level 不给就按进深挑能放下的最完整的布置 */
function lanes(input: YardInput, rig: boolean, zCourt: number, zTurn: number, stallD: number): Geometry[] {
  const zExit = Math.max(zTurn + R_PULL, zCourt + 8);
  const zQueue = Math.max(zExit + LANE_GAP, zCourt + 2 * R_U);
  const zTop = zQueue + 2 * R_U;
  const wantStalls = (input.drop ?? 0) > 0;
  // 从场地远端进出时，接进场道路的转弯（半径 13 米）要在场地里转完
  const front = (input.from ?? 'back') === 'front';
  const reach = (...zs: number[]) => (front ? Math.max(...zs.map((z) => z + R_IN + 2)) : 0);
  const full: Geometry = { level: 'full', zCourt, zExit, zQueue, zTop, depthNeed: Math.max(wantStalls ? zTop + 6 + stallD : zTop + 4, reach(zTop)) };
  void rig;
  if (input.side === 'right') return [full, { level: 'compact', zCourt, zExit, zQueue, zTop: NaN, depthNeed: Math.max(zQueue + 4, reach(zQueue, zExit)) }];
  return [full, { level: 'court', zCourt, zExit, zQueue: NaN, zTop: NaN, depthNeed: Math.max(zExit + 5, reach(zCourt, zExit)) }];
}

const PLAN_CACHE = new Map<string, YardPlan>();

/**
 * 排场地（同样的输入、同样的车型尺寸只排一次；结果不要改）
 * Lay out a yard from doors, extent, access side and type (cached per input and vehicle dimensions; treat the result as read-only).
 */
export function planYard(input: YardInput): YardPlan {
  const key = `${JSON.stringify(input)}|${JSON.stringify(VEHICLE_DIMS)}`;
  let p = PLAN_CACHE.get(key);
  if (!p) {
    p = planYardNow(input);
    if (PLAN_CACHE.size > 64) PLAN_CACHE.clear();
    PLAN_CACHE.set(key, p);
  }
  return p;
}

function planYardNow(input: YardInput): YardPlan {
  const notes: string[] = [];
  const side = input.side;
  const from = input.from ?? 'back';
  const access = input.access ?? 'drive';
  const driveHalf = input.driveHalf ?? 4.5;
  const laneOff = driveHalf / 2;
  const driveX = input.driveX ?? (side === 'right' ? input.x1 - driveHalf : input.x0 + driveHalf);
  const driveLen = input.driveLen ?? 60;
  // 进场道路右侧通行：上来（朝 +z）走 −x 半边，下来（朝 −z）走 +x 半边
  const xIn = from === 'back' ? driveX - laneOff : driveX + laneOff;
  const xOut = from === 'back' ? driveX + laneOff : driveX - laneOff;

  const raw = input.doors.map((d) => (typeof d === 'number' ? { x: d } : d));
  if (!raw.length) raw.push({ x: (input.x0 + input.x1) / 2 });
  const kindsOf = (d: (typeof raw)[number]) => ('kinds' in d && d.kinds?.length ? d.kinds : ALL);
  const present = new Set(raw.flatMap((d) => kindsOf(d)));
  const design = DESIGN_ORDER.filter((k) => present.has(k)).sort((a, b) => lengthOf(b) - lengthOf(a))[0] ?? 'semi';
  const D = dimsOf(design);
  const rig = D.kind === 'rig';
  const len = lengthOf(D);
  const noseLine = DOCK_GAP + len;
  const alignZ = rig ? Math.max(input.alignAt ?? 24, noseLine + 1.75) : noseLine + 2;
  const zTurn = noseLine + 1.2 + backOf(D);
  const trailerLen = D.kind === 'rig' ? D.trailerFront + D.rear : len;
  const stallD = trailerLen + 1.5;
  const doorXs = raw.map((d) => d.x);
  const minDoor = Math.min(...doorXs);
  const maxDoor = Math.max(...doorXs);
  const pitch = len + 3;
  const span = input.sectionSpan ?? 70;

  const build = (g: Geometry) => {
    const rDock = Number.isFinite(g.zQueue) ? (g.zQueue - g.zCourt) / 2 : 0;
    const rExitU = g.level === 'full' ? (g.zTop - g.zExit) / 2 : 0;
    const nDoors = raw.length;
    const want = input.queue && input.queue > 0 ? Math.min(20, Math.round(input.queue)) : 0;
    const auto = Math.min(10, Math.max(2, 2 + Math.ceil(nDoors / 3)));
    let slots = 0;
    let xHead: number;
    let xTurnDock: number;
    let xTurnExit: number;
    let xEast: number;
    let x0: number;
    let x1: number;
    const local: string[] = [];
    if (side === 'right') {
      const tailRear = xIn - R_IN - 3;
      const bulge = Math.max(rDock, g.level === 'full' ? 2 + rExitU : 0) + 2.3;
      const xHeadMin = input.x0 + bulge + 2;
      const fit = Math.floor((tailRear - len - xHeadMin) / pitch) + 1;
      slots = Math.max(0, Math.min(want || auto, fit));
      if (want && slots < want) local.push(`待命车道只放得下 ${slots} 个车位（要 ${want} 个），其余排在进场道路上`);
      xHead = tailRear - len - Math.max(0, slots - 1) * pitch;
      xTurnDock = Math.min(xHead - 2, minDoor - DOOR_LEAD);
      xTurnExit = xTurnDock - 2;
      xEast = xIn;
      x0 = xTurnDock - bulge;
      x1 = driveX + driveHalf;
      if (x0 < input.x0 - 0.01) local.push(`场地 −x 头要到 ${x0.toFixed(1)}（给的是 ${input.x0.toFixed(1)}）：掉头和驶近卸货门的直线放不下`);
    } else {
      const west = driveX + driveHalf;
      x0 = driveX - driveHalf;
      if (g.level === 'court') {
        xTurnDock = xIn + R_IN;
        xHead = xTurnDock;
        xTurnExit = xTurnDock;
        xEast = maxDoor + 12;
        x1 = Math.max(maxDoor + 22, xTurnDock + 10);
        if (minDoor - DOOR_LEAD < xTurnDock) local.push(`最靠 −x 的门离进场道路太近（要 ${DOOR_LEAD} 米的直线驶近）`);
      } else {
        xTurnDock = Math.max(west + rDock + 3.5, Math.min(minDoor - DOOR_LEAD, west + rDock + 27));
        xHead = xTurnDock + 2;
        const fit = Math.floor((input.x1 - (R_U + 2.3) - 3 - len - xHead) / pitch) + 1;
        slots = Math.max(0, Math.min(want || auto, fit));
        if (want && slots < want) local.push(`待命车道只放得下 ${slots} 个车位（要 ${want} 个），其余排在进场道路上`);
        xEast = Math.max(xHead + Math.max(0, slots - 1) * pitch + len + 3, maxDoor + 12);
        xTurnExit = xTurnDock;
        x1 = Math.max(xEast + R_U + 2.3, maxDoor + 22);
        if (minDoor - DOOR_LEAD < xTurnDock - 0.01) local.push(`最靠 −x 的门离靠台车道的起点太近（要 ${DOOR_LEAD} 米的直线驶近）`);
      }
      if (x1 > input.x1 + 0.01) local.push(`场地 +x 头要到 ${x1.toFixed(1)}（给的是 ${input.x1.toFixed(1)}）`);
    }
    // 有甩挂车位时，待命车道是场内牵引车和取挂车的通道：不画待命车位，来车在进场道路 / 场外等候区排队
    if ((input.drop ?? 0) > 0 && g.level === 'full' && slots > 0) {
      slots = 0;
      local.push('有甩挂车位：待命车道当场内通道用，来车在进场道路和场外等候区排队');
    }
    return { rDock, rExitU, slots, xHead, xTurnDock, xTurnExit, xEast, x0, x1, local };
  };

  // 靠台车道离墙多远：从 alignZ + 6.5 起往外试，每个门都能找到一组顺利倒进去的准备动作
  const offsets = rig ? [6.5, 8, 9.5, 11, 13, 15] : [9, 11, 13];
  const base = rig ? alignZ : noseLine;
  let best: { g: Geometry; b: ReturnType<typeof build>; ok: number; fail: number[] } | undefined;
  for (const off of offsets) {
    const opts = lanes(input, rig, base + off, zTurn, stallD);
    const g = opts.find((o) => o.depthNeed <= input.depth + 1e-6) ?? (opts[opts.length - 1] as Geometry);
    const b = build(g);
    const zLimit = Number.isFinite(g.zQueue) ? g.zQueue - 2.5 : g.depthNeed - 1.5;
    const xMax = side === 'right' ? driveX - driveHalf - 0.5 : Math.max(b.x1, input.x1) - 1;
    const fail: number[] = [];
    raw.forEach((d, i) => {
      const geo: FaceGeo = { zCourt: g.zCourt, zLimit, xMax, alignZ, noseLine, parked: parkedNeighbours(D, doorXs, d.x) };
      if (!dockSetup(D, d.x, geo, b.xTurnDock + 2).ok) fail.push(i);
    });
    const ok = raw.length - fail.length;
    if (!best || ok > best.ok) best = { g, b, ok, fail };
    if (!fail.length) break;
  }
  const { g, b, fail } = best as NonNullable<typeof best>;
  notes.push(...b.local);
  if (g.depthNeed > input.depth + 1e-6) notes.push(`进深不够：${g.level === 'full' ? '完整布置' : '最紧凑的布置'}要 ${g.depthNeed.toFixed(1)} 米，只有 ${input.depth.toFixed(1)} 米`);
  if (g.level !== 'full') notes.push(g.level === 'compact' ? '进深放不下顶部车道：驶离的车拉出后左转，沿一条向 +x 的驶离车道直接回进场道路' : '进深放不下待命车道：车在进场道路上排队，从进场道路直接拐进靠台车道');
  if (fail.length) notes.push(`${fail.map((i) => raw[i]?.id ?? `门 ${i + 1}`).join('、')} 找不到能从司机一侧顺利倒进去的准备动作（门太靠场地边或门间距太小）`);
  // 拉出转上驶离车道以后，到进场道路的转弯之前要有直线：左侧进场时门离进场道路、紧凑布置时门离进场道路都不能太近
  const rTurn = g.zExit - zTurn;
  const exitBad = raw.filter((d) => (side === 'left' ? d.x - rTurn < xOut + 13 + 2 : g.level === 'compact' ? d.x + rTurn > xOut - 13 - 2 : d.x - rTurn < b.xTurnExit + 2));
  if (exitBad.length) notes.push(`${exitBad.map((d) => ('id' in d && d.id) || `x=${d.x.toFixed(1)}`).join('、')} 离进场道路太近：拉出转弯以后接不上驶离的转弯（要离进场道路至少 ${(rTurn + 15 + Math.abs(xOut - driveX)).toFixed(0)} 米）`);
  if ((input.drop ?? 0) > 0 && g.level !== 'full') notes.push('甩挂车位要完整布置（顶部车道外侧）才放得下，这里没有放');

  // 门和区段
  const xs0 = minDoor - 20;
  const xs1 = maxDoor + 25;
  const nSec = Math.max(1, Math.ceil((xs1 - xs0) / span));
  const w = (xs1 - xs0) / nSec;
  const sections = Array.from({ length: nSec }, (_, i) => ({ x0: xs0 + i * w, x1: xs0 + (i + 1) * w }));
  const doors: YardDoor[] = raw.map((d, i) => ({
    x: d.x,
    kinds: [...kindsOf(d)],
    cold: 'cold' in d ? !!d.cold : false,
    id: 'id' in d && d.id ? d.id : `门${i + 1}`,
    section: Math.min(nSec - 1, Math.max(0, Math.floor((d.x - xs0) / w))),
  }));

  // 甩挂车位：顶部车道外侧一排，挂车车头朝顶部车道（−z）
  const stalls: YardStall[] = [];
  let z1 = Math.max(g.depthNeed - ((input.drop ?? 0) > 0 && g.level === 'full' ? 6 + stallD - 4 : 0), 0);
  if (g.level === 'full') {
    z1 = Math.max(g.zTop + 4, from === 'front' ? g.zTop + R_IN + 2 : 0);
    const zFront = g.zTop + 5;
    const sx0 = side === 'right' ? b.x0 + 26 : xIn + R_IN + 8;
    const sx1 = side === 'right' ? xIn - R_IN - 6 : b.xEast - 4;
    const n = Math.max(0, Math.min(input.drop ?? 0, Math.floor((sx1 - sx0) / STALL_W)));
    if ((input.drop ?? 0) > n) notes.push(`甩挂车位只放得下 ${n} 个（要 ${input.drop} 个）`);
    const tf = D.kind === 'rig' ? D.trailerFront : 0;
    const ta = D.kind === 'rig' ? D.axle : 0;
    for (let k = 0; k < n; k++) stalls.push({ x: sx0 + (k + 0.5) * STALL_W, z: zFront + 0.3 + tf + ta, heading: Math.PI, id: `甩挂${k + 1}` });
    if (n) z1 = Math.max(z1, zFront + stallD + 1);
  } else z1 = g.depthNeed;

  const gateZ = from === 'back' ? 0 : z1;
  // 给了路口外的道路：进场道路在场外的长度就是到路边的距离
  const road = input.road;
  const driveOut = road ? Math.max(5, from === 'back' ? -(road.z + road.half) : road.z - road.half - z1) : driveLen;
  const plan: YardPlan = {
    level: g.level,
    notes,
    side,
    from,
    access,
    x0: b.x0,
    x1: b.x1,
    z1,
    doors,
    design,
    driveX,
    driveHalf,
    xIn,
    xOut,
    driveLen: driveOut,
    zCourt: g.zCourt,
    zExit: g.zExit,
    zQueue: g.zQueue,
    zTop: g.zTop,
    noseLine,
    alignZ,
    apronZ: noseLine + 1,
    queue: { slots: b.slots, pitch, xHead: b.xHead, dir: -1, onDrive: 0 },
    xTurnDock: b.xTurnDock,
    xTurnExit: b.xTurnExit,
    xEast: b.xEast,
    gateIn: { x: xIn, z: gateZ },
    gateOut: { x: xOut, z: gateZ },
    stalls,
    sections,
    marks: [],
    input: { ...input, doors: [...input.doors] },
  };
  plan.queue.onDrive = Math.max(0, Math.floor(driveOut / pitch));
  plan.marks = marks(plan, len, stallD);
  if (input.road) plan.junction = junction(plan, input.road);
  return plan;
}

/** 要画的线、箭头、车位框、停止线和牌子 */
function marks(p: YardPlan, len: number, stallD: number): YardMark[] {
  const out: YardMark[] = [];
  const xa = p.side === 'right' ? p.xTurnDock : p.xTurnDock;
  const xb = p.side === 'right' ? p.driveX - p.driveHalf : p.x1 - 2;
  const lanesZ = [p.zCourt, p.zExit, p.zQueue, p.zTop].filter((z) => Number.isFinite(z)).sort((a, b) => a - b);
  // 车道之间的白色虚线
  for (let i = 1; i < lanesZ.length; i++) {
    const z = ((lanesZ[i - 1] as number) + (lanesZ[i] as number)) / 2;
    if ((lanesZ[i] as number) - (lanesZ[i - 1] as number) < 5) continue;
    out.push({ kind: 'line', pts: [{ x: xa, z }, { x: xb, z }], color: 'white', dashed: true, width: 0.15 });
  }
  // 行车方向箭头：靠台车道、顶部车道向 +x，驶离车道、待命车道向 −x（紧凑布置的驶离车道向 +x）
  const dirs: Array<[number, number]> = [
    [p.zCourt, Math.PI / 2],
    [p.zExit, p.level === 'compact' ? Math.PI / 2 : -Math.PI / 2],
    [p.zQueue, -Math.PI / 2],
    [p.zTop, Math.PI / 2],
  ];
  for (const [z, h] of dirs) {
    if (!Number.isFinite(z)) continue;
    for (let x = xa + 12; x < xb - 8; x += 32) out.push({ kind: 'arrow', at: { x, z }, heading: h });
  }
  // 门前的对位线（每个门两条，从墙到车头线）
  for (const d of p.doors)
    for (const s of [-1, 1]) out.push({ kind: 'line', pts: [{ x: d.x + s * 1.65, z: 0.4 }, { x: d.x + s * 1.65, z: Math.min(p.noseLine - 2, 15) }], color: 'yellow', width: 0.12 });
  // 待命车位框和排头的停止线
  for (let j = 0; j < p.queue.slots; j++) out.push({ kind: 'box', at: { x: p.queue.xHead + j * p.queue.pitch + len / 2, z: p.zQueue }, heading: -Math.PI / 2, w: 3.6, d: len + 1, label: `待命 ${j + 1}` });
  if (p.queue.slots) out.push({ kind: 'stop', a: { x: p.queue.xHead - 1, z: p.zQueue - 1.8 }, b: { x: p.queue.xHead - 1, z: p.zQueue + 1.8 } });
  // 甩挂车位框
  for (const s of p.stalls) out.push({ kind: 'box', at: { x: s.x, z: p.zTop + 5 + stallD / 2 }, heading: Math.PI, w: STALL_W - 0.2, d: stallD, label: s.id });
  // 进场道路中间的双黄线、「货车入口」牌
  const zA = p.from === 'back' ? -p.driveLen : p.z1;
  const zB = p.from === 'back' ? (p.side === 'right' ? (Number.isFinite(p.zQueue) ? p.zQueue - R_IN : p.zCourt) : Number.isFinite(p.zTop) ? p.zTop - R_IN : p.zCourt - R_IN) : p.z1 + p.driveLen;
  for (const s of [-0.12, 0.12]) out.push({ kind: 'line', pts: [{ x: p.driveX + s, z: Math.min(zA, zB) }, { x: p.driveX + s, z: Math.max(zA, zB) }], color: 'yellow', width: 0.1 });
  const signSide = p.from === 'back' ? -1 : 1;
  out.push({ kind: 'sign', at: { x: p.xIn + signSide * (p.driveHalf / 2 + 1.6), z: p.from === 'back' ? -8 : p.z1 + 8 }, heading: p.from === 'back' ? Math.PI : 0, text: '货车入口' });
  return out;
}

/** 接路口：喇叭口的沥青面（专用通道半径 15 米，支路 6 米）、驶出车道的停止线 */
function junction(p: YardPlan, road: NonNullable<YardInput['road']>): NonNullable<YardPlan['junction']> {
  const back = p.from === 'back';
  const edge = back ? road.z + road.half : road.z - road.half;
  const r = p.access === 'drive' ? R_ROAD : 6;
  const s = back ? 1 : -1;
  const flares: Pt[][] = [];
  for (const e of [-1, 1]) {
    const xe = p.driveX + e * p.driveHalf;
    const cx = xe + e * r;
    const cz = edge + s * r;
    const poly: Pt[] = [{ x: xe, z: edge }];
    for (let k = 0; k <= 12; k++) {
      const a = (k / 12) * (Math.PI / 2);
      // 从路边 (cx, edge) 绕到通道边 (xe, cz)
      poly.push({ x: cx - e * r * Math.sin(a), z: cz - s * r * Math.cos(a) });
    }
    flares.push(poly);
  }
  const zs = edge + s * (p.access === 'drive' ? 3 : 1.5);
  const outSide = Math.sign(p.xOut - p.driveX) || 1;
  return { flares, stop: { a: { x: p.driveX, z: zs }, b: { x: p.driveX + outSide * p.driveHalf, z: zs } }, signal: p.access === 'street', yieldSec: 5 };
}
