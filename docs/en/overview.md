# Storewright: technical overview

This page summarizes Storewright's design documents, architecture and results in English. The full documents are in Chinese; each section links to the original. Everything here is based on public information and the project's own design, and all data is synthetic. Storewright is not affiliated with any retailer or company.

**Contents:** [1. Scope](#1-scope) · [2. Workflow](#2-workflow) · [3. Architecture](#3-architecture) · [4. Operations simulator](#4-operations-simulator) · [5. Live operations](#5-live-operations) · [6. Backroom and replenishment](#6-backroom-and-replenishment) · [7. Store AI](#7-store-ai) · [8. Modules and a second industry](#8-modules-and-a-second-industry) · [9. In-browser demo, testing and capacity](#9-in-browser-demo-testing-and-capacity) · [10. Results](#10-results) · [11. Limits](#11-limits) · [12. Document map](#12-document-map)

## 1. Scope

Storewright is an integrated operations system for mid-size grocers and similar stores. It covers four connected areas:

| Area | What happens |
|---|---|
| Online-order fulfilment | Orders are locked before their pickup or delivery slot, picked into totes on pick walks, staged in temperature-zoned slots, and handed off to customers at pickup bays or to delivery drivers as multi-order trips. |
| Backroom inventory | Cases are received against advance shipping notices, labeled, put away to backroom bins, counted, and retrieved when a picker finds a shelf empty. |
| Shelf replenishment | The system estimates shelf stock from sales, picks, sensors and counts, and creates replenishment tasks before shelves run out. |
| Staffing | Plans keep total hours the same while moving them to busy hours; live dispatch suggests moving people between pick, stage and handoff. |

Customization is a core feature: every store has its own layout, rules, modules and AI models. Results are **evidence level B**: simulation with synthetic data under stated assumptions.

## 2. Workflow

*Source: [01 Workflow design](../01-workflow-design.md), [03 Open questions and decisions](../03-open-questions.md).*

**Domain model.** Orders have lines; lines are assigned to totes; totes belong to pick walks; staged totes occupy slots; a handoff session covers one pickup order or one delivery trip. Each item has four independent attributes: temperature zone (ambient, chilled, frozen, hot), handling (fragile, heavy, chemical, age-restricted), fulfilment type (picked into totes, general merchandise, oversized) and substitution policy.

**Main flow.**

1. *Order intake and slots.* Orders lock a fixed lead time before their slot; delivery orders must be ready earlier.
2. *Tote assignment.* Done once per order: heavy items at the bottom, fragile on top, chemicals separate from food, one temperature zone per tote, weight and volume limits.
3. *Pick walks.* All open totes in a slot are partitioned once, by aisle and zone overlap; the route through a walk is an ordered list (the pick order is the route). Cold-chain walks carry a time limit that starts at the first chilled or frozen item.
4. *Shortages and substitutions.* A picker who cannot find an item picks the customer's allowed substitute (ranked by the AI) or reports it short; if the backroom has stock, a backroom retrieval task is created and the picker moves on.
5. *Staging.* Totes go to suggested slots by temperature zone and order type; the slot is recorded so handoff staff can find them.
6. *Handoff.* When the customer reports "on my way" or arrives, staff pull the staged totes (scanning each), verify the pickup code, check ID for age-restricted items, and hand off. Wrong codes never lock entry; after three wrong codes a manual verification option appears. Delivery trips are verified once per trip.

**Engineering constraints (EC-1 to EC-10).** Single-pass tote assignment; one global partition of pick walks by aisle overlap; no tote-swapping optimization; pick order equals route order; pick walks organized by slot only (not by delivery trip); a fixed store-level "approaching" threshold, where ETA only triggers pulling staged totes; no cameras, license-plate recognition, geofencing or robots; no live substitution confirmation; trips end when handed to the driver. These keep the system simple to run on ordinary phones and avoid fragile dependencies.

## 3. Architecture

*Source: [04 Tech stack](../04-tech-stack.md), [08 Live operations](../08-live-operations.md), [13 Demo and deployment](../13-demo-and-deployment.md).*

- **TypeScript monorepo** with npm workspaces: `apps/simulator`, `apps/associate`, `apps/server`, `apps/sim-cli`, and packages `domain`, `store-config`, `synth`, `algorithms`, `sim-engine`, `ops`, `labels`, `ai`.
- **Event sourcing.** `decide(state, envelope, context)` is a pure function returning events or a rejection code; `applyEvent` applies an event in place. The same core runs on the server, every phone and the simulator, so replaying the log always gives the same state.
- **Store hub.** All endpoints live in a transport-agnostic hub with injected storage and crypto. Node serves it through Fastify (HTTP and WebSocket) with an embedded PostgreSQL (PGlite) or a real PostgreSQL; the browser demo runs the same hub in a SharedWorker, or in one dedicated worker per page where SharedWorker is missing, with IndexedDB storage.
- **Sync protocol.** Clients receive a snapshot, then numbered events; gaps trigger a resync; commands made offline wait in an outbox and are sent on reconnect.
- **Capacity.** Each push is serialized once and shared by every connected device; pushes to devices are batched (immediately when idle, at most every 15 ms under load, up to 256 events), while services inside the store (AI, auto operations, store simulation) still see every event immediately. Device snapshots leave out work finished more than an hour ago; static store data (planogram, bins, roster) is versioned and cached on the device. See §9 for numbers.

## 4. Operations simulator

*Source: [07 Simulator](../07-simulator.md), [06 Phase 1 results](../06-phase1-results.md), [pseudocode](../pseudocode/).*

- **Discrete-event engine** (`packages/sim-engine`): a full store day of orders, pickers, stagers, handoff staff, customers and drivers; inbound trucks scheduled to dock doors; night restocking; road congestion; small and large incidents; shelf stock; an auto-service center and pharmacy; experiments with **common random numbers**, confidence intervals, ablation and sensitivity analysis; an operating P&L for comparing scenarios.
- **2.5D / 3D client** (React Three Fiber, simulation in a Web Worker): iso, 3D and top views; interior, cutaway and exterior building views; roads with signals, lane changes and pedestrians; parking with pickup bays; vehicles with acceleration, braking, steering and lamps, and semi-trailers backing into docks with articulated kinematics; day and night, weather and seasons; a guided tour and a cinematic camera; Chinese and English.
- **Store editor**: generate a store from size and facilities, then edit shelves, aisles, floors, receiving, backroom and staging areas, dock doors, pickup bays, facilities and surroundings, with validation and undo. Overlapping scene labels are decluttered so the most important stay readable.
- **Live view**: connected to a running store, the scene shows associates, staged totes, arriving customers' cars and docked trucks.
- **Phones**: the top bar and project bar collapse to one row; the scene takes about two-thirds of the screen.

## 5. Live operations

*Source: [08 Live operations](../08-live-operations.md), [decision 0014](../decisions/0014-handoff-rules-and-scale.md).*

- **Associate app** (PWA): pick, stage, handoff, inventory, modules, AI and "more" tabs by role; scan or type labels; a demo console stands in for the order platform, customers and drivers.
- **Dual track**: "auto operations" adds virtual customers and associates who work their own orders on separate pick walks and trips while sharing staging and shelves with the people on the phones.
- **Driver cancellation**: a driver may cancel before the 10-minute prep window that precedes the expected arrival, may not cancel inside it or during the first 10 minutes after arriving, and may cancel after waiting 10 minutes (recorded as a store-caused wait). The system then re-dispatches the trip, ends the prep session, returns pulled totes to their slots, notifies customers of the delay, and flags orders that may miss their window. If a driver never shows up, a lead can re-dispatch.
- **Areas**: receiving (unloading, receiving hold, QA, return to vendor, cage, pallets, baler), backroom storage (racks, cooler, freezer, overstock) and staging areas, each with capacity, occupancy and alerts.

## 6. Backroom and replenishment

*Source: [09 Backroom and replenishment](../09-backroom-replenishment.md).*

Receiving against advance shipping notices (short and damaged cases), one label per case, put-away with bin suggestions (including QA and return-to-vendor bins), cycle counts, and backroom retrieval for picker shortages. Shelf stock is estimated per item from sales, picks, sensors and counts; replenishment tasks are prioritized and batched by area. Sensors (time-of-flight and weight) and POS feeds come in over HTTP or MQTT; a store simulation produces shopping, shrink and noisy sensor readings so the loop can be tested end to end.

## 7. Store AI

*Source: [10 Store AI](../10-store-ai.md), [11 AI results and model cards](../11-ai-results.md), [decision 0010](../decisions/0010-roadmap-and-phase5-plan.md).*

- **Local-first and per store.** Models are trained on the store's own configuration and history (simulated history first), in plain TypeScript, with no cloud dependency.
- **Recommendations are events** with factor-coded reasons, confidence, alternatives, and the staff response (accept, override with a reason, dismiss). Each module runs in SHOW, CONFIRM or AUTO mode, and modes can be locked.
- **Promotion gates.** A candidate model is compared with the current one and with simple baselines on the same rolling backtest, and goes live only if it passes; rollback is one command.
- **Models**: hourly demand (known-factor regression), arrival-time correction (hierarchical shrinkage), shelf availability and phantom stock (logistic model with sales-silence checks), risk-based cycle counts, substitution ranking, staffing plans and live dispatch, made-to-order prep timing, return dispositions within hard safety rules, and load planning.
- **Simulation as the evaluation field.** The synthetic history contains factors the models cannot observe (true weather, local events, demand shifts), so models cannot simply learn the generator.
- **Assistant**: answers questions with nine read-only tools over store data plus store notes and procedures, cites its sources, and can run "what if" simulations; an optional local LLM, otherwise rules plus a local intent classifier.
- **Ethics**: no individual turnover prediction or individual productivity ranking; staff data is anonymized when people leave.

## 8. Modules and a second industry

*Source: [12 Business modules](../12-business-modules.md).*

Four pluggable modules, each switched on per store and each with an AI hook: made-to-order deli (prep start time, expiry and waste), returns (disposition within food-safety and hazardous-material rules), oversized items (scan, then print one label per piece; load planning) and a parcel hub (slot suggestions, driver handoff per trip). The same core was moved to a **home-improvement store** by changing configuration and data only; the documents record what changed and what was reused.

## 9. In-browser demo, testing and capacity

*Source: [13 Demo and deployment](../13-demo-and-deployment.md), [decision 0014](../decisions/0014-handoff-rules-and-scale.md), [decision 0015](../decisions/0015-v1-release.md).*

- **Showcase page**: the demo console, two associate phones, the live store and a full-day simulation side by side, with a six-step guide; data is kept in the browser for 12 hours; a phone layout shows one screen at a time.
- **Tests**: 218 unit and property tests; end-to-end tests with a real backend and with the in-browser demo on Chromium, WebKit (Safari), Firefox, iPhone and Android emulation and browsers without SharedWorker (51 runs), plus automatic accessibility checks (every control has a name, text contrast meets WCAG AA in light and dark themes, keyboard sign-in works); a 15-section, 149-step walkthrough that records every step with a screenshot into an illustrated report. Phase 1, AI and industry reports are checked to reproduce line by line.
- **Capacity test** (`npm run loadtest -w @storewright/server`, a two-floor store with 300 staff, in one process):

| Measure | Before the upgrade | After |
|---|---|---|
| 300 devices connecting at shift start | 6.5 s, 2.5 GB sent | 0.09 s, about 3.6 MB per device (1.9 MB after a page reload) |
| Saturated throughput | 739 commands/s | 2,792 commands/s |
| Submit to every device receiving it (p95, saturated) | 83 ms | 22 ms |
| Messages per device during the burst | about 5,900 | 53 |
| Steady 50 commands/s (p95) | — | 15 ms (16.5 ms writing every command to PGlite) |

- **CI and hosting**: GitHub Actions runs type checks, unit tests, the Phase 1 comparison and the end-to-end matrix; the demo site is static and can be served from any static host; a Dockerfile runs the real backend.

## 10. Results

*Simulation with synthetic data; see each document for assumptions, calibration and sensitivity.*

**Phase 1** (medium store, 30 replications, common random numbers):

| | Default profile (service and safety first) | Efficiency profile |
|---|---|---|
| Overweight / crush-risk / chemical-mix totes | 11–19% → **0** | → **0** |
| Fill rate | **+1.0 pt** (short-line sales −52%) | **+1.0 pt** |
| Average customer wait | **−15%** | no significant difference |
| Time orders sit at the door (cold-chain risk) | **−81%** | **−79%** |
| Total labor | +4.9% | **+0.4%** |

**Store AI** (default profile, all AI on, same total labor): average wait −13%, 90th-percentile wait −23%, late orders 2.41% → 0.69%. Hourly demand forecast error (WAPE, 8 seeds): seasonal naive 26.2%, four-week mean 21.6%, seasonal exponential smoothing 20.3%, oracle floor 17.6%; the known-factor model improves further on special days.

**Second industry**: a home-improvement order is about one tote, so batching and routing barely help; the gains come from safety (17.6% overweight totes → 0), door dwell, and AI staffing, which removes most early-morning late orders (≈10% → ≈0).

## 11. Limits

- No real-store pilot: all results are simulations; field validation with real devices and stores is future work.
- The demo has no real sign-in; production needs authentication, roles and session expiry.
- Real scanners, printers and sensors are represented by interfaces, virtual devices and conformance tests.
- A local LLM is optional; without one the assistant uses rules and a local classifier.
- Browsers without SharedWorker run one demo store per page: tabs do not share it.

## 12. Document map

| Chinese document | Topic |
|---|---|
| [01-workflow-design](../01-workflow-design.md) | Workflow, state machines, entities, labels, events, engineering constraints |
| [02-feasibility](../02-feasibility.md) | Technical, economic, operational and compliance feasibility with sources |
| [03-open-questions](../03-open-questions.md) | 109 design questions and decisions |
| [04-tech-stack](../04-tech-stack.md) | Architecture principles and technology choices |
| [05-evaluation-and-roadmap](../05-evaluation-and-roadmap.md) | Evaluation method and phased plan |
| [06-phase1-results](../06-phase1-results.md) | Phase 1 results, calibration, ablation, sensitivity |
| [07-simulator](../07-simulator.md) | Operations simulator |
| [08-live-operations](../08-live-operations.md) | Associate app and realtime backend |
| [09-backroom-replenishment](../09-backroom-replenishment.md) | Backroom inventory and replenishment |
| [10-store-ai](../10-store-ai.md) | Store AI design |
| [11-ai-results](../11-ai-results.md) | AI results and model cards |
| [12-business-modules](../12-business-modules.md) | Modules and the home-improvement store |
| [13-demo-and-deployment](../13-demo-and-deployment.md) | In-browser demo, tests, CI and hosting |
| [decisions/](../decisions/) | Decision records 0001–0015 |
