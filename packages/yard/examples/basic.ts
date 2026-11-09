// A six-door receiving yard, ten visits, one schedule. Run: npx tsx examples/basic.ts (or npm run example -w @storewright/yard)
// 六个门的收货场、十次到车、一份排程。运行：npx tsx examples/basic.ts
import { checkPlan, checkRoute, planYard, poseAt, scheduleYard, yardRoute, type YardVehicle, type YardVisit } from '../src/index';

// 1. Layout: doors every 4.3 m on the wall (z = 0), usable x from −60 to 90 m, 140 m deep, access road on the +x end.
//    (Add `drop: 4` for drop-trailer stalls; the staging lane then becomes the shunter's aisle and arrivals wait on the access road.)
const plan = planYard({ doors: [0, 4.3, 8.6, 12.9, 17.2, 21.5].map((x, i) => ({ x, id: `D${i + 1}` })), x0: -60, x1: 90, depth: 140, side: 'right' });
console.log(`layout: ${plan.level}, ${plan.doors.length} doors, ${plan.queue.slots} staging slots, yard depth ${plan.z1.toFixed(1)} m`);
const planProblems = checkPlan(plan);
console.log(`plan check: ${planProblems.length ? planProblems.join('; ') : 'ok'}`);

// 2. Every door can take the design vehicle (a 16.5 m semi-trailer rig): reverse from the driver's side, trailer square in time.
for (let d = 0; d < plan.doors.length; d++) {
  const route = yardRoute(plan, d, 'semi');
  const c = checkRoute(plan, route);
  console.log(`door ${plan.doors[d]?.id}: route ${c.ok ? 'ok' : c.problems.join('; ')} · max articulation ${((c.maxArtic * 180) / Math.PI).toFixed(0)}° · trailer square ${c.alignedAt.toFixed(1)} m from the wall`);
}

// 3. Ten visits with hard times from "your simulation": arrive at the gate, start unloading, start pulling out (seconds).
const kinds: YardVehicle[] = ['semi', 'reefer', 'truck', 'semi', 'van', 'chassis', 'semi', 'reefer', 'truck', 'semi'];
const free = plan.doors.map(() => 0);
const visits: YardVisit[] = kinds.map((vehicle, i) => {
  const arrive = 6 * 3600 + i * 420;
  let door = 0;
  for (let k = 1; k < free.length; k++) if ((free[k] as number) < (free[door] as number)) door = k;
  const dockAt = Math.max(arrive + 480, (free[door] as number) + 480);
  const leaveAt = dockAt + (vehicle === 'van' ? 600 : vehicle === 'truck' ? 1200 : 1800);
  free[door] = leaveAt + 120;
  return { id: `V${i + 1}`, vehicle, door, arrive, dockAt, leaveAt };
});

// 4. One schedule for the whole yard: first come first served, one manoeuvre per wall section, never two vehicles at one door.
const sched = scheduleYard(plan, visits);
const hhmm = (t: number) => `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
console.log('\nvisit  vehicle  door  arrive    queued    reversing docked    out       tight  late dock (s)');
for (const tl of sched.timelines)
  console.log(`${tl.visit.id.padEnd(6)} ${tl.visit.vehicle.padEnd(8)} ${String(plan.doors[tl.visit.door]?.id).padEnd(5)} ${hhmm(tl.visit.arrive)}  ${hhmm(tl.joinAt)}  ${hhmm(tl.backAt)}  ${hhmm(tl.dockedAt)}  ${hhmm(tl.outAt)}  ${String(tl.tight).padEnd(6)} ${Math.round(tl.lateDock)}`);

// 5. Sample any moment for rendering: segment, tractor / trailer angles, reversing, hazard lights.
const tl = sched.timelines[0];
if (tl) {
  for (const t of [tl.joinAt + 5, tl.backAt + 10, tl.dockedAt + 60, tl.outAt - 5]) {
    const info = poseAt(tl, t);
    const u = info?.units[0];
    if (!info || !u) continue;
    console.log(`${tl.visit.id} at ${hhmm(t)}: ${info.seg.padEnd(8)} x ${u.pose.x.toFixed(1)} z ${u.pose.z.toFixed(1)} tractor ${((u.pose.heading * 180) / Math.PI).toFixed(0)}° trailer ${((u.pose.trailer * 180) / Math.PI).toFixed(0)}°${u.pose.reversing ? ' reversing' : ''}${info.hazard ? ' hazard lights' : ''}`);
  }
}
