// Programmatic use: sample bodies yourself, classify areas, ignore a tractor and its own trailer, compare with limits.
// 自己取样、分区域、忽略牵引车和自己的挂车、和上限比。运行：npx tsx examples/basic.ts
import { checkLimits, formatReport, hitched, obbFromHeading, obbToQuad, OverlapAuditor, StillTracker, quadKey, type Body } from '../src/index';

interface Info {
  name: string;
  layer: string;
}
const auditor = new OverlapAuditor<Info>({
  // two bodies drawn by the same layer that are a tractor and its trailer: hitched, not a collision
  ignore: (a, b) => a.data?.layer === b.data?.layer && (hitched(a.shape as number[], b.shape as number[]) || hitched(b.shape as number[], a.shape as number[])),
  area: (a) => (Math.abs((a.shape as number[])[0] as number) < 15 ? 'junction' : 'road'),
});
const still = new StillTracker();
for (let t = 0; t <= 20; t += 1) {
  const truck = obbToQuad(obbFromHeading(0, -60 + 6 * t, 0, 5, 1.25));
  const van = obbToQuad(obbFromHeading(-60 + 6 * t, 0, Math.PI / 2, 3, 1.05));
  const tractor = obbToQuad(obbFromHeading(30, 30, 0, 3, 1.25));
  const trailer = obbToQuad(obbFromHeading(30, 22.2, 0, 6.8, 1.25));
  const bodies: Body<Info>[] = [
    { type: 'box truck', shape: truck, data: { name: 'truck', layer: 'road' } },
    { type: 'van', shape: van, data: { name: 'van', layer: 'road' } },
    { type: 'tractor', shape: tractor, data: { name: 'tractor', layer: 'yard' } },
    { type: 'trailer', shape: trailer, data: { name: 'trailer', layer: 'yard' } },
  ];
  for (const b of bodies) b.still = still.mark(quadKey(b.data!.name, b.shape as number[]));
  auditor.step(t, bodies, 1);
  still.next();
}
const report = checkLimits(auditor.tally, { junction: { static: 0, moving: 1 } });
console.log(formatReport(report, { title: 'example: one junction, 21 samples', unit: 'pair-seconds' }));
process.exitCode = report.over ? 1 : 0;
