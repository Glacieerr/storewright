# @storewright/sim-engine

A deterministic discrete-event simulation of a store day, with policies and common-random-number experiments, plus the parts the planning twin needs: deliveries and the truck yard, traffic, incidents, shelf stock, student part-timers and AI operations advice.

确定性的门店一天离散事件仿真，带策略和公共随机数实验，以及规划孪生要用的部分：到货与卸货场、道路拥堵、突发状况、货架存量、学生兼职工和 AI 运营建议。

## What's inside · 主要内容

- `src/kernel.ts`: an event queue ordered by time and sequence number, so every run can be reproduced exactly. · 事件队列按时间和序号执行，每次运行都能精确复现。
- `src/day.ts`: `simulateDay` runs orders, pickers, stagers, handoff staff, customers and drivers through one day and returns metrics, events and optional staff traces. · 仿真一天：订单、拣货员、暂存员、交付员、顾客和司机；输出指标、事件和可选的员工轨迹。
- `src/scenario.ts`: policies (`BASELINE`, `OPTIMIZED`, `EFFICIENCY`, ablation and AI ablation sets) and scenario parameters. · 策略（基线、优化、效率优先，以及消融和 AI 消融组合）和场景参数。
- `src/experiment.ts`, `src/stats.ts`: `runExperiment` gives every policy the same orders and random events, then reports means, 95% confidence intervals and paired differences. · 公共随机数实验：所有策略面对同一份订单和同一组随机事件，报告均值、95% 置信区间和配对差值。
- `src/inbound.ts`, `src/deliveries.ts`: deliveries by weekday, season and store size; receiving, put-away, night restocking, the truck yard and forklifts. · 按星期、季节和门店规模安排的到货；收货、上架、夜班补货、卸货场和叉车。
- `src/traffic.ts`, `src/incidents.ts`: road congestion, school rush hours and a rail crossing; small incidents and larger disruptions such as a fire alarm or a power cut. · 道路拥堵、上学放学高峰和铁路道口；小状况和火警、停电这样的大事件。
- `src/shelfStock.ts`: an optional shelf-stock module (off by default) where availability follows stock. · 可选的货架存量模块（默认关闭），货架上有没有货由存量决定。
- `src/autoService.ts`, `src/pharmacy.ts`, `src/students.ts`: the auto service center and pharmacy counter queues, and hour rules for student part-timers. · 汽车快修中心和药房柜台的排队，以及学生兼职工的工时规则。
- `src/economics.ts`: a rough daily P&L, only for comparing scenarios. · 粗略的日经营账，只用来比较方案。
- `src/advisor/`: AI advice for the planning twin (inbound, backroom, staging, front of store, risks). It checks other seeds to see whether a problem recurs and re-runs the day with each fix to estimate its effect. · 规划孪生的 AI 建议（到货、后仓、暂存、前场、风险）：换几个种子看问题会不会反复出现，把建议应用后重跑一天，估计效果。
- `src/sim-engine.test.ts`: tests. · 测试。

## Use · 用法

Run from the repo root. The package has no build step: the apps compile its TypeScript source with Vite or tsx. · 在仓库根目录运行。这个包没有构建步骤，由各个应用用 Vite 或 tsx 编译源码。

Run this package's tests. · 运行这个包的测试。

```bash
npx vitest run packages/sim-engine
```

Simulate one day from the command line and print the metrics. · 在命令行仿真一天，打印指标。

```bash
npm run sim
```

## Depends on · 依赖

- **Uses · 依赖：** `@storewright/domain`, `@storewright/store-config`, `@storewright/synth`, `@storewright/algorithms`, `@storewright/ai`
- **Used by · 使用它的模块：** `@storewright/simulator` (its simulation worker), `@storewright/sim-cli`, `@storewright/server` (the assistant's what-if tool) · 模拟器的仿真 Worker、命令行、门店助手的「如果……会怎样」工具

## Design docs · 设计文档

Most design docs are in Chinese; the [English overview](../../docs/en/overview.md#4-planning-twin-simulator) summarizes them. · 设计文档以中文为主，英文概览是它们的摘要。

- [07 Simulator](../../docs/07-simulator.md): external factors in the simulation (§3), performance (§4) · 仿真中的外部因素（第 3 节）、性能（第 4 节）
- [06 Phase 1 results](../../docs/06-phase1-results.md) · Phase 1 成果
- [05 Evaluation & roadmap](../../docs/05-evaluation-and-roadmap.md): how the gains are measured (part 1) · 怎样衡量效益（第一部分）
- [Pseudocode 03: one simulated day](../../docs/pseudocode/03-simulation-day.md) · 伪代码：一天的门店作业仿真
- [Decision 0002](../../docs/decisions/0002-phase1-engineering.md): Phase 1 engineering · Phase 1 工程决策
- [Decision 0006](../../docs/decisions/0006-simulator-v4.md): deliveries and storage replace the night-restock module (§1) · 到货与仓储取代夜班补货模块（第 1 节）
- Decisions [0018](../../docs/decisions/0018-vehicles-and-yard.md) (vehicles, yard, forklifts), [0019](../../docs/decisions/0019-yard-access-deliveries-harbor.md) (yard access, delivery schedule), [0020](../../docs/decisions/0020-students-boats-ai-advice.md) (student part-timers, AI advice) · 决策记录：车辆、卸货场和叉车；进场道路和到货排班；学生兼职工和 AI 建议
