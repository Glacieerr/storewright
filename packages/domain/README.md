# @storewright/domain

Domain types, the domain event log, a declarative rule engine and deterministic random numbers, shared by the other packages and the apps.

领域类型、领域事件日志、声明式规则引擎和确定性随机数，其他包和各个应用都用它。

## What's inside · 主要内容

- `src/types.ts`: core types such as temperature zone, handling, item, order, tote assignment, pick walk and trip. Lengths are in cm or m, weights in kg, simulation time in seconds. · 核心类型：温区、处理方式、商品、订单、分框、拣货批次、配送行程等。长度用厘米或米，重量用千克，仿真时间用秒。
- `src/events.ts`: domain event payloads and `EventLog`, an append-only log that listeners can subscribe to. · 领域事件的负载类型，以及只追加写入、可以订阅的 `EventLog`。
- `src/rules.ts`: rules written as JSON and evaluated in order; the first match wins (`firstMatch`). · 用 JSON 写的规则，按顺序求值，返回第一条命中的结果（`firstMatch`）。
- `src/rng.ts`: `createRng` (sequential, sfc32) and `keyedUniform`, which always returns the same number for the same seed, stream and key; common random number experiments rely on it. · `createRng`（顺序生成，sfc32）和 `keyedUniform`：种子、流名和键相同，结果就相同，公共随机数实验靠它。
- `src/labels.ts`: customer name format for labels, short codes and opaque label IDs (`SW1:` plus a check character). · 标签上的顾客姓名格式、短码、不透明标签 ID（`SW1:` 开头，带校验字符）。
- `src/inventory.ts`: internal case IDs, GTIN-14 and UPC-A helpers, building and parsing GS1 Digital Links. · 内部箱号、GTIN-14 和 UPC-A 工具、GS1 Digital Link 的生成与解析。
- `src/gs1.ts`: parses GS1 data (GTIN, lot, expiry, count, serial, order number) and delivery-note QR codes. · 解析 GS1 数据（商品条码、批号、保质期、数量、序列号、订单号）和送货单二维码。
- `src/units.ts`: unit conversion and clock formatting. · 单位换算和时钟格式。
- `src/domain.test.ts`: unit and property tests (fast-check). · 单元测试和属性测试（fast-check）。

## Use · 用法

Run from the repo root. The package has no build step: `package.json` exports `src/index.ts`, and the apps compile it with Vite or tsx. · 在仓库根目录运行。这个包没有构建步骤：`package.json` 直接导出 `src/index.ts`，由各个应用用 Vite 或 tsx 编译。

Run this package's tests. · 运行这个包的测试。

```bash
npx vitest run packages/domain
```

Type-check the whole repo. · 检查整个仓库的类型。

```bash
npm run typecheck
```

## Depends on · 依赖

- **Uses · 依赖：** no other package and no third-party runtime dependency. · 不依赖其他包，也没有第三方运行时依赖。
- **Used by · 使用它的模块：** `@storewright/store-config`, `@storewright/synth`, `@storewright/algorithms`, `@storewright/labels`, `@storewright/ops`, `@storewright/sim-engine`, `@storewright/twin`, `@storewright/simulator`, `@storewright/associate`, `@storewright/server`, `@storewright/sim-cli`
- `@storewright/ai` lists it in `package.json`, but only the ai tests import it. · `@storewright/ai` 在 `package.json` 里列了它，只有 ai 的测试用到。

## Design docs · 设计文档

Most design docs are in Chinese; the [English overview](../../docs/en/overview.md#2-workflow) summarizes them. · 设计文档以中文为主，英文概览是它们的摘要。

- [01 Workflow design](../../docs/01-workflow-design.md): domain model (§2), event list (§6) · 领域模型（第 2 节）、事件清单（第 6 节）
- [06 Phase 1 results](../../docs/06-phase1-results.md): what the Phase 1 packages contain (§1) · Phase 1 各个包的内容（第 1 节）
- [Decision 0001](../../docs/decisions/0001-phase0-decisions.md): Phase 0 decisions, including the label name format · Phase 0 决议，含标签上的姓名格式
- [Decision 0002](../../docs/decisions/0002-phase1-engineering.md): Phase 1 engineering; the event log is written in time order (§7) · Phase 1 工程决策；事件日志按时间顺序写入（第 7 节）
- [Decision 0024](../../docs/decisions/0024-store-ai-batch4.md): GS1 codes on cases and delivery notes (§9) · 箱上和送货单上的 GS1 码（第 9 节）
