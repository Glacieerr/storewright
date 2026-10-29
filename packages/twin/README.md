# @storewright/twin

The digital twin layer: a sensor registry derived from the store, telemetry, alert rules and their impact on operations, replay, a forecast from the live state, operations foresight, predictive maintenance, twin health and the closing review.

数字孪生层：由门店推导的传感器清单、遥测、告警规则及其对作业的影响、回放、从实时状态出发的推演、运营预警、预测性维护、孪生健康度和打烊复盘。

## What's inside · 主要内容

- `src/registry.ts`: sensors derived from the store data (walk-in cooler and freezer, staging coolers and freezers, hot holding, dock doors, entrance count) and temperature limits. The hub and the viewers compute the same list, so pushes carry only readings. · 由门店数据推导的传感器（冷藏库、冷冻库、暂存冷藏冷冻柜、熟食保温区、卸货门、入口客流）和温度线。中枢和查看端算出同一份清单，所以推送里只传读数。
- `src/telemetry.ts`: `TelemetryStore` keeps the latest reading, 60 minutes of raw readings and minute buckets (24 hours by default), outside the operations event log. · 保存最新读数、最近 60 分钟的原始读数和按分钟汇总的序列（默认 24 小时），不进作业事件流。
- `src/rules.ts`: `RuleEngine` raises and clears alerts: temperature over the limit for a while or past a critical line, a dock door open with no receiving, a silent sensor. `DEFAULT_RULES` and the shorter `DEMO_RULES`. · 发出和解除告警：温度越线持续一段时间或越过严重线、卸货门开着又没有收货、传感器没有读数。有 `DEFAULT_RULES` 和时间更短的 `DEMO_RULES`。
- `src/impact.ts`: an alert's impact: staged totes and their orders, free slots in the same zone to move them to, cases in a cold room. · 告警的影响：暂存的框和它们的订单、同温区可以转移过去的空格位、冷库里的箱子。
- `src/replay.ts`: `ReplayLog` rebuilds the store at any moment from the nearest checkpoint plus the events after it. · 从最近的检查点加之后的事件，重建任意时刻的门店。
- `src/forecast.ts`: a queue projection of picking, staging and handoff from the current state, 3 hours ahead in 5-minute steps by default, calibrated on today's work. · 从当前状态出发的排队推演（拣货、暂存、交付），默认看 3 小时、每 5 分钟一步，用今天的实际数据校准。
- `src/foresight.ts`: finds coming problems in the forecast, tries fixes such as moving someone or starting orders early, and scores them. · 在推演里找快要出现的问题，试几种处置办法（例如调一个人、提前开始订单）并打分。
- `src/degradation.ts`: predictive maintenance from robust temperature trends (Theil–Sen), door recovery and stuck readings. · 预测性维护：底线温度的稳健趋势（Theil–Sen）、开门回温、读数卡住。
- `src/health.ts`: twin health: sync, data freshness, sensor states, record accuracy, model status. · 孪生健康度：同步、数据新鲜度、传感器状态、账实一致、模型状况。
- `src/review.ts`: the closing review splits late orders into demand, staffing and pace with Shapley values. · 打烊复盘：用 Shapley 值把迟到订单分到单量、人手、拣货快慢几个原因上。
- `src/protocol.ts`: message types between the hub and twin viewers; `src/twin.test.ts`: tests. · 中枢和孪生查看端之间的消息类型；测试。

## Use · 用法

Run from the repo root. The package has no build step: the apps compile its TypeScript source with Vite or tsx. · 在仓库根目录运行。这个包没有构建步骤，由各个应用用 Vite 或 tsx 编译源码。

Run this package's tests. · 运行这个包的测试。

```bash
npx vitest run packages/twin
```

To see the twin in the browser, build and serve the demo site, then open http://127.0.0.1:4177/. · 想在浏览器里看孪生，先构建并启动演示站点，再打开 http://127.0.0.1:4177/ 。

```bash
npm run build:site
```

```bash
npm run demo:site
```

## Depends on · 依赖

- **Uses · 依赖：** `@storewright/domain`, `@storewright/ops`
- **Used by · 使用它的模块：** `@storewright/server` (`src/twin.ts`, the twin service), `@storewright/associate` (equipment and alerts in `TwinCard.tsx`), `@storewright/simulator` (`src/live/twin.ts`, the twin panel and timeline)

## Design docs · 设计文档

Most design docs are in Chinese; the [English overview](../../docs/en/overview.md#1b-digital-twin) summarizes them. · 设计文档以中文为主，英文概览是它们的摘要。

- [14 Digital twin](../../docs/14-digital-twin.md): levels, layers, telemetry and alerts, replay, forecast, twin health, interfaces · 分级、四层结构、遥测与告警、回放、推演、孪生健康度、接口
- [Decision 0016](../../docs/decisions/0016-digital-twin.md): telemetry and alerts (§4.1), replay (§4.2), forecast (§4.3), twin health (§4.4) · 遥测与告警（4.1）、回放（4.2）、推演（4.3）、孪生健康度（4.4）
- [Decision 0021](../../docs/decisions/0021-store-ai-batch1.md): the forecast uses AI (§3), operations foresight (§4) · 推演接上 AI（第 3 节）、运营预警（第 4 节）
- [Decision 0022](../../docs/decisions/0022-store-ai-batch2.md): predictive maintenance (§3), model monitoring (§6) · 预测性维护（第 3 节）、运行监控（第 6 节）
- [Decision 0024](../../docs/decisions/0024-store-ai-batch4.md): closing review and counterfactual attribution (§3) · 打烊复盘与反事实归因（第 3 节）
