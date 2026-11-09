# @storewright/yard

**A truck-yard and loading-dock motion engine for simulations, games and digital twins.** Give it a dock wall and the hard times from your simulation ("this trailer arrives at 06:42, starts unloading at 06:53, leaves at 07:21"), and it lays out one-way lanes, plans every manoeuvre — queueing, swinging the cab out, reversing from the driver's side with an articulated trailer, pulling out — and returns one conflict-free schedule you can sample at any moment for rendering.

Pure TypeScript, zero dependencies, deterministic. [中文说明](README.md)

> Part of the [Storewright](../../README.en.md) open-source portfolio project; it drives every receiving yard in [StoreX Chain](../../StoreX-Chain/README.en.md) (store, distribution centre, cold-chain centre, port container freight station and bonded warehouse, air-cargo landside). Not affiliated with any retailer or company.

## Why

Trucks in most simulations teleport to a dock or slide sideways into it. Real yards work differently, and the difference is visible: a 16.5 m semi-trailer rig needs a staging lane, a U-turn radius of about 12 m, room to swing the cab out, and a reverse from the **driver's side** so the driver can see the trailer; two vehicles cannot manoeuvre in the same stretch of wall at once; an exiting vehicle goes first. This library encodes those rules once, so every yard in your world behaves the same way and nothing drives through anything else.

## What it does

```
 z (away from the wall)
 ▲
 │  top lane       ──►──►──►──►──►──►──►──►──►──►──►──►──┐
 │  staging lane   ◄── [4] [3] [2] [1] ◄──◄──◄──◄──◄──◄──┤   first come, first served
 │  exit lane      ◄──◄──◄──◄──◄──◄──◄──◄──◄──◄──◄──◄──◄─┤
 │  court lane     ──►──►──►──►──►──►──►──►──►──►──►──►─►│  access road (in / out)
 │                    ╲ reverse from the driver's side   │
 ├───[D1]──[D2]──[D3]──[D4]──[D5]──[D6]──────────────────┘  dock wall, z = 0
 └──────────────────────────────────────────────────────► x
```

- **Layout — `planYard`.** From the doors, the usable x range and depth, the access side (`left` / `right`), where the access road comes from (`back`: up beside the building; `front`: down from the far edge) and how it meets the street (`drive`: a flared private driveway; `street`: a signalised side street), it lays out the court lane along the doors, an exit lane, a staging lane with numbered slots and a top lane — all one-way, right-hand traffic — plus drop-trailer stalls, painted lines, arrows, stop lines, signs and the junction flares. When the depth is too small it falls back to a compact layout (no top lane) or a court-only layout (queueing on the access road) and says so in `plan.notes`.
- **Routes — `yardRoute`.** One vehicle's whole path to a door: gate → staging slot → U-turn → court lane → drive past the door and swing the cab out → reverse from the driver's side, trailer squared before it reaches the line of the neighbouring cabs → dock → pull straight out until the trailer clears the neighbours → exit. Rigs use kingpin kinematics (tractor + semi-trailer, the trailer follows its tractrix); rigid trucks and vans use the rear-axle centre. Candidate manoeuvres are scored and checked: no contact with vehicles docked at the neighbouring doors, articulation ≤ 65°, cab never enters the staging lane.
- **Schedule — `scheduleYard`.** Your simulation's times are the contract. Arrivals queue in order; one vehicle manoeuvres per wall section at a time; exits have priority; a door never holds two vehicles; manoeuvres are fitted into the window you gave, extra time is spent waiting at the reversing start with hazard lights on, and a window that is too short is compressed to a floor and flagged `tight`. On the access road's entry lane and its first turn into the yard (the entry gate) vehicles follow at a safe distance, and those that do not fit wait in the off-site holding area (`hold`), so even an overloaded yard never has vehicles drawn inside each other (see [Limits](#limits)). Drop-and-hook is supported: a road tractor drops the trailer in a stall, a yard shunter moves it to the door and back, another tractor hooks it.
- **Sampling — `poseAt`.** Any visit at any time: segment (`queue`, `back`, `docked`, `pullout` …), tractor and trailer headings, reversing, steering angle, speed, hazard and brake lights. Render from it directly.
- **Registry (optional).** `defineYardSite` places a yard in your world (origin + yaw), `setSiteVisits` gives it the day's visits, `siteSchedule` caches one schedule per site and recomputes only when the layout or visits change; `siteSummary` reports tight windows and lateness for dashboards.

## Install

Inside this repository the package is a workspace (`import … from '@storewright/yard'`). Outside it, build a tarball from the repository root and install that (the package is not on the npm registry yet):

```bash
npm run pack:libs          # writes dist-pkg/storewright-yard-0.1.0.tgz (compiled JavaScript + type declarations)
npm install ./dist-pkg/storewright-yard-0.1.0.tgz
```

Node.js 22 or newer; works in browsers and Web Workers too (no DOM or Node APIs).

## Quick start

```ts
import { planYard, scheduleYard, poseAt, yardRoute, checkRoute, type YardVisit } from '@storewright/yard';

// Six doors 4.3 m apart on the wall (z = 0); usable x from −60 to 90 m, 140 m deep; access road on the +x end.
const plan = planYard({ doors: [0, 4.3, 8.6, 12.9, 17.2, 21.5], x0: -60, x1: 90, depth: 140, side: 'right' });

// Every door works for the design vehicle?
for (let d = 0; d < plan.doors.length; d++) console.log(checkRoute(plan, yardRoute(plan, d, 'semi')).ok);

// Hard times from your simulation (seconds): arrive at the gate, start unloading, start pulling out.
const visits: YardVisit[] = [
  { id: 'V1', vehicle: 'semi', door: 0, arrive: 21600, dockAt: 22080, leaveAt: 23880 },
  { id: 'V2', vehicle: 'reefer', door: 1, arrive: 22020, dockAt: 22500, leaveAt: 24300 },
];
const schedule = scheduleYard(plan, visits);

// Render: sample any visit at any moment.
const info = poseAt(schedule.timelines[0]!, 21880);
// info.seg is what the vehicle is doing now (here 'back', reversing); info.units[0].pose → { x, z, heading, trailer, reversing, speed, steer }
```

A longer, runnable version is in [`examples/basic.ts`](examples/basic.ts) (`npm run example -w @storewright/yard`). The [browser demo](demo/) animates a yard in 2D with live controls (`npm run demo -w @storewright/yard`) and shows the overlap audit from [`@storewright/overlap-audit`](../overlap-audit/README.en.md) staying at zero, also when you overload the yard or turn drop-and-hook on.

## Conventions

- **Local frame:** the dock wall is `z = 0`, doors sit at `x` along it, the yard extends towards `+z`. Units are metres and seconds.
- **Heading:** `atan2(dx, dz)` — 0 faces `+z` (away from the wall), π/2 faces `+x`. `yawOf(frame, heading)` converts to a three.js-style yaw for a model whose nose points along `+x`; `toWorld` / `toLocal` move points between the yard and your world.
- **Reference point:** articulated rigs (`semi`, `reefer`, `chassis`, `shunter`) use the kingpin; rigid vehicles (`truck`, `van`) use the rear-axle centre. `footprint(vehicle, pose)` gives the body rectangles.
- **Vehicle sizes:** defaults stay within common legal limits (semi-trailer ≤ 13.75 m, rig ≤ 17.1 m, width 2.55 m); replace them with your own models' sizes via `setVehicleDims` before planning.
- **Traffic side:** right-hand traffic; rigs reverse from the driver's (left) side.

## API

| Area | Exports |
|---|---|
| Layout | `planYard(input)` → `YardPlan`; `checkPlan(plan)`; types `YardInput`, `YardDoorInput`, `YardPlan`, `YardDoor`, `YardStall`, `YardMark` |
| Routes | `yardRoute(plan, door, vehicle)` → `YardRoute`; `shunterRoute`, `stallRoute` (drop-and-hook); `checkRoute(plan, route)` → `RouteCheck`; `laneDrive`, `lanePose`, `queueTargets`, `QueueMotion` |
| Schedule | `scheduleYard(plan, visits)` → `YardSchedule` (`timelines`, `shunts`, `notes`); `courtResources`; types `YardVisit`, `YardTimeline`, `YardSeg`, `YardSegKind`, `YardPiece` |
| Sampling | `poseAt(timeline, t)` → `PoseInfo` (`seg`, `units[]`, `hazard`, `brake`); types `PoseUnit`, `RigPose` |
| Registry | `defineYardSite`, `yardSite`, `yardSites`, `clearYardSites`, `setSiteVisits`, `addSimVisit`, `clearSimVisits`, `simVisitId`, `simVisitFor`, `siteSchedule`, `siteTimeline`, `siteVisit`, `siteVersion`, `siteSummary`, `yardSummaries`, `findYardDoor` |
| Frames | `toWorld`, `toLocal`, `yawOf`, `headingOf`; type `YardFrame` |
| Kinematics | `ForwardRig`, `ReverseRig`, `TowChain`, `BodyRig`, `forwardRig`, `TimedPath`, `PathChain` |
| Vehicles | `VEHICLE_DIMS`, `BOBTAIL`, `setVehicleDims`, `dimsOf`, `lengthOf`, `frontOf`, `backOf`, `noseOf`, `rearOf`, `footprint`; types `YardVehicle`, `RigDims`, `BodyDims`, `VehicleDims` |
| Geometry | `Polyline`, `fillet`, `angDiff`, `minRadius`, `obbIntersects` |

Every exported function and type carries a short English doc comment; the source keeps longer Chinese notes on the reasoning.

## Determinism and cost

The same input always gives the same plan, routes and schedule (no randomness, no clocks). `planYard` and `scheduleYard` cache their results per input, so asking again is free; treat returned objects as read-only. Scheduling a day of 300 visits at a 24-door wall takes about 0.15 s in Node.js on a laptop.

`npm run bench -w @storewright/yard` measures the cost of scheduling: the 15 settings of the overload test matrix plus 15 option sets of the browser demo, each scheduled from scratch on a fresh copy of its plan (routes included), best of 3 — about 0.8 s in total on an idle laptop (about 2.4 s before this speed-up). Add `--mem 8` for memory: a plan with its schedule retains about 3–10 MB (most at 14 doors, 24 arrivals an hour and drop-and-hook; 10–41 MB before). How it stays cheap: the occupancy table keeps each resource's spans sorted by start with a running maximum of their ends, so a conflict check is a binary search; routes and the yard resources they occupy are cached per plan, door and vehicle, and drop-and-hook routes are computed once per stall and door within a schedule; polylines, timed paths and staging-lane motion keep their samples in `Float64Array`s (`pts`, `cum`, `cumT` and `cumD` become plain arrays on first read). Before changing any of this, save fingerprints with `--hash a.json` and compare afterwards with `--check a.json` (`--random 256` adds 256 random settings): timelines, segments, shunter moves and per-second poses must stay identical.

## Limits

- One straight dock wall per plan (an L-shaped building is two plans).
- Simplified dynamics: speed limits, acceleration, braking and lateral acceleration in bends, no tyre or load model.
- Yard traffic only; pedestrians, forklifts on the apron and the public road are up to you (`plan.junction` gives the junction geometry and `YardVisit.pre` / `leave` accept road paths).
- Right-hand traffic only for now.
- When a yard is overloaded (arrivals faster than the doors can serve them) the engine does not let vehicles overlap; instead:
  - On the entry gate (the access road's entry lane plus its first turn into the yard) the next vehicle is let in only once the one ahead has its tail 2 m past the gate line; in the staging lane vehicles car-follow with at least 1.5 m between nose and tail, stopping if the one ahead has not moved off yet.
  - Vehicles that do not fit queue in the off-site holding area: the `hold` segment of the timeline. The vehicle is not in the yard then; `poseAt` returns the pose at the gate only so that a road path can join it. Draw held vehicles in your own holding area — drawn at the gate they overlap the vehicle that is entering.
  - Drop-and-hook moves, the yard shunter and, in the compact layout, exiting vehicles that cross the entry turn wait for the entry gate to be clear; the minute or two spent coupling or uncoupling a trailer also holds the space.
  - Drop stalls are booked by actual times (from the drop until the trailer is hooked, or all day if nobody hooks it), so a stall never holds two trailers; a trailer that finds every stall taken, or a stall free only too late for its door, is unloaded at the door by its own driver instead, and `notes` say so.
  - A vehicle that docks late has its pull-out re-placed at least a minute after docking, clear of other vehicles, with the door kept until then. Windows that become too short are compressed to the floor and flagged `tight` as before, lateness goes to `lateDock` / `lateExit`, and `siteSummary` adds it up.
  - How fast the entry gate lets vehicles in depends on their length: about one semi-trailer every 8–9 s from a standstill; in a yard without a staging lane (one with drop stalls, or the court-only layout) the next vehicle comes in only after the previous one has entered from the gate and cleared the entry gate. Denser arrivals, a full staging lane or more than the doors can serve mean queueing off-site and running late. The library tests ([`test/overload.test.ts`](test/overload.test.ts)) audit every second of a matrix of loads, door counts, access options, layouts and drop-and-hook: zero body overlap throughout.

## Tests

```bash
npm test -w @storewright/yard        # layout, routes, schedule (FIFO, one manoeuvre per section, no contact), drop-and-hook, frames, overload matrix (per-second overlap audit)
npm run typecheck -w @storewright/yard
npm run bench -w @storewright/yard   # scheduling time; --mem 8 for memory, --hash / --check to save and compare output fingerprints
```

## License

[AGPL-3.0-only](../../LICENSE), like the rest of the project. Changes: [CHANGELOG.md](CHANGELOG.md).
