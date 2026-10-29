# Purpose, results and outlook

[中文](purpose-and-outlook.zh-CN.md) · [Project report](project-report.en.md) · [Operation guide](../guide/operation-guide.en.md) · [Full English guide](../../README.en.md)

> This project is based on public information, common industry practice and the author's own design. **It is not affiliated with any retailer or company.** All stores, products, customers and numbers are synthetic. Every result here is evidence level B (simulation under stated assumptions), not a claim about any real store.
>
> Status as of 2026-10-26.

## 1. Why this project

### 1.1 Background

More and more grocery orders are placed online, and most are fulfilled inside stores: associates push carts through the aisles, stage the orders, and hand them to customers or drivers. Public sources show where this gets hard:

| Problem | Public figure | Source |
|---|---|---|
| Store picking is manual and hits a ceiling | About 60–70 units per labor hour; a ~30-item order takes about 30 labor-minutes to pick (consultancy estimate, 2022) | [Consultancy report](https://www.mckinsey.com/industries/retail/our-insights/achieving-profitable-online-grocery-order-fulfillment) |
| Customers wait at pickup | Mystery shops: average curbside wait 5:21 (2019, 8 chains) and 3.5 min (2020, 4 retailers) | [Trade press](https://www.grocerydive.com/news/h-e-b-whole-foods-have-fastest-pickup-times-study-says/566152/), [research firm](https://storesight.com/resources/which-retailer-has-the-fastest-ogp-grocery-pickup-time) |
| Inventory records are often wrong, causing out-of-stocks and substitutions | 65% of store inventory records inaccurate in one study (2008); a store audit raised sales 11% (2025) | [Paper](https://pubsonline.informs.org/doi/10.1287/mnsc.1070.0789), [paper](https://arxiv.org/abs/2506.05357) |
| Online keeps growing | Online reached 20.9% of US grocery spending in Q3 2026 | [Trade press](https://theshelbyreport.com/2026/10/15/u-s-e-grocery-sales-climb-21-in-q3-capture-record-share/) |

Large chains already have mature systems. The stores that lack them are **mid-size regional chains and independent grocers** ([docs/03, G-03](../03-open-questions.md)).

### 1.2 Purpose

1. **Build a store digital twin for mid-size and independent grocers.** Online-order fulfilment (pick → stage → hand off), backroom inventory, shelf replenishment, staffing and store AI share one core; the 3D store stays in sync with live operations, replays any moment of the day and forecasts the next three hours; layout, staffing and policy changes are tried in a planning twin first.
2. **Make every store customizable.** Layout, rules, modules and AI models are configured per store, and the same code moves to another industry.
3. **Back every claim with evidence.** Each improvement is compared with a baseline in simulation, with its assumptions, confidence intervals and costs stated.
4. **Serve as a portfolio.** Show everyone the ideas, practice and planning behind a complete store-workflow solution, from understanding store work and designing the product to engineering, testing and honest evaluation. The whole system runs in the browser, so anyone can open it. Everything is in this repository, with no paid features or commercial services; see ["License" in the README](../../README.en.md).

## 2. Goals set at the start

Phase 0 (2026-10-18) froze the requirements and constraints ([docs/03](../03-open-questions.md), [decision 0001](../decisions/0001-phase0-decisions.md), [docs/05](../05-evaluation-and-roadmap.md)):

| # | Goal | How it is checked |
|---|---|---|
| G1 | Core fulfilment runs on associate phones and is safer and faster than a store with no dedicated system | Simulation experiments |
| G2 | Backroom, replenishment and staffing join the same core | Features and tests |
| G3 | Store AI is local-first and per store, and goes live only after beating simpler methods | Offline evaluation, promotion gates |
| G4 | A 2.5D / 3D simulator that runs in the browser, compares policies and stays smooth | Performance measurements |
| G5 | Configuration-driven, transferable to another industry | A second industry template |
| G6 | Honest results: evidence levels, confidence intervals, ablations, sensitivity analysis | Reports reproduce line by line |
| G7 | Compliance: public information only, neutral names, a non-affiliation statement | Self-check |
| G8 | Presentable: someone new understands what it does and proves within five minutes | In-browser demo, bilingual docs |

## 3. What was achieved

| Goal | Result | Evidence |
|---|---|---|
| G1 Fulfilment | ✅ Pick, stage, hand off and delivery trips run on phones. Simulation (mid-size store, 30 replications): overweight, crush-risk and chemical-mix totes 11–19% → 0; fill rate +1.0 point; average wait −15%; time orders sit at the door −81%; labor +4.9% (+0.4% in the efficiency profile) | [Phase 1 results](../06-phase1-results.md) |
| G2 Backroom, replenishment, staff | ✅ Receiving, put-away, counts, backroom retrieval, shelf-stock estimates, replenishment batches sized to what a cart can carry; editable schedule drafts that are re-scored; an on-duty team view and temporary reassignment that ends on time | [docs/09](../09-backroom-replenishment.md), [decision 0025](../decisions/0025-team-view-dispatch.md), [0026](../decisions/0026-flow-fixes.md) |
| G3 Store AI | ✅ Demand, arrival time, shelf availability, counts, substitutions and staffing models train locally and go live only after passing a gate; every recommendation states its reasons and is downgraded automatically when it keeps missing. With all AI on and the same labor: average wait −13%, 90th-percentile wait −23%, late orders 2.41% → 0.69% | [docs/10](../10-store-ai.md), [AI results](../11-ai-results.md) |
| G4 Simulator | ✅ The mid-size store runs at 60 fps in all six quality and view combinations at 1440 × 900 on a high-DPI screen, about 4 ms of main-thread time per frame; full-day simulation, policy comparison, store editor, AI advice | [docs/07](../07-simulator.md) |
| G5 Transfer | ✅ The same core runs a home-improvement store; the payoff shifts from batching to safety and AI staffing | [docs/12](../12-business-modules.md) |
| G6 Honesty | ✅ Common-random-number paired experiments, 95% confidence intervals, ablations, sensitivity analysis; a deliberately strong baseline; Phase 1, AI and industry reports reproduce line by line | [docs/05 part 1](../05-evaluation-and-roadmap.md), [docs/06](../06-phase1-results.md) |
| G7 Compliance | ✅ The information boundary is a written rule (G-02); neutral names; every document states non-affiliation; 199 third-party packages, all permissively licensed | [Compliance statement](../../COMPLIANCE.md), [third-party notices](../../THIRD_PARTY_NOTICES.md) |
| G8 Presentable | ✅ The whole system runs in the browser: the showcase shows the console, two phones, the 3D twin and a full-day simulation at once; Chinese and English READMEs and an English technical overview | [docs/13](../13-demo-and-deployment.md), [technical overview](../en/overview.md) |

Along the way the project grew in directions that were not in the first plan:

- **Your Store**: build a twin of your own store from an empty lot; it is generated from floor size and other settings, edited in full and checked before opening, then simulated for a full day or run as a live sandbox. Stores are saved in the browser and can be copied, exported and imported ([decision 0013](../decisions/0013-phase8-plan.md)).
- **Digital twin**: equipment telemetry and an alert loop (alerts reach the shift lead's phone with the orders, totes and cases affected), replay, forecast and twin health ([docs/14](../14-digital-twin.md)).
- **Store AI, second round**: early warnings, a nudge hub that interrupts less, schedules and absence cover, predictive maintenance, a closing review, recalls, incident checklists, a food safety log, short-dated markdowns and a "next up" task for everyone ([docs/15](../15-store-ai-roadmap.md), decisions 0021–0024).
- **Workflow review and fixes**: every role's steps were reviewed, 18 states where work could get stuck were fixed, and 25 simplifications were implemented ([docs/16](../16-operation-flows.md)).
- **Capacity**: tested as a 300-person store; 300 devices connect in 0.09 s, and at 50 commands a second every device sees each change within about 15 ms.

Size: 4 apps and 9 shared packages, about 82,000 lines of TypeScript source; 381 unit and property tests, 83 end-to-end runs across browsers including accessibility checks, and a 221-step walkthrough in 22 sections; 16 design documents and 27 decision records.

## 4. Not done, or simplified on purpose

- **No real store data and no field pilot.** All results come from simulation on synthetic data; they compare methods and do not predict any real store.
- **The demo has no real sign-in** (you pick an identity from a roster). A production deployment needs sign-in, roles and session expiry ([docs/08 §7](../08-live-operations.md)).
- **No local language, speech or vision model has been downloaded.** The interfaces and evaluations are ready; downloads need the author's consent ([docs/10 §10](../10-store-ai.md)).
- **No real equipment integration.** Temperature and door readings in the demo are simulated ([docs/14 §11](../14-digital-twin.md)).
- **No operational A/B test yet.** Open acceptance items of the second AI round are listed at the end of each decision record.
- **Not published yet**: the GitHub repository, the live demo and the website project page are still to come.

## 5. Outlook

### Near term: publish

1. Commit locally by phase, and make the GitHub repository public after the author's review.
2. Deploy the in-browser demo on GitHub Pages with a link to the source code, and add the demo address to the README.
3. Add a project page to the author's website with screenshots, a demo video and the project report.

### Mid term: validate

1. Calibrate task times, arrival times and out-of-stock rates on public datasets to rely less on assumptions.
2. Integrate real devices: Bluetooth scanners, label printers, thermostats and door sensors.
3. Add what production needs: sign-in and roles, HTTPS, a dependency vulnerability audit.
4. With the author's consent, download a small local language model and compare it with the template mode.
5. Checking the numbers in section 3 against real outcomes would need anonymized data from a real store, a small pilot of one workflow (for example handoff only) and operational A/B tests. This project is a portfolio; this item records what that validation would take.

### Long term: portfolio

1. Keep this repository up to date as a public portfolio: new ideas are tested in simulation first, then written into the documents and decision records ([decision 0027](../decisions/0027-portfolio-license.md)).
2. More industry templates (for example pharmacies and convenience stores) and more optional modules.
3. A hardware prototype for shelf sensing ([shelf sensing prototype guide](../hardware/shelf-sensing-prototype.md)).

Principles that stay: public information only; every result states its evidence level and assumptions; store data stays in the store; try changes in simulation before changing the floor.
