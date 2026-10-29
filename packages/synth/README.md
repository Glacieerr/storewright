# @storewright/synth

Synthetic data from a seed: a product catalog, order streams, a demand history with hidden factors, and training and evaluation records for the store AI. Nothing in it describes a real store or product.

由随机种子生成的合成数据：商品目录、订单流、带隐藏因素的需求历史，以及门店 AI 的训练和评测记录。里面没有任何真实门店或商品。

## What's inside · 主要内容

- `src/catalog.ts`: `generateCatalog` builds a catalog and places each item on a shelf run of its category; the same seed gives the same catalog. · 生成商品目录，并把每个商品放到所属类别的货架通道上；同一个种子得到同一个目录。
- `src/archetypes.ts`: product archetypes per category (size, weight, price, handling) that items are varied from. · 每个类别的商品原型（尺寸、重量、价格、处理方式），生成商品时在原型上加变化。
- `src/orders.ts`: `generateOrders` and the default demand scenario of each template (orders per day, hourly profile, pickup share, basket size). · 生成订单流，以及各模板默认的需求场景（日订单量、按小时分布、自取比例、篮子大小）。
- `src/history.ts`: a daily demand history. Factors the models can see (weekday, holidays, promotions, weather forecast) and factors they cannot (true weather, local events, trend, one structural shift). Only the AI uses it; the Phase 1 simulation does not. · 按天的需求历史。模型能看到的因素有星期、节假日、促销、天气预报；看不到的有真实天气、本地活动、趋势、一次结构性变化。只有 AI 用它，Phase 1 的仿真不用。
- `src/arrivals.ts`, `src/shelfTruth.ts`, `src/substitution.ts`, `src/pickRecords.ts`, `src/noShows.ts`, `src/deli.ts`, `src/returns.ts`: records for single models: arrival times, true shelf stock including phantom stock, substitution responses, pick times, pickup no-shows, deli prep times and return dispositions. · 各个模型的训练和评测记录：到店时间、货架真实存量（含幽灵库存）、替代品是否被接受、拣货用时、未取订单、熟食制作用时、退货去向。
- `src/history.test.ts`: tests for the demand history. · 需求历史的测试。

## Use · 用法

Run from the repo root. The package has no build step: the apps compile its TypeScript source with Vite or tsx. · 在仓库根目录运行。这个包没有构建步骤，由各个应用用 Vite 或 tsx 编译源码。

Run this package's tests. · 运行这个包的测试。

```bash
npx vitest run packages/synth
```

Rebuild the AI report, which trains and evaluates the models on this data (output in `experiments/results/`). · 重新生成 AI 效益报告：用这些数据训练和评测模型（输出到 `experiments/results/`）。

```bash
npm run ai-report
```

## Depends on · 依赖

- **Uses · 依赖：** `@storewright/domain`, `@storewright/store-config`
- **Used by · 使用它的模块：** `@storewright/sim-engine`, `@storewright/server`, `@storewright/simulator` (in its simulation worker), `@storewright/sim-cli`; the tests of `@storewright/ai`, `@storewright/algorithms` and `@storewright/ops` · 以及这三个包的测试

## Design docs · 设计文档

Most design docs are in Chinese; the [English overview](../../docs/en/overview.md#7-store-ai) summarizes them. · 设计文档以中文为主，英文概览是它们的摘要。

- [06 Phase 1 results](../../docs/06-phase1-results.md): catalog and order stream (§1), calibration (§2) · 商品目录与订单流（第 1 节）、校准（第 2 节）
- [10 Store AI](../../docs/10-store-ai.md): simulation as the evaluation field (§4) · 仿真就是评测场（第 4 节）
- [11 AI results](../../docs/11-ai-results.md): offline evaluation of the models (§2) · 模型的离线评估（第 2 节）
- [Decision 0010](../../docs/decisions/0010-roadmap-and-phase5-plan.md): the five AI principles (§2) · AI 的五条原则（第 2 节）
- [Decision 0011](../../docs/decisions/0011-phase6-plan.md): synthetic archetypes for the home-improvement store · 家居建材店的合成商品原型
- [Decision 0021](../../docs/decisions/0021-store-ai-batch1.md): synthetic pick records (§2) · 合成拣货记录（第 2 节）
- [Decision 0023](../../docs/decisions/0023-store-ai-batch3.md): no-show records (§3), substitution 2.0 (§5) · 未取订单记录（第 3 节）、替代推荐 2.0（第 5 节）
