# @storewright/overlap-audit

**Count where vehicle footprints overlap in a simulated day — and fail the build when it gets worse.** A regression gate for anything that animates many vehicles: traffic simulations, logistics and port twins, city builders and other games, robotics fleets.

Pure TypeScript, zero dependencies. [中文说明](README.md)

> Part of the [Storewright](../../README.en.md) open-source portfolio project. [StoreX Chain](../../StoreX-Chain/README.en.md) audits every vehicle of its regional twin with it (`npm run overlaps` in `StoreX-Chain/`). Not affiliated with any retailer or company.

## Why

Visual glitches where one truck drives through another are easy to introduce and hard to notice: a timing change in a scheduler, a new junction, a longer trailer. Unit tests rarely catch them because nothing "fails" — the picture is just wrong. This library turns them into a number you can track: sample every body every few seconds, count overlapping pairs, file them by area and vehicle-type pair, separate parked overlaps (two queued vehicles drawn inside each other) from moving ones (a vehicle driving through another), and compare with limits. When a change makes an area worse, the run exits with code 1.

The unit is **pair-seconds**: two bodies overlapping for 10 s count 10; three bodies all overlapping each other for 1 s count 3.

## Use it from code

```ts
import { OverlapAuditor, StillTracker, quadKey, hitched, checkLimits, formatReport, type Body } from '@storewright/overlap-audit';

const auditor = new OverlapAuditor<{ name: string; layer: string }>({
  // a tractor and its own trailer always touch at the fifth wheel: not a collision
  ignore: (a, b) => a.data?.layer === b.data?.layer && (hitched(a.shape as number[], b.shape as number[]) || hitched(b.shape as number[], a.shape as number[])),
  // file each overlap under an area of your world (return undefined to leave it out)
  area: (a) => areaOf(a.shape),
});
const still = new StillTracker();
for (let t = 0; t < 86400; t += 2) {
  const bodies: Body<{ name: string; layer: string }>[] = sampleYourScene(t); // { type, shape: quad or OBB, data }
  for (const b of bodies) b.still = still.mark(quadKey(b.data!.name, b.shape as number[])); // or set still yourself
  auditor.step(t, bodies, 2); // each sample stands for 2 seconds
  still.next();
}
const report = checkLimits(auditor.tally, { junction: { static: 0, moving: 120 }, yard: { static: 10, moving: 900 } });
console.log(formatReport(report, { unit: 'pair-seconds' }));
process.exitCode = report.over ? 1 : 0;
```

A runnable version is in [`examples/basic.ts`](examples/basic.ts).

**Shapes.** A body is either a quad — four corners flattened, `[x0, z0, x1, z1, x2, z2, x3, z3]`, in the order rear-A, front-A, front-B, rear-B — or an oriented box `{ cx, cz, ux, uz, hl, hw }` (centre, unit forward direction, half length, half width). `obbFromHeading(cx, cz, heading, hl, hw)` builds one from an angle (`atan2(dx, dz)` by default, `{ yaw: true }` for three.js-style yaw); `obbToQuad` converts.

**Hooks.** `skip(a, b)` drops a pair before the exact test (cheap filters); `ignore(a, b)` drops it after the test (for example `hitched`); `area(a, b)` names the area or returns `undefined`; `pair(a, b)` names the pair (default: the two types sorted and joined with " × "); `onOverlap(o)` sees every counted overlap (print examples, map hot spots). Pass `tally` to let several auditors add into one report, and `touching: true` if rectangles that only touch should count.

**Broad phase.** A uniform grid registers each body in every cell its bounds touch, so it never misses a pair whatever the cell size (default 30 m; the size only changes speed). Pairs are visited in a stable order.

## Use it from the command line

Export trajectories as JSON from any engine and audit them:

```bash
npx tsx packages/overlap-audit/src/cli.ts trajectories.json --step 1 --limits limits.json   # in this repository
overlap-audit trajectories.json --step 1 --limits limits.json                              # installed from the packed tarball
```

Exit code 0: within limits; 1: an area is over its limit; 2: bad input. `--json` prints the report as JSON, `--from` / `--to` limit the time range, `--touching` counts touching rectangles.

```json
{
  "format": "overlap-audit/trajectories",
  "version": 1,
  "heading": "atan2",
  "vehicles": [
    { "id": "north-1", "type": "box truck", "length": 10, "width": 2.5,
      "frames": [ { "t": 0, "x": 0, "z": -60, "heading": 0 }, { "t": 20, "x": 0, "z": 60, "heading": 0 } ] },
    { "id": "rig-7 tractor", "type": "tractor", "length": 6, "width": 2.5, "group": "rig-7", "frames": [ … ] },
    { "id": "rig-7 trailer", "type": "trailer", "length": 13.6, "width": 2.5, "group": "rig-7", "frames": [ … ] }
  ],
  "snapshots": [ { "t": 0, "bodies": [ { "id": "parked-A", "type": "trailer", "x": 22.3, "z": 20, "heading": 0, "length": 13.6, "width": 2.5 } ] } ],
  "areas": [ { "name": "junction", "polygon": [ [-15, -15], [15, -15], [15, 15], [-15, 15] ] } ]
}
```

- `vehicles[].frames`: `(x, z)` is the rectangle's centre (or the centre of its rear edge with `"anchor": "rear"`); positions are interpolated linearly, headings along the shorter arc; a vehicle exists from its first frame to its last.
- `snapshots`: bodies given directly at times (centre, heading and size, or a `quad`); a snapshot holds until the next one.
- Bodies with the same `group` (the tractor and trailer of one rig) never count against each other.
- `areas`: an overlap is filed under the first polygon containing the midpoint of the two centres, otherwise `other`; without areas everything goes to `all`.
- A body is still when it moved less than 1 cm since the previous sample.
- `heading`: `"atan2"` (0 faces +z, π/2 faces +x) or `"yaw"` (three.js style: 0 faces +x).

Limits file: `{ "junction": { "static": 0, "moving": 2 }, "yard": { "static": 25, "moving": 1 } }`. Try the bundled example: `npm run audit:example -w @storewright/overlap-audit`.

## Install

Inside this repository: `import … from '@storewright/overlap-audit'` (workspace). Elsewhere: `npm run pack:libs` at the repository root, then `npm install ./dist-pkg/storewright-overlap-audit-0.1.0.tgz` (compiled JavaScript, type declarations and the `overlap-audit` command). Node.js 22 or newer.

## API

| Area | Exports |
|---|---|
| Geometry | `quadsOverlap`, `obbsOverlap`, `shapesOverlap`, `obbFromHeading`, `obbToQuad`, `quadAabb`, `obbAabb`, `shapeAabb`, `quadCenter`, `quadHeading`, `hitched`, `isObb`; types `Quad`, `OBB`, `AABB`, `Shape`, `OverlapOptions` |
| Broad phase | `forEachCandidatePair`, `candidatePairs` |
| Audit | `OverlapAuditor`, `OverlapTally`, `StillTracker`, `quadKey`, `defaultPair`; types `Body`, `Overlap`, `Counts`, `AuditorOptions` |
| Limits | `checkLimits`, `formatReport`; types `Limits`, `LimitRow`, `LimitReport` |
| Trajectories | `auditTrajectories`, `bodiesAt`, `trajectorySpan`, `validateTrajectories`, `inPolygon`; types `TrajectoryFile`, `TrajVehicle`, `SnapBody`, `Frame` |

## Tests

```bash
npm test -w @storewright/overlap-audit     # SAT vs exact intersection areas, grid vs brute force, hooks, limits, CLI exit codes
npm run typecheck -w @storewright/overlap-audit
```

## License

[AGPL-3.0-only](../../LICENSE), like the rest of the project. Changes: [CHANGELOG.md](CHANGELOG.md).
