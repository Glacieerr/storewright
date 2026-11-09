# Data dictionary: `docs/results/data.json`

数据字典：`docs/results/data.json` 的字段、含义和单位。This page describes the machine-readable results of StoreX Chain (part 3). The matching JSON Schema is [data.schema.json](data.schema.json) (JSON Schema 2020-12). This project is not affiliated with any retailer or company (本项目与任何零售商、企业无隶属关系); every number in the file comes from simulations with synthetic data.

## Where the file comes from

- **Generated, never edited by hand.** `npm run reports` (run in `StoreX-Chain/`, entry point `src/cli/main.ts all`, writer `src/cli/write.ts`) runs all experiments and rewrites everything in `docs/results/`: the Markdown result pages, the SVG charts and `data.json`. Hand edits are lost on the next run and break `npm run docs:check`.
- **Same data for the web app.** The same run writes the same JSON to `web/src/data/results.json`, which the web app's "Compare and reports" page reads. The two files should be identical apart from `runtime`.
- **Numbers in the documents.** The README and `docs/01`–`04` mark numbers taken from this file as `<!--n:path|digits|unit-->value<!--/n-->`. `npm run docs:sync` rewrites the values from `data.json`; `npm run docs:check` (and `tests/docs.test.ts`) fails when a marked number differs. In a path, object keys are separated by dots and array elements are chosen by their `key` or `gen` field or by index, for example `gens.g3.mean.costPerCase` or `stress.demandSurge.gens.g1.lostUnits`. The unit can be `k` (thousand), `w` (ten thousand, 万) or `m` (million); `pct:pathA:pathB` is the percentage change from A to B.
- **Deterministic.** Seeds are fixed, so the same code gives the same file except `runtime`. If a change is not meant to alter the results and `data.json` changes anyway, something else changed too.

## Conventions

- Numbers are rounded when written: 0 decimals at 1,000 or more, 1 decimal from 100, 2 decimals from 1, 4 decimals below 1. A value that cannot be computed is written as `null`.
- Money is in US dollars; "per day" means per simulated day, averaged over the 18-week run unless stated otherwise.
- Percentages are written as percent (0–100), not fractions, unless stated otherwise.
- Generations: `g1` previous generation (上一代), `g2` StoreX, `g3` StoreX Chain (StoreX 全链路).
- Labels (`label`, `title`, `detail`, `question`, `reason`) are Chinese display text.

## Top-level keys

| Key | Type | Meaning |
|---|---|---|
| `seeds` | object | Number of seeds per experiment family |
| `kpis` | array | The KPI dictionary: key, label, unit, group, direction, display digits (the key to every `mean` object below) |
| `gens` | array | The three generations: mean and 95% confidence half-width of every KPI, cost by category |
| `costCats` | array of strings | Labels of the cost categories, in the order of `gens[].cost` |
| `pairs` | object | Paired comparisons of g3 against g1 and against g2 for every KPI |
| `levers` | array | What each decision lever is worth on its own |
| `sweeps` | array | The decision sweeps: one lever varied, the others at the g3 choice |
| `capacity` | object | Demand growth: every KPI at several demand scales for each generation |
| `stress` | array | Stress drills: disruptions and how each generation copes |
| `automation` | array | The business case of DC automation in three cases |
| `economics` | object | Investment, NPV, IRR, payback and cash flow of the upstream step and of the whole system, plus sensitivity |
| `stores` | array | The store(s) in the region |
| `flows` | array | The flow plan: direct-to-store or via the DC per long-haul product family |
| `twin` | object | The closed-loop twin study: outcomes by policy and field level, twin fidelity |
| `runtime` | number | Seconds the whole `npm run reports` run took (the only field that changes between identical runs) |
| `runs` | number | Number of simulation runs behind the file |

## `seeds`

| Field | Unit | Meaning |
|---|---|---|
| `compare` | count | Seeds in the generation comparison (`gens`, `pairs`) |
| `sweep` | count | Seeds per configuration in the sweeps, capacity and stress experiments |

The twin study has its own count, `twin.seeds`.

## `kpis[]`

Each entry: `key` (used in every `mean` object), `label`, `unit`, `group` (门店 store, 配送中心 DC, 干线与配送 line-haul and delivery, 港口与机场 port and airport, 成本 cost, 排放 emissions, 全系统 whole system), `better` (`higher`, `lower` or `none`) and `digits` (decimals used for display). The list is the same as `KPIS` in `src/analysis/kpi.ts`.

| Key | Label in the file | Meaning | Unit |
|---|---|---|---|
| `service` | 门店服务水平（需求满足） | Store service level (share of demand met) | % |
| `stockout` | 收市时卖空的商品位 | Product slots sold out at closing | % |
| `storeInv` | 门店库存 | Store inventory | days |
| `waste` | 门店生鲜损耗（报废 / 到货） | Store fresh waste (scrapped / received) | % |
| `freshRemain` | 生鲜到店时剩余的保质期 | Remaining shelf life of fresh goods on arrival | % |
| `arrivals` | 到店卸货的车次（配送车、面包车、长途直送） | Truck arrivals unloading at the store (delivery trucks, vans, long-haul direct) | per day |
| `onTime` | 准时送达 | On-time delivery | % |
| `peakAmbient` | 门店常温货最多的时候（货架 + 后仓） | Peak ambient stock in the store (shelf + backroom) | pallets |
| `peakChilled` | 门店冷藏货最多的时候（货架 + 冷藏库） | Peak chilled stock in the store (shelf + chiller) | pallets |
| `peakFrozen` | 门店冷冻货最多的时候（货架 + 冷冻库） | Peak frozen stock in the store (shelf + freezer) | pallets |
| `dcInv` | 配送中心库存 | DC inventory | days |
| `dcFill` | 配送中心订单满足率 | DC order fill rate | % |
| `dcLabor` | 配送中心工时 | DC labour | hours / day |
| `casesPerHour` | 配送中心每工时处理的箱数 | DC cases handled per labour hour | cases |
| `trips` | 配送车次（不含面包车） | Delivery trips (excluding vans) | trucks / day |
| `vanTrips` | 面包房直送小货车 | Bakery direct vans | vans / day |
| `outKm` | 配送里程（含面包车） | Delivery distance (including vans) | km / day |
| `fill` | 配送车装载率 | Delivery truck fill rate | % |
| `fleet` | 配送车队（最多同时用车） | Delivery fleet (most trucks in use at once) | trucks |
| `evShare` | 电动车承担的配送里程 | Share of delivery distance driven electric | % |
| `inboundLoads` | 长途整车（进配送中心 + 直送门店，不含回程顺带） | Long-haul truckloads (into the DC + direct, excluding backhauls) | loads / day |
| `directShare` | 长途整车直送门店的比例 | Share of long-haul truckloads delivered direct to the store | % |
| `inboundKm` | 进货里程（长途整车 + 区域生鲜 + 机场） | Inbound distance (long-haul + regional fresh + airport) | km / day |
| `domLead` | 长途公路：下单到到货（配送中心或门店） | Long-haul road lead time, order to arrival (DC or store) | days |
| `dwell` | 集装箱在港口堆场停留 | Container dwell in the port yard | days |
| `railShare` | 走铁路的集装箱 | Containers moved by rail | % |
| `seaLead` | 海运：下单到进配送中心 | Ocean lead time, order to DC | days |
| `railLead` | 铁路班列：下单到进配送中心 | Block-train lead time, order to DC | days |
| `airLead` | 空运：下单到进配送中心 | Air lead time, order to DC | days |
| `demurrage` | 港口滞箱费 | Port demurrage | USD / day |
| `costTransport` | 运输成本（配送 + 面包车 + 进货 + 港口拖车和铁路） | Transport cost (delivery + vans + inbound + drayage and rail) | USD / day |
| `costDc` | 配送中心人工 | DC labour cost | USD / day |
| `costCarrying` | 库存持有成本 | Inventory carrying cost | USD / day |
| `costWaste` | 生鲜报废和打折 | Fresh scrap and markdowns | USD / day |
| `costLost` | 缺货流失的毛利 | Gross margin lost to stock-outs | USD / day |
| `costFreight` | 海运、班列、空运运费 | Ocean, rail and air freight | USD / day |
| `costTotal` | 供应链成本合计 | Total supply-chain cost | USD / day |
| `costPerCase` | 每箱的供应链成本 | Supply-chain cost per case | USD / case |
| `workingCapital` | 库存资金（门店 + 配送中心） | Inventory capital (store + DC) | million USD |
| `co2Local` | 本地运输排放（配送、进货、港口） | Local transport emissions (delivery, inbound, port) | t CO₂ / day |
| `co2Long` | 远洋、班列和航空排放（分摊到自己的货） | Ocean, rail and air emissions allocated to the store's cargo | t CO₂ / day |
| `co2PerCase` | 每箱的本地运输排放 | Local transport emissions per case | g CO₂ / case |
| `storeOpex` | 门店人工 + 能耗（来自 StoreX 报告） | Store labour and energy (from the StoreX report) | USD / day |
| `systemTotal` | 全系统运营成本（供应链 + 门店人工能耗） | Whole-system operating cost (supply chain + store labour and energy) | USD / day |

## `gens[]`

One entry per generation, averaged over `seeds.compare` seeds.

| Field | Unit | Meaning |
|---|---|---|
| `gen` | `g1` / `g2` / `g3` | Generation key |
| `label` | text | 上一代 / StoreX / StoreX 全链路 |
| `mean` | KPI units | Mean of every KPI over the seeds (keys from `kpis`) |
| `ci` | KPI units | Half-width of the 95% confidence interval of each mean |
| `cost` | USD / day | Daily cost by category, in the order of `costCats` |

## `costCats[]`

The labels of the cost categories in `gens[].cost`, in order: delivery (including vans), inbound transport (including long-haul direct), drayage and rail, ocean / rail / air freight, DC labour, inventory carrying, fresh scrap and markdowns, gross margin lost to stock-outs.

## `pairs`

`g3g1` (StoreX Chain against the previous generation) and `g3g2` (against StoreX) each hold one entry per KPI, compared seed by seed:

| Field | Unit | Meaning |
|---|---|---|
| `key` | | KPI key |
| `pct` | % | Change of g3 relative to the other generation: mean paired difference ÷ the other generation's mean × 100 |
| `verdict` | text | `改善` better, `变差` worse, `无显著差异` no significant difference, `—` no direction (`better: none`) |

## `levers[]`

What each lever is worth on its own: the change when only this lever goes from its baseline value to the chosen value, with every other lever at the g3 choice. Interactions mean the rows do not add up to the total difference. Negative cost and CO₂ = savings.

| Field | Unit | Meaning |
|---|---|---|
| `key`, `title` | | Lever (same keys as `sweeps`) |
| `from`, `to` | text | Baseline and chosen values as displayed |
| `cost` | USD / day | Change in `costTotal` |
| `co2` | t CO₂ / day | Change in `co2Local` |
| `service` | percentage points | Change in `service` |
| `inventory` | million USD | Change in `workingCapital` |

## `sweeps[]`

| Field | Meaning |
|---|---|
| `key`, `title`, `question` | The lever and the question the sweep answers |
| `chart` | KPI key drawn in the sweep's chart |
| `chosen` | The value chosen for g3 (same units as `points[].value`) |
| `kpis` | KPI keys reported for this sweep |
| `note` | Optional: a caveat on how to read the sweep (present on some sweeps only) |
| `points[]` | One per tested value: `value`, `label` (display text) and `mean` (mean of each KPI in `kpis` over `seeds.sweep` seeds) |

## `capacity`

| Field | Meaning |
|---|---|
| `scales` | Demand multipliers tested (1 = today's demand) |
| `gens.g1`, `gens.g2`, `gens.g3` | One object per scale, in the order of `scales`, with the mean of every KPI (keys from `kpis`) |

## `stress[]`

One entry per disruption (`portCongestion`, `airportClosed`, `highwayClosed`, `supplierOutage`, `demandSurge`): `key`, `label`, `detail` (what happens) and `gens.{g1,g2,g3}`. Every metric compares each seed with the same seed without the disruption, so only the disruption's effect is counted.

| Field | Unit | Meaning |
|---|---|---|
| `window` | % | Mean store service level over the 3 weeks after the disruption starts |
| `windowDrop` | percentage points | How much lower that mean is than without the disruption |
| `worstDrop` | percentage points | Largest drop on any single day of those 3 weeks |
| `airDrop` | percentage points | Largest one-day drop in the air-freight fresh service in the first week |
| `onTimeDrop` | percentage points | Largest one-day drop in on-time delivery in the first 3 days |
| `response` | USD | Cost of the response measures (bridge buying, diversions and so on) |
| `extraCost` | USD | Extra supply-chain cost over the run, response included |
| `lostUnits` | units | Extra lost sales over the 3 weeks |

## `automation[]`

The business case of DC automation in three cases: `基准` (base case), `保守情景` (conservative scenario) and an optimistic case whose label states its assumptions.

| Field | Unit | Meaning |
|---|---|---|
| `label` | text | The case |
| `npv` | USD | Incremental 10-year NPV of automation (with against without) |
| `irr` | % | Incremental internal rate of return |
| `payback` | years | Incremental payback; `null` when it never pays back |
| `withoutNpv` | USD | NPV of the upstream step without automation |
| `hours` | hours / day | DC labour hours saved per day at the chosen automation share |

## `economics`

`upstream` (the supply-chain step) and `system` (supply chain plus the comprehensive-store upgrade) have the same structure:

| Field | Unit | Meaning |
|---|---|---|
| `capex` | USD | Total investment |
| `npv` | USD | 10-year net present value at the base discount rate (7%) |
| `irr` | % | Internal rate of return |
| `payback` | years | Payback period |
| `workingCapital` | USD | Working capital released by lower inventory |
| `steady` | USD / year | Steady-state `gross` savings, `opex` (running costs) and `net` |
| `rows[]` | USD | One row per year: `year`, `gross`, `opex`, `capex`, `wc` (working capital released), `net` (cash flow) and `cumulative` |
| `scenarios[]` | | `key`, `label`, `detail` (assumptions), `npv` (USD), `irr` (%), `payback` (years) and `cumulative` (cumulative cash flow per year, USD) |

`sensitivity[]` belongs to the upstream step: for each assumption (`label`), the NPV in USD with that assumption at its low value (`low.label`, `low.npv`) and at its high value (`high.label`, `high.npv`).

## `stores[]`

| Field | Meaning |
|---|---|
| `key` | Store ID used everywhere in the twin (for example `S01`) |
| `name` | Display name |
| `size` | Sales relative to the part 2 StoreX store |
| `docks` | Number of receiving docks |

## `flows[]`

The flow plan for the long-haul product families (g3, seed 1):

| Field | Unit | Meaning |
|---|---|---|
| `key`, `label` | | Product family |
| `via` | `direct` / `dc` | Delivered direct to the store or through the DC |
| `palletsPerDay` | pallets / day | Volume |
| `loads` | truckloads | Full truckloads per order when delivered direct |
| `interval` | days | Average days between direct deliveries |
| `costDc` | USD / day | Daily cost through the DC |
| `costDirect` | USD / day | Daily cost delivered direct |
| `reason` | text | Why this choice |

## `twin`

The closed-loop twin study (one simulated day per seed and field level, averaged over `twin.seeds` seeds).

| Field | Meaning |
|---|---|
| `seeds` | Number of seeds |
| `arms[]` | The policies compared: `key`, `label`, `short`. Keys: `open` (no twin, the field copes on its own), `safe` (the twin executes only low-risk options; nobody approves the rest), `dispatcher` (low-risk options run automatically and a dispatcher approves the recommended option 10 minutes after the card appears), `auto` (everything runs automatically) |
| `levels[]` | `key` (`normal` an ordinary day, `rough` an eventful day), `label`, `arms`, `fidelity` |

`levels[].arms.<arm key>`, per day:

| Field | Unit | Meaning |
|---|---|---|
| `late` | minutes | Late store receiving |
| `hot` | minutes | Cold-chain over-temperature |
| `short` | minutes | Store stock-out (summed over product families) |
| `lost` | units | Lost sales |
| `cost` | USD | Cost of the twin's actions |
| `cards` | count | Recommendation cards raised |
| `auto` | count | Cards executed automatically |
| `user` | count | Cards approved by the dispatcher |
| `expired` | count | Cards nobody handled where the problem then happened |

`levels[].fidelity` (measured in the `open` arm): `eta30`, `eta60`, `eta120` are the mean errors in minutes of the twin's store-arrival predictions made 15–45 minutes, 45–90 minutes and 1.5–3 hours ahead; `temp` is the mean error of the cargo-temperature estimate in °C.

## Checking the file against the schema

The schema documents the structure and is strict about field names and types but not about the KPI list itself, so adding a KPI does not require a schema change. With the dependencies installed at the repository root, for example:

```bash
node -e "const Ajv=require('ajv/dist/2020').default;const ajv=new Ajv({allErrors:true,allowUnionTypes:true});const ok=ajv.validate(require('./docs/results/data.schema.json'),require('./docs/results/data.json'));console.log(ok||ajv.errors)"
```
