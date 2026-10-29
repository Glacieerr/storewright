# @storewright/ai

The local-first store AI: recommendation records with reasons, metrics, rolling backtests, a model registry with promotion gates, and the models themselves. Plain TypeScript; its source imports no other package.

本地优先的门店 AI：带理由的建议记录、评估指标、滚动回测、带上线门槛的模型仓库，以及各个模型。纯 TypeScript，源码不引用其他包。

## What's inside · 主要内容

- `src/recommendation.ts`: the recommendation record (action, confidence, factor-coded reasons, alternatives, model version, then the staff response and outcome) and the SHOW, CONFIRM and AUTO modes. · 建议记录：动作、置信度、按因素代码保存的理由、备选方案、模型版本，之后是员工的处理和实际结果；以及只显示、需确认、自动执行三种模式。
- `src/metrics.ts`, `src/backtest.ts`: MAE, RMSE, WAPE, quantile loss, Brier score, log loss and calibration error; rolling-origin backtests. · 评估指标（MAE、RMSE、WAPE、分位数损失、Brier 分数、对数损失、校准误差）和滚动起点回测。
- `src/registry.ts`: model versions per family. A candidate goes live only if it beats the current version by a set margin and its guardrail metrics do not get worse; rollback restores the previous version. · 每个模型族的版本。候选版本要比当前版本好出规定的幅度、护栏指标不变差，才能上线；回滚恢复上一个版本。
- `src/forecast.ts`, `src/series.ts`: hourly series and the baseline forecasters (same hour last week, mean of recent weeks, seasonal exponential smoothing) with intervals. · 按小时的时间序列和基线预测器（上周同时段、近几周同时段平均、按星期的指数平滑），附预测区间。
- `src/glm.ts`: small Poisson and logistic regression (IRLS with L2), no dependencies. · 小型泊松回归和逻辑回归（IRLS 加 L2 正则），没有依赖。
- Models · 模型：`demand.ts` (hourly demand), `eta.ts` (arrival-time correction), `availability.ts` (shelf availability, phantom stock), `countRisk.ts`, `substitution.ts`, `staffing.ts` (staffing plans, live dispatch), `schedule.ts` (weekly schedules with hard rules), `modules.ts` (deli prep, returns, oversized loads), `pickTime.ts`, `shelfFusion.ts`, `noShow.ts`, `capacity.ts`, `expiry.ts`, `recall.ts`, `attributes.ts`, `voice.ts` · 订单量、到店时间修正、可售概率与幽灵库存、按风险盘点、替代推荐、排班建议与实时调度、一周排班、扩展模块、拣货时长、多源货架真相、未取订单、时段产能、临期、召回、商品属性、语音命令
- `src/ai.test.ts`, `src/store-ai.test.ts`: tests. · 测试。

## Use · 用法

Run from the repo root. The package has no build step: the apps compile its TypeScript source with Vite or tsx. · 在仓库根目录运行。这个包没有构建步骤，由各个应用用 Vite 或 tsx 编译源码。

Run this package's tests. · 运行这个包的测试。

```bash
npx vitest run packages/ai
```

Generate the AI benefit report: offline evaluation, AI on and off, trade-off curve, sensitivity (output in `experiments/results/`). · 生成 AI 效益报告：离线评估、AI 开和关的对比、取舍曲线、敏感性分析（输出到 `experiments/results/`）。

```bash
npm run ai-report
```

## Depends on · 依赖

- **Uses · 依赖：** no other package in its source. `package.json` lists `@storewright/domain`; only the tests import it, together with `@storewright/store-config` and `@storewright/synth`. · 源码不依赖其他包。`package.json` 里列了 `@storewright/domain`，只有测试用到它，还有 `@storewright/store-config` 和 `@storewright/synth`。
- **Used by · 使用它的模块：** `@storewright/ops`, `@storewright/sim-engine`, `@storewright/server` (the store AI service), `@storewright/associate`, `@storewright/simulator`, `@storewright/sim-cli`

## Design docs · 设计文档

Most design docs are in Chinese; the [English overview](../../docs/en/overview.md#7-store-ai) summarizes them. · 设计文档以中文为主，英文概览是它们的摘要。

- [10 Store AI](../../docs/10-store-ai.md): local-first design, recommendation records, backtests and promotion gates, models, ethics · 本地优先的设计、建议记录、回测与上线门槛、模型、伦理边界
- [11 AI results & model cards](../../docs/11-ai-results.md) · AI 效益报告与模型卡片
- [15 Store AI roadmap](../../docs/15-store-ai-roadmap.md): the second round, from single predictions to a closed loop · 第二轮：从单个预测走向闭环
- [Decision 0010](../../docs/decisions/0010-roadmap-and-phase5-plan.md): Phase 5 plan and the five AI principles (§2) · Phase 5 计划和 AI 的五条原则（第 2 节）
- Decisions [0021](../../docs/decisions/0021-store-ai-batch1.md), [0022](../../docs/decisions/0022-store-ai-batch2.md), [0023](../../docs/decisions/0023-store-ai-batch3.md), [0024](../../docs/decisions/0024-store-ai-batch4.md): the four batches of the second round · 第二轮的四批
