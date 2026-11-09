// 三维回归检查：开发服务器开着时（npm run dev）运行  node scripts/check3d.mjs [地址]
//
// 对默认区域和两个随机区域、平常和极限负荷，用无界面的浏览器打开网页，检查：
//   1. 页面没有报错；
//   2. 车、火车、船、飞机不瞬移：一天里几段时间、每秒取一次位置，每秒的位移不超过这种交通工具合理的速度
//      （区域的路按沙盘缩成 1/10，设施里按真实尺寸，所以上限按真实尺寸里的速度定）；
//   3. 播放时的帧时间（中位数、95% 分位数）不超过预算；
//   4. 演示导览（默认区域）：极限负荷那一天来自仿真记录的段比平常那一天多，结束卡上的「换到极限负荷再看」只在平常那天出现；
//   5. 仿真车的重叠审计（重叠审计 npm run overlaps 不含区域车辆层的仿真车）：一整天每 2 秒取一次，仿真车之间、仿真车和区域货车（外来货车）之间
//      车身相交的「车对 × 秒」，分静止（两辆都没动）/ 行驶；静止的超过上限算问题（上限的定法和重叠审计一样）。
// 有问题时列出来，退出码 1。浏览器用本机装的 Chrome（Playwright 的 channel: 'chrome'）。
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:5182/';
const CASES = [
  { q: '', load: 'normal' },
  { q: '', load: 'extreme' },
  { q: '?region=random-3', load: 'normal' },
  { q: '?region=random-11', load: 'high' },
];
/** 每秒最多走多远（米）：飞机落地滑跑约 80 米 / 秒，船、火车、汽车按真实尺寸里的速度再留余量 */
const MAX = { plane: 130, ship: 20, train: 45, default: 35 };
const WINDOWS = [6.2, 9, 12.5, 17.5, 21];
const FRAME_BUDGET = { p50: 33, p95: 80 };
/**
 * 5. 仿真车「两辆都停着、车身相交」的车对 × 秒的上限（每 2 秒取样）：sim = 仿真车之间，ext = 仿真车 × 区域货车。
 * 2026-11 测到的值 × 1.1 + 20，向上取整到 10；没有重叠的一项是 10。和重叠审计一样：改动以后超过就是回归，上限只能往紧里改。
 */
const SIM_STATIC = {
  // 2026-11-09 测到：仿真车之间都是 0；仿真车 × 区域货车 0 / 118 / 8 / 88（机场货站、港口提箱、路上，区域货车那边的计划没让仿真车）
  '|normal': { sim: 10, ext: 10 },
  '|extreme': { sim: 10, ext: 150 },
  '?region=random-3|normal': { sim: 10, ext: 30 },
  '?region=random-11|high': { sim: 10, ext: 120 },
};

const problems = [];
/** 默认区域各负荷的导览：几段、几段是仿真记录、结束卡有没有「换到极限负荷再看」 */
const tourCounts = {};
const browser = await chromium.launch({ channel: 'chrome' });
for (const c of CASES) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  // 挡住开发服务器的热更新：检查中途有文件改动时页面不会整页刷新（结果只看这一次载入）
  await page.routeWebSocket(/localhost:5182/, () => {});
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 300)));
  await page.goto(BASE + c.q);
  await page.waitForFunction(() => document.getElementById('busy')?.hidden === true, null, { timeout: 300000 });
  // 机场、港口的作业在页面就绪以后分段排（view.plansPending）：排完再测
  await page.waitForFunction(() => !window.__twin?.view?.plansPending, null, { timeout: 300000 });
  await page.waitForTimeout(3000);
  if (c.load !== 'normal') {
    await page.selectOption('#load', c.load);
    await page.waitForTimeout(1500);
    await page.waitForFunction(() => document.getElementById('busy')?.hidden === true, null, { timeout: 300000 });
    await page.waitForFunction(() => !window.__twin?.view?.plansPending, null, { timeout: 300000 });
    await page.waitForTimeout(3000);
  }
  await page.evaluate(() => { const b = document.getElementById('play'); if (b && b.textContent !== '▶') b.click(); });
  // 2. 每秒取一次位置
  const jumps = await page.evaluate(({ windows, max }) => {
    const v = window.__twin?.view;
    if (!v) return { error: '没有调试接口（要用开发服务器）' };
    const items = v.vehicles.items;
    const worst = {};
    const bad = [];
    for (const h of windows) {
      let prev = [];
      for (let s = 0; s <= 120; s++) {
        const t = h * 3600 + s;
        v.vehicles.update(t, 1);
        const cur = items.map((_, i) => { const p = v.vehicles.poseOf(i); return p ? { x: p.x, z: p.z ?? p.y } : undefined; });
        if (s > 0)
          cur.forEach((p, i) => {
            const q = prev[i];
            if (!p || !q) return;
            const d = Math.hypot(p.x - q.x, p.z - q.z);
            const kind = items[i].kind;
            worst[kind] = Math.max(worst[kind] ?? 0, d);
            if (d > (max[kind] ?? max.default)) bad.push(`${items[i].label} 在 ${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')} 一秒走了 ${d.toFixed(0)} 米`);
          });
        prev = cur;
      }
    }
    return { worst, bad: bad.slice(0, 8), n: bad.length };
  }, { windows: WINDOWS, max: MAX });
  // 5. 仿真车的重叠：一整天每 2 秒，仿真车（公路车辆）的车身按车头位置、朝向、整车长的矩形；区域货车按 poseAt 和车长
  const sim = await page.evaluate(() => {
    const v = window.__twin?.view;
    if (!v) return undefined;
    const VH = v.vehicles;
    const E = v.ext;
    // 车队间距刚换上时开着的车先照旧的那一小段和换上的时刻有关：比换好以后的样子；取样时不画社会车流
    if (VH.holds) VH.holds = [];
    const trafficWas = VH.traffic;
    VH.traffic = false;
    const roadIdx = [];
    VH.roads.forEach((rd, i) => rd && roadIdx.push(i));
    const box = (x, z, dir, L) => {
      const ux = Math.cos(dir);
      const uz = Math.sin(dir);
      return { cx: x - (ux * L) / 2, cz: z - (uz * L) / 2, ux, uz, hl: L / 2 - 0.3, hw: 1.15 };
    };
    const hit = (A, B) => {
      for (const [ax, az] of [[A.ux, A.uz], [-A.uz, A.ux], [B.ux, B.uz], [-B.uz, B.ux]]) {
        const pr = (o) => Math.abs(o.ux * ax + o.uz * az) * o.hl + Math.abs(-o.uz * ax + o.ux * az) * o.hw;
        if (Math.abs((A.cx - B.cx) * ax + (A.cz - B.cz) * az) > pr(A) + pr(B)) return false;
      }
      return true;
    };
    const out = { sim: { st: 0, mv: 0 }, ext: { st: 0, mv: 0 }, ms: 0, ex: [] };
    const last = new Map();
    const t0 = performance.now();
    const STEP = 2;
    for (let t = 0; t < 86400; t += STEP) {
      VH.update(t, 1);
      const grid = new Map();
      const sims = [];
      for (const i of roadIdx) {
        const p = VH.poseOf(i);
        if (!p) continue;
        const q = last.get(i);
        const o = { i, x: p.x, z: p.y, still: !!q && Math.hypot(q.x - p.x, q.z - p.y) < 0.05, b: box(p.x, p.y, p.dir, VH.roads[i].build.L) };
        last.set(i, { x: p.x, z: p.y });
        sims.push(o);
        const k = `${Math.floor(o.x / 50)},${Math.floor(o.z / 50)}`;
        (grid.get(k) ?? grid.set(k, []).get(k)).push(o);
      }
      const near = (x, z) => {
        const gx = Math.floor(x / 50);
        const gz = Math.floor(z / 50);
        const r = [];
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const o of grid.get(`${gx + dx},${gz + dz}`) ?? []) r.push(o);
        return r;
      };
      const tally = (kind, A, B, label) => {
        if (Math.hypot(A.x - B.x, A.z - B.z) > 40 || !hit(A.b, B.b)) return;
        const st = A.still && B.still;
        out[kind][st ? 'st' : 'mv'] += STEP;
        if (st && out.ex.length < 4) out.ex.push(`${label} ${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')} @${A.x.toFixed(0)},${A.z.toFixed(0)}`);
      };
      for (const A of sims) for (const B of near(A.x, A.z)) if (A.i < B.i) tally('sim', A, B, `${VH.items[A.i].label.slice(0, 10)} × ${VH.items[B.i].label.slice(0, 10)}`);
      for (let j = 0; j < E.count; j++) {
        const p = E.poseAt(j, t);
        if (!p) continue;
        const q = last.get(`e${j}`);
        const B = { x: p.x, z: p.z, still: !!q && Math.hypot(q.x - p.x, q.z - p.z) < 0.05, b: box(p.x, p.z, -p.yaw, E.len(E.trucks[j])) };
        last.set(`e${j}`, { x: p.x, z: p.z });
        for (const A of near(B.x, B.z)) tally('ext', A, B, `${VH.items[A.i].label.slice(0, 10)} × 区域货车`);
      }
    }
    VH.traffic = trafficWas;
    out.ms = Math.round(performance.now() - t0);
    return out;
  });
  // 3. 播放时的帧时间
  const frames = await page.evaluate(async () => {
    const speed = document.getElementById('speed');
    speed.value = '600';
    speed.dispatchEvent(new Event('change'));
    const ti = document.getElementById('time');
    ti.value = String(8 * 3600);
    ti.dispatchEvent(new Event('input'));
    document.getElementById('play').click();
    const dts = [];
    let last = performance.now();
    await new Promise((resolve) => {
      const tick = (now) => { dts.push(now - last); last = now; if (dts.length < 240) requestAnimationFrame(tick); else resolve(); };
      requestAnimationFrame(tick);
    });
    document.getElementById('play').click();
    dts.sort((a, b) => a - b);
    return { p50: dts[Math.floor(dts.length * 0.5)], p95: dts[Math.floor(dts.length * 0.95)] };
  });
  const name = `${c.q || '默认区域'} · ${c.load}`;
  console.log(`${name}：最大每秒位移 ${Object.entries(jumps.worst ?? {}).map(([k, d]) => `${k} ${d.toFixed(1)} 米`).join('、')}；帧时间中位数 ${frames.p50.toFixed(1)} 毫秒、95% ${frames.p95.toFixed(1)} 毫秒；报错 ${errs.length} 条`);
  if (jumps.error) problems.push(`${name}：${jumps.error}`);
  if (jumps.n) problems.push(`${name}：${jumps.n} 处瞬移，例如 ${jumps.bad.join('；')}`);
  if (errs.length) problems.push(`${name}：页面报错 ${errs.slice(0, 3).join(' | ')}`);
  if (frames.p50 > FRAME_BUDGET.p50 || frames.p95 > FRAME_BUDGET.p95) problems.push(`${name}：帧时间超预算（中位数 ${frames.p50.toFixed(1)}、95% ${frames.p95.toFixed(1)} 毫秒）`);
  if (sim) {
    const lim = SIM_STATIC[`${c.q}|${c.load}`] ?? { sim: 10, ext: 10 };
    console.log(`${name}：仿真车之间 静止 ${sim.sim.st}、行驶 ${sim.sim.mv}；仿真车 × 区域货车 静止 ${sim.ext.st}、行驶 ${sim.ext.mv}（车对 × 秒，每 2 秒取一次，上限 静止 ${lim.sim} / ${lim.ext}；取样 ${(sim.ms / 1000).toFixed(1)} 秒）`);
    if (sim.sim.st > lim.sim) problems.push(`${name}：停着的仿真车叠在一起 ${sim.sim.st} 车对 × 秒（上限 ${lim.sim}），例如 ${sim.ex.filter((x) => !/区域货车/.test(x)).join('；')}`);
    if (sim.ext.st > lim.ext) problems.push(`${name}：停着的仿真车和区域货车叠在一起 ${sim.ext.st} 车对 × 秒（上限 ${lim.ext}），例如 ${sim.ex.filter((x) => /区域货车/.test(x)).join('；')}`);
  } else problems.push(`${name}：没有调试接口，仿真车的重叠没查`);
  // 4. 演示导览（只看默认区域）：放一遍、翻到结束卡，数仿真记录的段，看结束卡上有没有「换到极限负荷再看」
  if (!c.q) {
    const tour = await page.evaluate(() => {
      const tp = window.__twin?.tour?.();
      if (!tp) return undefined;
      tp.stop();
      tp.autoAdvance = false;
      tp.start();
      const j = tp.state.journey;
      const out = { n: j?.legs.length ?? 0, records: j?.legs.filter((l) => l.source === 'record').length ?? 0, offer: false };
      if (j) {
        tp.go(j.legs.length);
        out.offer = !!document.querySelector('.tour-card [data-act="extreme"]');
      }
      tp.stop();
      tp.autoAdvance = true;
      return out;
    });
    if (tour) {
      tourCounts[c.load] = tour;
      console.log(`${name}：导览 ${tour.n} 段里 ${tour.records} 段是仿真记录；结束卡${tour.offer ? '有' : '没有'}「换到极限负荷再看」`);
    } else problems.push(`${name}：没有导览的调试接口`);
  }
  await page.close();
}
await browser.close();
{
  const n = tourCounts.normal;
  const x = tourCounts.extreme;
  if (n && x) {
    if (!n.offer) problems.push('导览：默认区域平常那一天的结束卡上没有「换到极限负荷再看」');
    if (x.offer) problems.push('导览：极限负荷那一天的结束卡上不该再有「换到极限负荷再看」');
    if (x.records <= n.records) problems.push(`导览：极限负荷那一天仿真记录的段（${x.records}）不比平常那一天（${n.records}）多，结束卡上的说法不成立`);
  }
}
if (problems.length) {
  console.log(`\n有 ${problems.length} 个问题：\n- ${problems.join('\n- ')}`);
  process.exitCode = 1;
} else console.log('\n全部通过');
