# Instructor answer key

Computed from the simulation by `npm run teach -- key --write` (default region, seed 1; the simulation is deterministic, so every computer gets the same numbers). Grading uses the same numbers: number questions within the stated tolerance, choices by option, and set-up tasks by re-running the student's scenario.

Each exercise is worth 100 points; 70% passes. Synthetic data, for teaching only.

## ex01 · Read a day: the rhythm of the chain and its KPIs

| Item | Answer | Points | Tolerance |
|---|---|---:|---|
| q1 | 24 | 25 | ± 0 |
| q2 | 85.7 % | 25 | ± 0.15 |
| q3 | 99.58 % | 25 | ± 0.015 |
| q4 | 2.02 USD | 25 | ± 0.006 |

## ex02 · Port: how long containers sit in the yard, and where demurrage comes from

| Item | Answer | Points | Tolerance |
|---|---|---:|---|
| q1 | 4.37 days | 25 | ± 0.05 |
| q2 | 1.66 days | 25 | ± 0.05 |
| q3 | 105 USD / day | 25 | ± 2 |
| q4 | b. Port pre-clearance and appointments + rail shuttle | 25 | — |

## ex03 · Fleet size and unloading pace: why slower store receiving needs more trucks

| Item | Answer | Points | Tolerance |
|---|---|---:|---|
| t1 | Store receivers set to 1 on all three shifts (Load still "Extreme") | 20 | — |
| q1 | 6 vehicles | 20 | ± 0 |
| q2 | 8 vehicles | 20 | ± 0 |
| q3 | 11 vehicles | 20 | ± 0 |
| q4 | c. Each pallet unloads more slowly, trucks stay longer at the store and miss their next trip, so more trucks are sent | 20 | — |

## ex04 · DC dock doors: size for the peak

| Item | Answer | Points | Tolerance |
|---|---|---:|---|
| t1 | Cold dock doors set to the fewest with no queueing, and no cold-door queue or shortage warnings | 30 | — |
| q1 | 7 doors | 20 | ± 0 |
| q2 | 7 doors | 30 | ± 0 |
| q3 | b. Trucks arrive and leave in a few night and early-morning hours; doors must cover the concurrent peak, otherwise trucks queue at the peak | 20 | — |

## ex05 · Cold chain: remaining shelf life at the store and fresh waste

| Item | Answer | Points | Tolerance |
|---|---|---:|---|
| q1 | 63.2 % | 25 | ± 0.15 |
| q2 | 79.7 % | 25 | ± 0.15 |
| q3 | 2.75 percentage points | 25 | ± 0.03 |
| q4 | b. Night consolidation + cross-docking: delivered the same day, no night in the DC | 25 | — |

## ex06 · Store receiving: how many docks

| Item | Answer | Points | Tolerance |
|---|---|---:|---|
| t1 | Receiving docks set to the fewest that suffice, with no "not enough store docks" warning | 30 | — |
| q1 | 4 issues | 20 | ± 0 |
| q2 | 4 docks | 30 | ± 0 |
| q3 | c. Schedule more receivers to unload faster, or stagger truck arrivals | 20 | — |

## ex07 · Drill: impact of and response to port congestion

| Item | Answer | Points | Tolerance |
|---|---|---:|---|
| q1 | 1.3 days | 25 | ± 0.03 |
| q2 | a. Hardly at all (less than 0.05 points) | 25 | — |
| q3 | -0.22 days | 25 | ± 0.02 |
| q4 | c. Inventory in the DC and store covered the late days (the drop in DC inventory days is the evidence) | 25 | — |

## ex08 · Stress test: from normal to extreme, where is the bottleneck

| Item | Answer | Points | Tolerance |
|---|---|---:|---|
| q1 | 6 vehicles | 20 | ± 0 |
| q2 | 1.86 USD | 20 | ± 0.006 |
| q3 | a. Rush-hour congestion (高峰拥堵) | 30 | — |
| q4 | c. Fixed resources such as the DC and fleet are spread over more cases (economies of scale) | 30 | — |

## ex09 · Comparing schemes: previous generation / StoreX / StoreX Chain

| Item | Answer | Points | Tolerance |
|---|---|---:|---|
| q1 | c. StoreX Chain | 25 | — |
| q2 | 10.07 days | 25 | ± 0.05 |
| q3 | 2.34 percentage points | 25 | ± 0.03 |
| q4 | a. DC inventory depends on how the upstream replenishes: the Chain shares sales data, cross-docks fresh goods and automates the DC, so upstream replenishment changes too | 25 | — |

## ex10 · Root cause with the duty assistant: ask, then verify on the Dispatch board

| Item | Answer | Points | Tolerance |
|---|---|---:|---|
| q1 | DS-BEV-2 | 25 | — |
| q2 | 8 min | 25 | ± 1 |
| q3 | b. Prepares a proposal only; a person with the right role must confirm it in the UI before anything happens | 25 | — |
| q4 | b. Every number is tied to a source (Dispatch board, KPI board, hub plans) that you can check one by one | 25 | — |

