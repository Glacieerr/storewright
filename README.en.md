# Storewright

> An integrated store-operations system for **mid-size regional and independent grocers**: online-order fulfilment (**pick → stage → hand off**), **backroom inventory**, **shelf replenishment** and **staffing**, plus a **2.5D / 3D operations simulator** you can watch and steer like a management game. Every store gets its own **local, per-store AI** that explains each recommendation. The whole system also runs **inside your browser** with no backend.

This project is based on public information, common industry practice and the author's own design. **It is not affiliated with any retailer or company.** All stores, products, customers and numbers are synthetic.

Chinese is the primary documentation language; this page is the English overview. 中文说明见 [README.md](README.md)。

---

## What it shows

| Question | What Storewright does | Result (simulation, synthetic data) |
|---|---|---|
| Can one system run the whole online-order workflow? | Event-sourced operations core shared by the server, the associate PWA and the simulator; pick, stage, handoff, trips, backroom, replenishment | A test order goes through four devices end to end (automated browser test) |
| Does it beat a store with no dedicated system? | Weight- and crush-aware tote assignment, aisle-overlap batching, TSP routing, cold-chain limits, recorded staging, ETA-based prep | Overweight / crush-risk / chemical-mix totes 11–19% → **0**; fill +1.0 pt; average wait **−15%**; door dwell **−81%**; labor +4.9% |
| Can AI help without new hardware or a cloud bill? | Per-store models trained locally on the store's own simulated history, gated against simpler baselines before going live, every recommendation with reasons | With all AI on and the same total labor hours: average wait **−13%**, p90 wait **−23%**, late orders 2.41% → **0.69%** |
| Does it transfer to another industry? | Pluggable modules (made-to-order deli, returns, oversized "scan then print", parcel hub) and a home-improvement store template on the same core | Payoffs move: batching barely matters (≈1 tote per order), safety and AI staffing matter more (late orders ≈10% → ≈0) |

No profile wins on every metric: a store picks its priorities and sees the trade-offs in simulation first.

## Try it

**In the browser (no install):** build the static site and open the showcase page. The simulator, a demo console and two associate phones run side by side, all connected to an in-browser store hub (a SharedWorker running the same code as the server).

```bash
npm install
```

```bash
npm run build:site
```

```bash
npm run demo:site
```

Then open http://127.0.0.1:4177/. Create an order in the console and watch it get picked, staged and handed off on the phones while it appears in the simulator. `?store=hardware` switches to the home-improvement store.

**With the real backend:**

```bash
npm run build:associate
```

```bash
npm run server
```

Open http://localhost:8787 (phones on the same Wi-Fi can open the computer's LAN address). `STORES=demo,hardware npm run server` runs both stores.

**Simulator only:** `npm run dev` → http://localhost:5173.

| Command | Purpose |
|---|---|
| `npm run check` | Type checks + all unit and property tests (200) |
| `npm run e2e` | Multi-browser end-to-end tests (run `npm run build:all` first; uses the installed Chrome) |
| `npm run walkthrough` | Full walkthrough: every flow step by step with screenshots, written to an illustrated report (`experiments/results/walkthrough/report.html`, ~3 min) |
| `npm run compare -- --template medium --reps 30 --profiles --ablation` | Baseline vs optimized with common random numbers, ablation, confidence intervals |
| `npm run ai-report` | AI benefit report: offline evaluation of every model family, AI on/off, trade-off curves, sensitivity (~25 s) |
| `npm run industry-report` | Grocery vs home-improvement comparison: configuration, order shape, operations, AI, forecasting (~10 s) |

Requires Node.js 20+.

## Architecture

```
apps/simulator   2.5D / 3D simulator (React Three Fiber, simulation in a Web Worker), store editor, live view
apps/associate   Associate PWA (pick, stage, handoff, inventory, modules, AI, demo console) + in-browser demo
apps/server      Store hub (transport-agnostic, shared by Node and the browser) + Fastify shell
apps/sim-cli     Experiments and reports
packages/domain        Domain types, event log, rule engine, deterministic RNG
packages/store-config  Store configuration schema, generator, templates (incl. home improvement)
packages/synth         Synthetic catalog, orders, demand history with hidden factors, arrivals, shelf truth
packages/algorithms    Tote assignment, batching, routing, cold chain, trips, replenishment, planogram
packages/sim-engine    Discrete-event simulation, policies, traffic, incidents, experiments, statistics
packages/ops           Operations core: command → events → state as pure functions; views; live client
packages/labels        QR, tote / case / slot / location labels (SVG + ZPL)
packages/ai            Recommendations with reasons, backtests, model registry with promotion gates, models
```

Key design choices:

- **Event sourcing everywhere.** `decide(state, command)` is pure; events are applied in place on every client; the same core runs on the server, the phones and the simulator.
- **Local-first, per-store AI.** Each store's models are trained on the store's own configuration and (simulated, then real) history, compared with simpler baselines on the same data, and promoted only if they pass a gate. Recommendations carry factor-coded reasons, confidence and alternatives, and run in SHOW / CONFIRM / AUTO modes. A local assistant answers questions through read-only tools over store data, with an optional local LLM.
- **Simulation as the evaluation field.** Synthetic data contains factors the models cannot see (local events, demand shifts, customer preference types), so models cannot just "learn the generator".
- **One hub, two transports.** All server endpoints live in a transport-agnostic hub with injected storage and crypto. Fastify serves it over HTTP / WebSocket; the browser demo runs it in a SharedWorker with in-memory storage.

## Documentation (Chinese)

| Doc | Content |
|---|---|
| [01 Workflow design](docs/01-workflow-design.md) | Modules, state machines, entities, events, engineering constraints |
| [05 Evaluation & roadmap](docs/05-evaluation-and-roadmap.md) | Evaluation method and phased plan |
| [06 Phase 1 results](docs/06-phase1-results.md) | Calibration, main results, ablation, sensitivity |
| [07 Simulator](docs/07-simulator.md) | Features, architecture, performance |
| [08 Live operations](docs/08-live-operations.md) | Associate app and realtime backend |
| [09 Backroom & replenishment](docs/09-backroom-replenishment.md) | Receiving, put-away, counts, shelf estimates, sensing |
| [10 Store AI](docs/10-store-ai.md) | Local-first AI design, models, assistant, ethics |
| [11 AI results & model cards](docs/11-ai-results.md) | Offline evaluation, AI on/off, nine model cards |
| [12 Business modules & second industry](docs/12-business-modules.md) | Module framework, four modules, home-improvement template |
| [13 In-browser demo, E2E & deployment](docs/13-demo-and-deployment.md) | Store hub, SharedWorker, showcase, tests, CI, hosting |
| [Decision records](docs/decisions/) | 0001–0012 |

## Evidence level and limits

All results are **evidence level B** (simulation with synthetic data): useful for comparing methods under stated assumptions, not a claim about any real store. Assumptions, calibration, sensitivity analyses and known simplifications are listed in each document. Real devices (scanners, printers, sensors) are represented by interfaces, virtual devices and conformance tests.

## License

- Code (core, simulator, backend, associate app, AI): AGPL-3.0, with a commercial license available.
- Documentation, pseudocode and reports: CC BY 4.0.
