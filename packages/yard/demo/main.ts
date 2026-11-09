// Browser demo of @storewright/yard: a top view of one receiving yard over a morning, with a live overlap audit
// from @storewright/overlap-audit. Everything is deterministic: the same controls and seed give the same picture.
// 卸货场引擎的浏览器演示：一个收货场一上午的俯视动画，右上角用重叠审计库实时统计车身重叠。同样的设置和种子，画面每次一样。
import { OverlapAuditor, type Body } from '@storewright/overlap-audit';
import { footprint, planYard, poseAt, scheduleYard, type OBB as YardOBB, type PoseInfo, type YardPlan, type YardSchedule, type YardVehicle, type YardVisit } from '../src/index';

const q = new URLSearchParams(location.search);
const ZH = (q.get('lang') ?? (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en')) === 'zh';
const tr = (en: string, zh: string) => (ZH ? zh : en);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
document.documentElement.lang = ZH ? 'zh-CN' : 'en';
document.title = tr('Yard engine demo · @storewright/yard', '卸货场引擎演示 · @storewright/yard');
$('title').textContent = tr('Yard engine demo', '卸货场引擎演示');
$('subtitle').textContent = tr(
  'One receiving yard over a morning: trucks queue first come first served, swing out and reverse from the driver’s side, trailers articulate, nobody drives through anybody.',
  '一个收货场的一个上午：来车先到先进排队、车头外摆、从司机一侧倒车靠台，挂车铰接，谁也不穿过谁。',
);
const langLink = $<HTMLAnchorElement>('lang');
langLink.textContent = ZH ? 'English' : '中文';
langLink.href = `?lang=${ZH ? 'en' : 'zh'}`;
$('src').textContent = tr('Source & docs', '源码和文档');
$('h-play').textContent = tr('Playback', '播放');
$('h-yard').textContent = tr('Yard', '场地');
$('l-doors').textContent = tr('Doors', '门数');
$('l-rate').textContent = tr('Arrivals / hour', '每小时到车');
$('l-side').textContent = tr('Access road', '进场道路');
$('l-from').textContent = tr('Comes from', '从哪来');
$('l-access').textContent = tr('Street junction', '接路口');
$('l-drop').textContent = tr('Drop-and-hook stalls', '甩挂车位');
$('l-seed').textContent = tr('Seed', '种子');
$('h-legend').textContent = tr('Legend', '图例');
$('h-what').textContent = tr('What you are seeing', '看点');
$('ov-unit').textContent = tr('pair-seconds of body overlap', '车·秒 车身重叠');
const opts = (id: string, labels: [string, string][]) => [...$<HTMLSelectElement>(id).options].forEach((o, i) => (o.textContent = tr(...(labels[i] as [string, string]))));
opts('side', [['right end', '右头'], ['left end', '左头']]);
opts('from', [['behind the wall', '墙后（沿楼侧面）'], ['far edge', '场地远端']]);
opts('access', [['flared driveway', '喇叭口专用通道'], ['signalised street', '信号灯支路']]);
$('what').textContent = tr(
  'Lanes from the wall out: court lane (→), exit lane (←), staging lane with numbered slots (←, first come first served) and top lane (→). A rig drives past its door, swings the cab out, stops with hazard lights while the driver checks, then reverses from the driver’s side; the trailer is square before it reaches the line of the neighbouring cabs. One vehicle manoeuvres per wall section at a time and exits go first. With drop-and-hook on, some trailers are dropped in stalls and a yellow yard shunter moves them to the door and back. The schedule takes the arrival, unloading and departure times as hard constraints. The overlap audit (top right) checks every second of the morning and stays at 0 even when you push the arrivals past what the doors can serve: the access road lets one truck at a time onto its entry lane and the next one follows at a safe distance, the rest wait in the off-site holding area (counted under the picture, not drawn), drop-and-hook moves wait for the entry lane, and a trailer that finds every stall taken is unloaded at the door by its own driver instead. Windows that become too short are flagged tight.',
  '从墙往外：靠台车道（→）、驶离车道（←）、带编号车位的待命车道（←，先到先进）、顶部车道（→）。半挂车驶过自己的门、车头外摆、打双闪停一下让司机看清，再从司机一侧倒车，挂车在两边车头连线以外就摆正。同一段墙同一时间只有一辆车调车，驶离优先。打开甩挂后，一部分挂车甩在车位里，由黄色的场内牵引车拖到门、装卸完再拖回去。排程把到达、开始卸货、离开的时刻当成硬约束。右上角的重叠审计逐秒检查整个上午，把到车调到门处理不过来的程度也一直是 0：进场道路的进场车道同一时间只放一辆车上来，后面的车隔着安全距离跟车，其余的在场外等候区等（画面下方计数，不画出来）；甩挂的车也要等进场车道空出来；甩挂车位都占着时，挂车改由司机自己靠台卸货。时间窗变得太短的车标「时间窗太紧」。',
);

const COLORS: Record<YardVehicle | 'shunter', string> = { semi: '#3b82c4', reefer: '#1f9d93', chassis: '#c8873a', truck: '#8b6fd6', van: '#d9577f', shunter: '#e2b22f' };
const LEG: [YardVehicle | 'shunter', string, string][] = [
  ['semi', 'Semi-trailer rig', '半挂车'],
  ['reefer', 'Reefer rig', '冷藏半挂车'],
  ['chassis', 'Container chassis', '集装箱骨架车'],
  ['truck', 'Rigid box truck', '单体厢式货车'],
  ['van', 'Van', '面包车'],
  ['shunter', 'Yard shunter', '场内牵引车'],
];
$('legend').innerHTML = LEG.map(([k, en, zh]) => `<i style="background:${COLORS[k]}"></i><span>${tr(en, zh)}</span>`).join('') + `<i style="background:#f59e0b"></i><span>${tr('Hazard lights (waiting to reverse, docking prep)', '双闪（等着倒车、靠台准备）')}</span>`;

// —— model ——
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Setup {
  doors: number;
  rate: number;
  side: 'left' | 'right';
  from: 'back' | 'front';
  access: 'drive' | 'street';
  drop: boolean;
  seed: number;
}
const T0 = 6 * 3600;
const WINDOW = 4 * 3600;
/** 登记亭让来车至少隔这么多秒进场（到达时刻是硬约束：同时到的车，引擎让后一辆先在场外等候区等，进场车道空出来再放进来） */
const GATE_GAP = 75;

function build(s: Setup): { plan: YardPlan; visits: YardVisit[]; sched: YardSchedule; t0: number; t1: number } {
  const pitch = 4.3;
  const doors = Array.from({ length: s.doors }, (_, i) => ({ x: i * pitch, id: `D${i + 1}` }));
  const span = (s.doors - 1) * pitch;
  const plan = planYard({ doors, x0: -70, x1: span + 70, depth: 140, side: s.side, from: s.from, access: s.access, ...(s.drop ? { drop: 6 } : {}) });
  const r = rng(s.seed);
  const free = plan.doors.map(() => T0);
  const visits: YardVisit[] = [];
  let t = T0;
  let i = 0;
  while (t < T0 + WINDOW) {
    // gate check-in keeps arrivals at least GATE_GAP seconds apart (arrivals are hard constraints; trucks that arrive together wait off-site until the entry lane is clear)
    t += Math.max(GATE_GAP, (-Math.log(1 - r()) * 3600) / s.rate);
    if (t >= T0 + WINDOW) break;
    const u = r();
    const vehicle: YardVehicle = u < 0.38 ? 'semi' : u < 0.58 ? 'reefer' : u < 0.7 ? 'chassis' : u < 0.88 ? 'truck' : 'van';
    let door = 0;
    for (let k = 1; k < free.length; k++) if ((free[k] as number) < (free[door] as number)) door = k;
    const rig = vehicle === 'semi' || vehicle === 'reefer' || vehicle === 'chassis';
    const work = vehicle === 'van' ? 600 + r() * 300 : vehicle === 'truck' ? 1200 + r() * 600 : 1800 + r() * 900;
    const drop = s.drop && rig && vehicle !== 'chassis' && r() < 0.35;
    const dockAt = Math.max(t + (drop ? 900 : 480), (free[door] as number) + 420);
    const leaveAt = dockAt + work;
    free[door] = leaveAt + 150;
    visits.push({ id: `V${++i}`, vehicle, door, arrive: Math.round(t), dockAt: Math.round(dockAt), leaveAt: Math.round(leaveAt), ...(drop ? { mode: 'drop' as const, pickupAt: Math.round(leaveAt + 1500 + r() * 1800) } : {}) });
  }
  const sched = scheduleYard(plan, visits);
  const t1 = Math.max(T0 + WINDOW, ...sched.timelines.map((tl) => tl.goneAt)) + 120;
  return { plan, visits, sched, t0: T0 - 60, t1 };
}

// —— controls ——
const setup = (): Setup => ({
  doors: Number($<HTMLInputElement>('doors').value),
  rate: Number($<HTMLInputElement>('rate').value),
  side: $<HTMLSelectElement>('side').value as Setup['side'],
  from: $<HTMLSelectElement>('from').value as Setup['from'],
  access: $<HTMLSelectElement>('access').value as Setup['access'],
  drop: $<HTMLInputElement>('drop').checked,
  seed: Math.max(1, Math.min(9999, Math.round(Number($<HTMLInputElement>('seed').value) || 1))),
});
let world = build(setup());
let t = world.t0;
let playing = true;
let speed = 60;

// —— overlap audit (precomputed in slices so the page stays responsive) ——
let auditor = new OverlapAuditor<{ id: string }>({ skip: (a, b) => a.data?.id === b.data?.id, area: () => 'yard' });
let audited = world.t0;
const AUDIT_STEP = 1;
function bodiesAt(at: number): Body<{ id: string }>[] {
  const out: Body<{ id: string }>[] = [];
  for (const tl of world.sched.timelines) {
    const info = poseAt(tl, at);
    if (!info || info.seg === 'hold') continue;
    for (const u of info.units)
      for (const b of footprint(u.dims, u.pose, -0.1)) out.push({ type: u.role, shape: { cx: b.x, cz: b.z, ux: Math.sin(b.h), uz: Math.cos(b.h), hl: b.hl, hw: b.hw }, data: { id: tl.visit.id } });
  }
  return out;
}
function auditSlice(): void {
  const end = Math.min(world.t1, audited + 600);
  for (; audited < end; audited += AUDIT_STEP) auditor.step(audited, bodiesAt(audited), AUDIT_STEP);
  const total = auditor.tally.total('yard');
  const n = total.static + total.moving;
  const box = $('audit');
  box.className = n === 0 ? 'ok' : 'bad';
  $('ov').textContent = String(n);
  const done = audited >= world.t1;
  $('ov-note').textContent = done
    ? tr(`Whole morning audited (${hhmm(world.t0)}–${hhmm(world.t1)}, every second, bodies shrunk 10 cm per side).`, `整个上午都审计过了（${hhmm(world.t0)}–${hhmm(world.t1)}，每秒一次，车身各边内缩 10 厘米）。`)
    : tr(`Auditing… ${Math.round(((audited - world.t0) / (world.t1 - world.t0)) * 100)} %`, `审计中… ${Math.round(((audited - world.t0) / (world.t1 - world.t0)) * 100)}%`);
  if (!done) setTimeout(auditSlice, 0);
}

function rebuild(): void {
  world = build(setup());
  t = world.t0;
  auditor = new OverlapAuditor<{ id: string }>({ skip: (a, b) => a.data?.id === b.data?.id, area: () => 'yard' });
  audited = world.t0;
  const slider = $<HTMLInputElement>('time');
  slider.min = String(world.t0);
  slider.max = String(world.t1);
  const notes = world.plan.notes.length ? world.plan.notes : [];
  $('plan-notes').textContent = `${tr('Layout', '布置')}: ${world.plan.level} · ${world.visits.length} ${tr('visits', '次到车')} · ${world.plan.queue.slots} ${tr('staging slots', '个待命车位')}${world.plan.stalls.length ? ` · ${world.plan.stalls.length} ${tr('drop stalls', '个甩挂车位')}` : ''}${notes.length && ZH ? ` · ${notes.join('；')}` : ''}`;
  fit();
  auditSlice();
}
for (const id of ['doors', 'rate']) {
  const el = $<HTMLInputElement>(id);
  el.oninput = () => ($(`v-${id}`).textContent = el.value);
  el.onchange = rebuild;
}
for (const id of ['side', 'from', 'access', 'drop', 'seed']) $<HTMLInputElement>(id).onchange = rebuild;
$<HTMLSelectElement>('speed').onchange = (e) => (speed = Number((e.target as HTMLSelectElement).value));
const playBtn = $<HTMLButtonElement>('play');
const setPlaying = (on: boolean) => {
  playing = on;
  playBtn.textContent = on ? '❚❚' : '▶';
  playBtn.setAttribute('aria-label', on ? tr('Pause', '暂停') : tr('Play', '播放'));
};
playBtn.onclick = () => {
  if (!playing && t >= world.t1) t = world.t0;
  setPlaying(!playing);
};
$<HTMLInputElement>('time').oninput = (e) => (t = Number((e.target as HTMLInputElement).value));

// —— drawing ——
const canvas = $<HTMLCanvasElement>('view');
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
let scale = 1;
let ox = 0;
let oy = 0;
const dark = matchMedia('(prefers-color-scheme: dark)');
function fit(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const p = world.plan;
  const zMin = p.from === 'back' ? -p.driveLen - 6 : -26;
  const zMax = p.from === 'front' ? p.z1 + p.driveLen + 6 : p.z1 + 8;
  const xMin = p.x0 - 6;
  const xMax = p.x1 + 6;
  scale = Math.min(w / (xMax - xMin), h / (zMax - zMin)) * 0.96 * dpr;
  ox = (w * dpr - (xMax - xMin) * scale) / 2 - xMin * scale;
  oy = (h * dpr + (zMax - zMin) * scale) / 2 + zMin * scale;
}
const sx = (x: number) => ox + x * scale;
const sy = (z: number) => oy - z * scale;
window.addEventListener('resize', fit);

function poly(pts: { x: number; z: number }[]): void {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(sx(p.x), sy(p.z)) : ctx.moveTo(sx(p.x), sy(p.z))));
  ctx.closePath();
}
function corners(b: YardOBB): { x: number; z: number }[] {
  const fx = Math.sin(b.h);
  const fz = Math.cos(b.h);
  const lx = Math.cos(b.h);
  const lz = -Math.sin(b.h);
  return [
    { x: b.x - fx * b.hl - lx * b.hw, z: b.z - fz * b.hl - lz * b.hw },
    { x: b.x + fx * b.hl - lx * b.hw, z: b.z + fz * b.hl - lz * b.hw },
    { x: b.x + fx * b.hl + lx * b.hw, z: b.z + fz * b.hl + lz * b.hw },
    { x: b.x - fx * b.hl + lx * b.hw, z: b.z - fz * b.hl + lz * b.hw },
  ];
}
const label = (s: string) => (ZH ? s : s.replace(/^待命 (\d+)$/, 'Q$1').replace(/^甩挂(\d+)$/, 'S$1').replace('货车入口', 'TRUCKS'));

function drawGround(): void {
  const p = world.plan;
  const dk = dark.matches;
  ctx.fillStyle = dk ? '#1f2a22' : '#cfd9c4';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // building behind the wall
  const xs = p.doors.map((d) => d.x);
  const bx0 = Math.min(...xs) - 14;
  const bx1 = Math.max(...xs) + 14;
  const keepOut = p.driveX + (p.side === 'right' ? -1 : 1) * (p.driveHalf + 3);
  const b0 = p.side === 'left' ? Math.max(bx0, keepOut) : bx0;
  const b1 = p.side === 'right' ? Math.min(bx1, keepOut) : bx1;
  ctx.fillStyle = dk ? '#3a4047' : '#b9bdc2';
  ctx.fillRect(sx(b0), sy(0), (b1 - b0) * scale, 24 * scale);
  // asphalt yard and access road
  ctx.fillStyle = dk ? '#2b2f33' : '#5a5f66';
  ctx.fillRect(sx(p.x0), sy(p.z1), (p.x1 - p.x0) * scale, p.z1 * scale);
  const zA = p.from === 'back' ? -p.driveLen - 6 : p.z1;
  const zB = p.from === 'back' ? 0 : p.z1 + p.driveLen + 6;
  ctx.fillRect(sx(p.driveX - p.driveHalf - 0.5), sy(zB), (2 * p.driveHalf + 1) * scale, (zB - zA) * scale);
  for (const f of p.junction?.flares ?? []) {
    poly(f);
    ctx.fill();
  }
  // concrete apron in front of the doors
  ctx.fillStyle = dk ? '#4a4f55' : '#8d9298';
  ctx.fillRect(sx(Math.min(...xs) - 8), sy(p.apronZ), (Math.max(...xs) - Math.min(...xs) + 16) * scale, p.apronZ * scale);
  // wall and doors
  ctx.fillStyle = dk ? '#9aa3ab' : '#30363c';
  ctx.fillRect(sx(b0), sy(0) - 2, (b1 - b0) * scale, 4);
  ctx.font = `${Math.max(9, 1.5 * scale)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const d of p.doors) {
    ctx.fillStyle = d.cold ? '#7fb0e8' : '#e8b04b';
    ctx.fillRect(sx(d.x - 1.5), sy(0) - 1, 3 * scale, 3);
    ctx.fillStyle = dk ? '#e8eaec' : '#ffffff';
    ctx.fillText(d.id, sx(d.x), sy(0) + 4);
  }
  // markings
  for (const m of p.marks) {
    if (m.kind === 'line') {
      ctx.strokeStyle = m.color === 'yellow' ? '#f2c94c' : '#f5f5f0';
      ctx.lineWidth = Math.max(1, m.width * scale);
      ctx.setLineDash(m.dashed ? [3 * scale, 3 * scale] : []);
      ctx.beginPath();
      m.pts.forEach((pt, i) => (i ? ctx.lineTo(sx(pt.x), sy(pt.z)) : ctx.moveTo(sx(pt.x), sy(pt.z))));
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (m.kind === 'arrow') {
      const fx = Math.sin(m.heading);
      const fz = Math.cos(m.heading);
      const L = 3;
      ctx.strokeStyle = '#f5f5f0';
      ctx.lineWidth = Math.max(1, 0.25 * scale);
      ctx.beginPath();
      ctx.moveTo(sx(m.at.x - fx * L), sy(m.at.z - fz * L));
      ctx.lineTo(sx(m.at.x + fx * L), sy(m.at.z + fz * L));
      ctx.lineTo(sx(m.at.x + fx * (L - 1.2) + fz * 0.9), sy(m.at.z + fz * (L - 1.2) - fx * 0.9));
      ctx.moveTo(sx(m.at.x + fx * L), sy(m.at.z + fz * L));
      ctx.lineTo(sx(m.at.x + fx * (L - 1.2) - fz * 0.9), sy(m.at.z + fz * (L - 1.2) + fx * 0.9));
      ctx.stroke();
    } else if (m.kind === 'stop') {
      ctx.strokeStyle = '#f5f5f0';
      ctx.lineWidth = Math.max(1.5, 0.4 * scale);
      ctx.beginPath();
      ctx.moveTo(sx(m.a.x), sy(m.a.z));
      ctx.lineTo(sx(m.b.x), sy(m.b.z));
      ctx.stroke();
    } else if (m.kind === 'box') {
      ctx.strokeStyle = 'rgba(245,245,240,0.7)';
      ctx.lineWidth = 1;
      poly(corners({ x: m.at.x, z: m.at.z, hl: m.d / 2, hw: m.w / 2, h: m.heading }));
      ctx.stroke();
      if (m.label && scale > 3) {
        ctx.fillStyle = 'rgba(245,245,240,0.8)';
        ctx.textBaseline = 'middle';
        ctx.fillText(label(m.label), sx(m.at.x), sy(m.at.z));
      }
    } else if (m.kind === 'sign') {
      ctx.fillStyle = '#2b7d52';
      const w = 9;
      ctx.fillRect(sx(m.at.x - w / 2), sy(m.at.z + 1.2), w * scale, 2.4 * scale);
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(label(m.text), sx(m.at.x), sy(m.at.z));
    }
  }
}

function drawVehicles(): { inYard: number; docked: number; held: number; tight: number } {
  let inYard = 0;
  let docked = 0;
  let held = 0;
  const blink = performance.now() % 1000 < 520;
  for (const tl of world.sched.timelines) {
    const info: PoseInfo | undefined = poseAt(tl, t);
    if (!info) continue;
    if (info.seg === 'hold') {
      held++;
      continue;
    }
    inYard++;
    if (info.seg === 'docked' || info.seg === 'prep') docked++;
    for (const u of info.units) {
      const base = u.role === 'shunter' ? COLORS.shunter : COLORS[tl.visit.vehicle];
      const parts = footprint(u.dims, u.pose);
      parts.forEach((b, k) => {
        const cab = parts.length === 2 ? k === 1 : false;
        const trailer = (parts.length === 2 && k === 0) || u.role === 'trailer';
        poly(corners(b));
        ctx.fillStyle = trailer ? shade(base, u.role === 'trailer' ? 0.15 : 0.35) : base;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth = 1;
        ctx.stroke();
        if ((cab || parts.length === 1) && u.role !== 'trailer') {
          // windscreen at the front edge
          const c = corners(b);
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = Math.max(1, 0.25 * scale);
          ctx.beginPath();
          const f1 = c[1] as { x: number; z: number };
          const f2 = c[2] as { x: number; z: number };
          const r1 = c[0] as { x: number; z: number };
          const r2 = c[3] as { x: number; z: number };
          const k1 = 0.18;
          ctx.moveTo(sx(f1.x + (r1.x - f1.x) * k1), sy(f1.z + (r1.z - f1.z) * k1));
          ctx.lineTo(sx(f2.x + (r2.x - f2.x) * k1), sy(f2.z + (r2.z - f2.z) * k1));
          ctx.stroke();
        }
      });
      // lights: hazard (amber, blinking), reversing (white), brake (red) at the rear of the last part
      const rear = corners(parts[0] as YardOBB);
      const dots: { x: number; z: number }[] = [rear[0] as { x: number; z: number }, rear[3] as { x: number; z: number }];
      const colorOf = info.hazard && blink ? '#f59e0b' : u.pose.reversing ? '#ffffff' : info.brake ? '#ef4444' : undefined;
      if (colorOf) {
        ctx.fillStyle = colorOf;
        for (const d of dots) ctx.fillRect(sx(d.x) - 2, sy(d.z) - 2, 4, 4);
        if (info.hazard && blink) {
          const front = corners(parts[parts.length - 1] as YardOBB);
          for (const d of [front[1], front[2]] as { x: number; z: number }[]) ctx.fillRect(sx(d.x) - 2, sy(d.z) - 2, 4, 4);
        }
      }
    }
  }
  return { inYard, docked, held, tight: world.sched.timelines.filter((tl) => tl.tight).length };
}
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * k);
  return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
}
function hhmm(x: number): string {
  const s = Math.max(0, Math.floor(x));
  return `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}
function hhmmss(x: number): string {
  const s = Math.max(0, Math.floor(x));
  return `${hhmm(s)}:${String(s % 60).padStart(2, '0')}`;
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (playing) {
    t += dt * speed;
    if (t >= world.t1) {
      t = world.t1;
      setPlaying(false);
    }
  }
  drawGround();
  const c = drawVehicles();
  $('clock').textContent = hhmmss(t);
  $('counts').textContent = tr(`${c.inYard} in the yard · ${c.docked} at doors · ${c.held} waiting outside${c.tight ? ` · ${c.tight} tight windows` : ''}`, `场内 ${c.inYard} 辆 · 靠台 ${c.docked} · 场外等候 ${c.held}${c.tight ? ` · 时间窗太紧 ${c.tight}` : ''}`);
  $<HTMLInputElement>('time').value = String(Math.round(t));
  requestAnimationFrame(frame);
}
rebuild();
requestAnimationFrame(frame);
