# @storewright/algorithms

Planning algorithms shared by the live operations core and the simulation engine: tote assignment, pick-walk partitioning, routing, cold-chain limits, staging slots, trips, replenishment, backroom bins and planogram, and checkout queues.

作业核心和仿真引擎共用的规划算法：分框、拣货分批、路线、冷链时限、暂存格位、配送行程、补货、后仓库位与陈列表、收银排队。

## What's inside · 主要内容

- `src/totes.ts`: `assignTotes` fills totes in one pass per order: segments by temperature zone, fulfilment type and chemicals, heavy items at the bottom and fragile on top, weight and volume limits, one order per tote. `assignTotesByEye` is the baseline; `classifyLine` applies the store's size rules. · 分框：每单一次完成。按温区、履约类型、化学品分段，重的在下、易碎的在上，重量和体积有上限，一个框只属于一个订单。`assignTotesByEye` 是基线，`classifyLine` 按门店的大件规则分类。
- `src/batching.ts`: `planPickWalks` partitions totes into pick walks in one global pass by aisle overlap, within cart capacity and the cold-chain limit (`coldChainLimitSec`). · 按通道重合度把框一次性划分成拣货批次，受推车容量和冷链时限（`coldChainLimitSec`）约束。
- `src/routing.ts`: `routeTsp` (nearest neighbour plus 2-opt on the walk graph, deterministic) and `routeSShape`, the baseline route. · `routeTsp`（在行走网络上用最近邻加 2-opt，结果确定）和基线用的 S 形路线 `routeSShape`。
- `src/staging.ts`: staging-slot occupancy and `suggestSlot` by temperature zone, purpose and pickup or delivery area. · 暂存格位的占用，按温区、用途、自取或配送区建议格位（`suggestSlot`）。
- `src/trips.ts`: `composeTrips` groups staged delivery orders into trips by direction from the store, within order and vehicle limits, and assigns positions in the vehicle. · 把已暂存的配送订单按相对门店的方位组成行程，不超过每趟单数和车辆容量，并分配车内位置。
- `src/replenish.ts` (entry `@storewright/algorithms/replenish`): sell-out time, replenishment trigger and priority, stockout risk, batching tasks by area, ABC classes and count intervals, bin checks for put-away. · 预计售罄时间、补货触发和优先级、断货风险、按区域合并任务、ABC 分类和盘点周期、上架库位检查。
- `src/planogram.ts` (entry `@storewright/algorithms/planogram`): backroom bins, planogram and opening inventory, the same for the same store, catalog and seed. · 后仓库位、陈列表和期初库存；门店、商品目录和种子相同，结果就相同。
- `src/queue.ts`: M/M/c (Erlang C) waiting time and the number of checkout lanes needed. · M/M/c（Erlang C）排队等待时间和需要开几条收银通道。
- `src/context.ts`: the planning context and standard pick times; walk estimates read no weights or volumes (EC-1). · 规划上下文和拣货标准工时；估算批次用时不读重量和体积（EC-1）。
- `src/algorithms.test.ts`: unit and property tests (fast-check). · 单元测试和属性测试（fast-check）。

## Use · 用法

Run from the repo root. The package has no build step: the apps compile its TypeScript source with Vite or tsx. · 在仓库根目录运行。这个包没有构建步骤，由各个应用用 Vite 或 tsx 编译源码。

Run this package's tests. · 运行这个包的测试。

```bash
npx vitest run packages/algorithms
```

Compare the baseline with the optimized policy, which uses these algorithms (report in `experiments/results/`). · 对比基线和使用这些算法的优化策略（报告写入 `experiments/results/`）。

```bash
npm run compare -- --template medium --reps 30 --ablation
```

## Depends on · 依赖

- **Uses · 依赖：** `@storewright/domain`, `@storewright/store-config`
- **Used by · 使用它的模块：** `@storewright/ops`, `@storewright/sim-engine`, `@storewright/server`, `@storewright/simulator`, `@storewright/sim-cli`; `@storewright/associate` imports only `/replenish` · `@storewright/associate` 只用 `/replenish`

## Design docs · 设计文档

Most design docs are in Chinese; the [English overview](../../docs/en/overview.md#2-workflow) summarizes them. · 设计文档以中文为主，英文概览是它们的摘要。

- [01 Workflow design](../../docs/01-workflow-design.md): main flow (§3), engineering constraints EC-1 to EC-10 (§4.14) · 端到端主流程（第 3 节）、工程约束 EC-1 至 EC-10（4.14 节）
- [Pseudocode 01: tote assignment](../../docs/pseudocode/01-tote-assignment.md) and [02: pick walks and routing](../../docs/pseudocode/02-pick-walk-partition.md) · 伪代码：分箱；分批与路线
- [06 Phase 1 results](../../docs/06-phase1-results.md): main results and ablation (§3, §4) · 主要结果和消融实验（第 3、4 节）
- [09 Backroom & replenishment](../../docs/09-backroom-replenishment.md) · 后仓库存与补货
- [Decision 0002](../../docs/decisions/0002-phase1-engineering.md): batching by order, one partition per cart count (§3, §4) · 分批单位按订单，对每个推车数分别求解（第 3、4 节）
- [Decision 0009](../../docs/decisions/0009-phase4-plan.md): replenishment rules and the planogram move into this package · 补货规则、陈列表放进这个包
