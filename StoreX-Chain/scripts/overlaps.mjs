// 重叠审计（通用部分在独立的程序库 @storewright/overlap-audit，packages/overlap-audit）：把一天里所有的车（外来货车、港口的码头拖车和物流中心的车、物流园场地里的车、机场货站的叉车和机坪车、
// 门店路口和停车场的车）每隔 step 秒取一次车身矩形，统计两两重叠的「车对 × 秒」，按区域、车型对、静止 / 行驶分开。
// 每个区域有一个上限（下面的 LIMITS，按现在测到的数加一点余量）：超了就退出码 1，回归一眼就能看到。
//
// 用法：npm run overlaps -- [--level normal|extreme] [--region random-3] [--step 2] [--only port,park,airport,store,road] [--no-fail]
// （用 tsx 跑：直接引用 TypeScript 源码。区域的仿真、三维的作业计划都和网页里同一套。）
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkLimits, hitched, obbsOverlap, OverlapAuditor, OverlapTally, quadKey, StillTracker } from '@storewright/overlap-audit';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STOREX = path.resolve(ROOT, '../StoreX');
const imp = (p, base = ROOT) => import(pathToFileURL(path.join(base, p)).href);

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d;
};
const LEVEL = opt('level', 'normal');
const REGION = opt('region', 'default');
const STEP = Number(opt('step', 2));
const ONLY = String(opt('only', 'port,park,airport,store,road')).split(',');
const NO_FAIL = argv.includes('--no-fail');
/** --trace 区域：打印这个区域每个车型对的前几个例子（时刻、位置、网格名） */
const TRACE = String(opt('trace', ''));
const examples = new Map();
const traceCells = new Map();

/**
 * 每个区域的上限（车对 × 秒，静止 / 行驶），按负荷分开。数字是 2026-11 测到的值加一点余量（测到的值 × 1.1 + 20，向上取整到 10；
 * 没有重叠的一项是 10）：改动以后超过就是回归。门店只算默认区域（门店的车流按门店仿真的一天，不分负荷）。
 */
const LIMITS = {
  normal: {
    store: { static: 10, moving: 752 },
    'port quay': { static: 10, moving: 5450 },
    'port yard': { static: 10, moving: 1110 },
    'port gate junction': { static: 10, moving: 310 },
    'port logistics': { static: 40, moving: 2460 },
    park: { static: 10, moving: 90 },
    airport: { static: 30, moving: 2900 },
    road: { static: 80, moving: 14870 },
  },
  extreme: {
    store: { static: 10, moving: 752 },
    'port quay': { static: 10, moving: 8280 },
    'port yard': { static: 70, moving: 7640 },
    'port gate junction': { static: 10, moving: 1140 },
    'port logistics': { static: 40, moving: 7970 },
    park: { static: 10, moving: 490 },
    airport: { static: 40, moving: 3770 },
    road: { static: 340, moving: 63980 },
  },
};

// 物流园的标牌用 canvas 画字：脚本里没有浏览器，给一个什么都不画的
globalThis.document ??= { createElement: () => ({ width: 64, height: 64, style: {}, getContext: () => new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 10 }) : () => {}), set: () => true }) }) };

const THREE = await import('three');
const { setRegion } = await imp('src/region/network.ts');
const { DEFAULT_REGION, regionSpecFrom } = await imp('src/region/regionGen.ts');
const { FRAMES } = await imp('src/region/region.ts');
const { toWorld, toLocal } = await imp('src/region/frames.ts');
const { LOADS, scenarioFor, withLoad } = await imp('src/sim/config.ts');
const { runChain } = await imp('src/sim/engine.ts');
const { buildBoard } = await imp('src/sim/board.ts');
const { allocationHour, emptyDay } = await imp('src/sim/plan.ts');
const { TRACE_DAY } = await imp('src/analysis/studies.ts');
const { planPark } = await imp('src/hub/park.ts');
const { inJunction } = await imp('src/hub/portLayout.ts');
const { buildCity } = await imp('web/src/three/regionCity.ts');

const spec = REGION === 'default' ? DEFAULT_REGION : regionSpecFrom(REGION);
setRegion(spec);
const t00 = performance.now();

// —— 区域的仿真（一天）：物流园、港口、机场的作业计划按它排 ——
const sc = withLoad(scenarioFor('g3', 1), LEVEL);
sc.traceDay = TRACE_DAY;
const trace = runChain(sc).trace;
const list = trace.vehicles;
const traffic = LOADS[LEVEL].traffic;
const { net } = buildCity(spec);

// —— 统计（@storewright/overlap-audit 的 OverlapTally）：区域 → 车型对 → 静止 / 行驶（车对 × 秒） ——
const tally = new OverlapTally();
const add = (area, pair, isStatic, sec) => tally.add(area, pair, isStatic, sec);

// —— 车身矩形（四个角）的分离轴相交、牵引车和自己的挂车（hitched：挂车前沿中点离牵引车中心 3.5 米内、朝向差不到 60°）：
//    用 @storewright/overlap-audit 的 quadsOverlap / hitched（四个角的顺序：后、前、前、后，和下面 quads 取的一样）

/** 实例化网格的名字 → 车型（只算车身：箱、灯、货叉、托盘不算） */
const TYPE = [
  [/^ext-(tractors|chassis|trailers|reefers|box-trucks|vans)$/, 'region truck'],
  [/^terminal-(tractors|chassis)$/, 'quay tractor'],
  [/^logi-(tractors|chassis)$/, 'logistics tractor'],
  [/^logi-(cabs|dry|reefer)$/, 'logistics truck'],
  [/^logi-stackers$/, 'reach stacker'],
  [/^park-(terminal-tractors|road-tractors|trailers|reefer-trailers|chassis)$/, 'park vehicle'],
  [/^term-forklifts$/, 'terminal forklift'],
  [/^(apron-tugs|catering-trucks|hydrant-dispensers)$/, 'apron vehicle'],
];
const typeOf = (name) => TYPE.find(([re]) => re.test(name))?.[1];
const m4 = new THREE.Matrix4();
const v = new THREE.Vector3();

/** 一个图层此刻所有车身的矩形（世界坐标）；frame：图层的局部坐标系；still：StillTracker（和上一次取样比，判断停着没动） */
function quads(group, frame, layer, out, still) {
  group.traverse((o) => {
    if (!o.isInstancedMesh) return;
    const type = typeOf(o.name);
    if (!type) return;
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox;
    const tractor = /tractors|cabs/.test(o.name);
    const x0 = b.min.x + (tractor ? 1.9 : 0.45);
    const x1 = b.max.x - 0.25;
    const z0 = b.min.z + 0.12;
    const z1 = b.max.z - 0.12;
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m4);
      const e = m4.elements;
      if (e[13] < -100) continue;
      const p = [];
      for (const [x, z] of [
        [x0, z0],
        [x1, z0],
        [x1, z1],
        [x0, z1],
      ]) {
        v.set(x, 0, z).applyMatrix4(m4);
        const w = frame ? toWorld(frame, { x: v.x, z: v.z }) : { x: v.x, z: v.z };
        p.push(w.x, w.z);
      }
      out.push({ p, layer, name: o.name, type, tractor, still: still.mark(quadKey(o.name, p)) });
    }
  });
}

/** 区域：按第一个车身的中心（世界坐标）分 */
const portBox = (l) => l.x > -3100 && l.x < -1300 && l.z > 1000 && l.z < 1700;
function areaOf(x, z) {
  const pl = toLocal(FRAMES.port, { x, z });
  if (portBox(pl)) {
    if (inJunction(pl)) return 'port gate junction';
    if (pl.x < -2150 && pl.z < 1300) return 'port logistics';
    if (pl.z >= 1365) return 'port quay';
    return 'port yard';
  }
  const al = toLocal(FRAMES.airport, { x, z });
  if (al.x > 1880 && al.x < 2300 && al.z > 880 && al.z < 1120) return 'airport';
  const kl = toLocal(FRAMES.park, { x, z });
  if (kl.x > 700 && kl.x < 1350 && kl.z > -1700 && kl.z < -1300) return 'park';
  return 'road';
}

// —— 港口、机场、外来货车（和物流园场地里的车只算和外来货车碰的那些） ——
if (ONLY.some((k) => ['port', 'airport', 'road', 'park'].includes(k))) {
  const { PortOps } = await imp('web/src/three/ops/port.ts');
  const { AirportOps } = await imp('web/src/three/ops/airport.ts');
  const { ExtTrucks } = await imp('web/src/three/ops/extTrucks.ts');
  const { ParkYard } = await imp('web/src/three/ops/parkYard.ts');
  const board = buildBoard(trace.ops, emptyDay(), { allocation: allocationHour(sc), crossDock: sc.dc.crossDock });
  const byV = new Map(board.ops.filter((o) => o.vehicle >= 0).map((o) => [o.vehicle, o]));
  const place = (d) => (d ? (d.startsWith('C') ? `DCC#${Number(d.slice(1)) - 1}` : `DC#${Number(d.slice(1)) - 1}`) : undefined);
  const parkPlan = planPark({ vehicles: list, doorOf: (vid, key) => (key === 'DC' ? place(byV.get(vid)?.door) : undefined), bookings: board.doors.flatMap((d) => d.bookings.map((b) => ({ door: b.door, t0: b.t0, t1: b.t1, mode: b.mode }))), palletsOf: (vid) => byV.get(vid)?.pallets, seed: 1, traffic, tracks: 2 });
  const yard = new ParkYard(parkPlan.layout);
  yard.setPlan(parkPlan, () => []);
  const drays = list.flatMap((w) => {
    const sg = w.kind === 'drayage' ? w.segs.find((x) => x.act === '在港口堆场装箱') : undefined;
    return sg ? [{ vid: w.id, t0: sg.t0, t1: sg.t1, label: w.label }] : [];
  });
  const port = new PortOps();
  port.setDay({ seed: 1, drays, traffic, passing: [] });
  const air = new AirportOps();
  air.setDay(list.filter((w) => w.kind === 'plane').map((w) => ({ vid: w.id, v: w })), 1, traffic, list.filter((w) => w.segs.some((sg) => sg.act === '在机场货站装车')).map((w) => ({ vid: w.id, v: w })));
  const ext = new ExtTrucks(net);
  ext.setPark(yard.trips());
  ext.setDay(port.gateTrips(), air.dockVisits(), 1);
  const portCam = { x: -2440, y: 120, z: 1200 };
  const airCam = { x: 2040, y: 120, z: 1000 };
  const still = new StillTracker();
  const auditor = new OverlapAuditor({
    tally,
    // 物流园场地里的车之间按每辆车的计划另算（下面），这里只算它们和外来货车碰的
    skip: (a, b) => a.data.layer === 'park' && b.data.layer === 'park',
    // 同一个图层里的牵引车和自己的挂车本来就搭在一起
    ignore: (a, b) => (a.data.tractor && !b.data.tractor && a.data.layer === b.data.layer && hitched(a.shape, b.shape)) || (b.data.tractor && !a.data.tractor && a.data.layer === b.data.layer && hitched(b.shape, a.shape)),
    // 区域按第一个车身的中心分；--only 没选的区域不算
    area: (a) => {
      const area = areaOf((a.shape[0] + a.shape[4]) / 2, (a.shape[1] + a.shape[5]) / 2);
      return ONLY.includes(area.split(' ')[0]) ? area : undefined;
    },
    onOverlap: TRACE
      ? ({ t, a: A, b: B, area, pair, isStatic }) => {
          if (area !== TRACE) return;
          const a = A.data;
          const b = B.data;
          const k = `${pair} ${isStatic ? 'static' : 'moving'}`;
          const l = examples.get(k) ?? [];
          // 港口里按港口局部坐标，别处按世界坐标
          const wx = (a.p[0] + a.p[4]) / 2;
          const wz = (a.p[1] + a.p[5]) / 2;
          const q = area.startsWith('port') ? toLocal(FRAMES.port, { x: wx, z: wz }) : area === 'airport' ? toLocal(FRAMES.airport, { x: wx, z: wz }) : { x: wx, z: wz };
          if (l.length < 4) l.push(`t=${t} ${a.name}${a.still ? '·' : ''} × ${b.name}${b.still ? '·' : ''} @${q.x.toFixed(0)},${q.z.toFixed(0)}`);
          examples.set(k, l);
          const ck = `${Math.round(q.x / 50) * 50},${Math.round(q.z / 50) * 50}`;
          traceCells.set(ck, (traceCells.get(ck) ?? 0) + STEP);
        }
      : undefined,
  });
  for (let t = 0; t < 86400; t += STEP) {
    const qs = [];
    if (ONLY.includes('park')) {
      yard.update(t, true, 1);
      quads(yard.group, FRAMES.park, 'park', qs, still);
    }
    ext.update(t, 1);
    quads(ext.group, undefined, 'ext', qs, still);
    if (ONLY.includes('port')) {
      port.update(t, undefined, portCam);
      quads(port.group, FRAMES.port, 'port', qs, still);
    }
    if (ONLY.includes('airport')) {
      air.update(t, 1, airCam);
      quads(air.group, FRAMES.airport, 'airport', qs, still);
    }
    still.next();
    // 粗筛（均匀网格，30 米一格）和精确的分离轴检验都在库里；车型对按两个车型排序后用「 × 」连起来
    auditor.step(t, qs.map((q) => ({ type: q.type, shape: q.p, still: q.still, data: q })), STEP);
  }
  // —— 物流园场地里的车之间：按每辆车的计划（牵引车 + 挂车 / 骨架车），每秒一次 ——
  if (ONLY.includes('park')) {
    const box = (K, h, front, rear, id, what) => {
      const c = (front - rear) / 2;
      return { cx: K.x + Math.sin(h) * c, cz: K.z + Math.cos(h) * c, ux: Math.sin(h), uz: Math.cos(h), h, hl: (front + rear) / 2 - 0.25, hw: 1.2, id, what };
    };
    // OBB 的分离轴检验（只是贴着不算重叠）
    const ov = (a, b) => obbsOverlap(a, b);
    const o = { x: 0, z: 0, h: 0, th: 0 };
    const last = new Map();
    for (let t = 0; t < 86400; t += 1) {
      const bs = [];
      for (const tr of yard.tracks) {
        const seg = yard.segAt(tr, t);
        if (!seg) continue;
        yard.poseIn(seg, t, o);
        const id = tr.actor.id;
        const k = seg.leg.kind;
        const q = last.get(id);
        const still = !!q && Math.hypot(q.x - o.x, q.z - o.z) < 0.05;
        last.set(id, { x: o.x, z: o.z });
        const mid = (seg.t0 + seg.t1) / 2;
        const tow = k === 'hook' ? (t >= mid ? seg.leg.tow : undefined) : k === 'unhook' ? (t < mid ? seg.leg.tow : undefined) : seg.leg.tow;
        const kind = tr.term ? 'yard tractor' : 'outside truck';
        bs.push({ ...box(o, o.h, tr.term ? 2.9 : 4.4, tr.term ? 1.4 : 1.6, id, k), kind, still });
        if (tow) bs.push({ ...(tow.kind === 'chassis' ? box(o, o.th, 1.0, 11.2, id, k) : box(o, o.th, 1.2, 12.4, id, k)), kind, still });
      }
      for (const u of yard.units) if (t >= u.t0 && t < u.t1) bs.push({ ...(u.tow.kind === 'chassis' ? box(u.pose, u.pose.th, 1.0, 11.2, 'unit', 'parked') : box(u.pose, u.pose.th, 1.2, 12.4, 'unit', 'parked')), kind: 'parked trailer', still: true });
      for (let i = 0; i < bs.length; i++)
        for (let j = i + 1; j < bs.length; j++) {
          const a = bs[i];
          const b = bs[j];
          if (a.id === b.id || Math.abs(a.cx - b.cx) > 20 || Math.abs(a.cz - b.cz) > 20 || !ov(a, b)) continue;
          // 车头倒到要挂的挂车下面、挂上 / 摘下、拉出：和那辆停着的挂车贴在一起是本来的样子
          const work = (x, y) => y.id === 'unit' && /^(back|hook|unhook|pull)/.test(x.what) && Math.hypot(x.cx - y.cx, x.cz - y.cz) < 16;
          if (work(a, b) || work(b, a)) continue;
          add('park', [a.kind, b.kind].sort().join(' × '), a.still && b.still, 1);
        }
    }
  }
}

// —— 门店：门店的车（进出停车场、路口）和背景车流（含门店车的预约）——
if (ONLY.includes('store') && REGION === 'default') {
  try {
    const { runDay } = await imp('src/ops/day.ts', STOREX);
    const { storex } = await imp('src/world/config.ts', STOREX);
    const { deriveVisits } = await imp('src/site/visits.ts');
    const { planStays } = await imp('src/site/stays.ts');
    const { planPeople } = await imp('src/site/people.ts');
    const { planLotTraffic, planPose, modelOf, lotConflicts } = await imp('src/site/motion.ts');
    const { StoreRoads } = await imp('web/src/three/store/roads.ts');
    const { approachPhase, STOP_BACK } = await imp('web/src/three/signals.ts');
    const { TrafficPlanner, CAR_LEN, CAR_W } = await imp('web/src/three/traffic.ts');
    const scx = storex(1);
    scx.trace = true;
    const agents = runDay(scx).trace?.agents ?? [];
    const { net: snet, plan: city } = buildCity(DEFAULT_REGION);
    const site = [...city.sites.values()][0];
    const access = snet.lines[site.access.line];
    const at = snet.storeAttach.get(site.st.key);
    const j = at ? snet.junctions.get(at.junction) : undefined;
    const zIn = site.access.attachZ - (access.trimA + 4);
    const zStop = site.access.attachZ - (access.trimA + STOP_BACK);
    const ways = new StoreRoads(site, snet, zIn, zStop);
    const visits = deriveVisits(agents, { seed: 1, generation: 'storex' });
    const plan = planStays(site.lot, visits, 1);
    const people = planPeople(site.lot, plan.stays, 1);
    const stays = plan.stays;
    const inPhase = stays.map((st) => (j && at && ways.legs.length ? approachPhase(j, ways.inLeg(st.visit.seed).line, at.junction) : undefined));
    const inLead = stays.map((st) => ways.inLead(st.visit.seed, modelOf(st.visit)));
    const outPhase = j && at ? approachPhase(j, access, at.junction) : undefined;
    const lt = planLotTraffic(site.lot, plan, people, { zIn, zStop, speed: 4.0, signal: { offset: j?.offset ?? 0, inPhase, outPhase, inLead } });
    const runs = ways.runs(stays, lt);
    const tr = new TrafficPlanner(snet);
    tr.simulate(9000, undefined, undefined, runs);
    // 门店的车：路口外的进出路段 + 停车场里（门店局部坐标 → 世界）
    const c = Math.cos(site.rot);
    const s = Math.sin(site.rot);
    const lp = { x: 0, z: 0, heading: 0, speed: 0, accel: 0, rev: false, brake: false };
    const st = { x: 0, z: 0, heading: 0 };
    const byT = new Map();
    lt.plans.forEach((p, i) => {
      if (!p) return;
      const seed = stays[i].visit.seed;
      const up = ways.up(seed);
      const dn = ways.down(seed);
      const put = (t, x, z, h) => {
        const l = byT.get(t) ?? [];
        l.push({ cx: x, cz: z, ux: Math.sin(h), uz: Math.cos(h), hl: p.model.len / 2 - 0.2, hw: p.model.wid / 2 - 0.2, i });
        byT.set(t, l);
      };
      const a0 = up ? p.tIn - up.path.duration : p.tIn;
      for (let t = Math.ceil(a0); t <= p.tOut + (dn ? dn.path.duration : 0); t += 1) {
        if (t < p.tIn && up) {
          up.path.at(t - a0, st);
          put(t, st.x, st.z, st.heading);
        } else if (t > p.tOut && dn && p.exit.length) {
          dn.path.at(t - p.tOut, st);
          put(t, st.x, st.z, st.heading);
        } else if (planPose(p, t, lp)) put(t, site.center.x + lp.x * c + lp.z * s, site.center.z - lp.x * s + lp.z * c, lp.heading + site.rot);
      }
    });
    // OBB 的分离轴检验（这里贴着也算重叠，和原来一样）
    const ov = (a, b) => obbsOverlap(a, b, { touching: true });
    const tp = { x: 0, y: 0, z: 0, yaw: 0, brake: false, turn: 0, rev: false, lot: false, parked: false };
    const tp2 = { ...tp };
    const lastStore = new Map();
    for (const [t, bs] of [...byT].sort((x, y) => x[0] - y[0])) {
      for (const a of bs) {
        const q = lastStore.get(a.i);
        a.still = !!q && Math.hypot(q.x - a.cx, q.z - a.cz) < 0.05 && q.t === t - 1;
        lastStore.set(a.i, { x: a.cx, z: a.cz, t });
      }
      for (const ci of tr.activeAt(t)) {
        const car = tr.cars[ci];
        const L = CAR_LEN[car.kind];
        // 门店的车都在地面上（干道、进店路）：高架、立交上面开过去的车不算
        if (!tr.pose(car, t, tp, L) || tp.parked || tp.y > 2.5) continue;
        const dx = Math.cos(tp.yaw);
        const dz = -Math.sin(tp.yaw);
        const b = { cx: tp.x + (dx * L) / 2, cz: tp.z + (dz * L) / 2, ux: dx, uz: dz, hl: L / 2 - 0.2, hw: CAR_W[car.kind] / 2 - 0.2 };
        for (const a of bs) {
          if (Math.abs(a.cx - b.cx) > 14 || Math.abs(a.cz - b.cz) > 14 || !ov(a, b)) continue;
          tr.pose(car, t - 1, tp2, L);
          const stillBg = Math.hypot(tp2.x - tp.x, tp2.z - tp.z) < 0.05;
          add('store', `store car × ${car.kind === 2 ? 'bus' : 'background car'}`, a.still && stillBg, 1);
        }
      }
    }
    const cc = lotConflicts(site.lot, lt, people);
    if (cc.carCar) add('store', 'store car × store car (lot)', false, cc.carCar);
  } catch (e) {
    console.error('门店部分没跑成：', String(e).slice(0, 300));
  }
}

// —— 报告 ——
const limits = LIMITS[LEVEL] ?? LIMITS.normal;
// 上限检查（库的 checkLimits）：先列有上限的区域，再列其他出现过的；随机区域只报告、不判超
const report = checkLimits(tally, limits, { enforce: REGION === 'default', topPairs: 4 });
const bad = report.over;
console.log(`重叠审计 · ${REGION} · ${LEVEL} · 每 ${STEP} 秒（物流园场地、门店每 1 秒）· ${Math.round((performance.now() - t00) / 1000)} 秒`);
console.log('区域'.padEnd(20), '静止'.padStart(8), '行驶'.padStart(8), '上限（静止 / 行驶）'.padStart(16), '');
for (const row of report.rows) {
  console.log(row.area.padEnd(20), String(row.static).padStart(8), String(row.moving).padStart(8), (row.limit ? `${row.limit.static} / ${row.limit.moving}` : '—').padStart(16), row.over ? '超了' : '');
  for (const p of row.pairs) console.log('   ', p.pair.padEnd(44), String(p.static).padStart(7), String(p.moving).padStart(7));
}
for (const [k, l] of examples) console.log('  例：', k, '\n     ', l.join('\n      '));
if (TRACE) console.log('  最多的地方（50 米一格）：', [...traceCells].sort((x, y) => y[1] - x[1]).slice(0, 14).map(([k, n]) => `${k}:${n}`).join(' '));
if (bad && !NO_FAIL) {
  console.log(`有 ${bad} 个区域超过上限`);
  process.exit(1);
}
