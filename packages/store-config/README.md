# @storewright/store-config

The store configuration: a zod schema, templates and a generator, the walk graph derived from the layout, areas and dock doors, layout editing and validation.

门店配置：zod schema、模板与生成器、由布局推导的行走网络、区域与卸货门、布局编辑和校验。

## What's inside · 主要内容

- `src/schema.ts`: `StoreConfigSchema`. A store is one JSON document: layout (floors, shelf runs, corridors, floor connectors), staging racks, categories, equipment, rules, facilities, outdoor and backroom settings, areas, docks, pickup bays and module switches. · 一家店是一份 JSON：布局（楼层、货架通道、走廊、楼层连接）、暂存货架、商品类别、设备、规则、附属设施、室外和后仓设置、区域、卸货门、取货车位、模块开关。
- `src/model.ts`: `StoreModel`, derived from a config: the walk graph (nodes along runs and corridors, cross-floor edges for lifts and stairs), shelf locations, staging slots and shortest distances. · 由配置推导的门店模型：行走网络（通道和走廊上的节点，电梯和楼梯跨楼层连边）、货位、暂存格位、最短距离。
- `src/templates.ts`: the templates `small`, `medium` (default), `large` and `hardware` (a home-improvement store), default categories and size rules, and `generateStoreConfig` for stores built from generator parameters. · 模板：小型、中型（默认）、大型和家居建材店；默认商品类别和大件规则；`generateStoreConfig` 按生成参数建店。
- `src/areas.ts`: receiving, backroom storage and staging areas with capacity, dock doors and yard settings, default areas and area edits. `goLiveCheck` checks whether a store can open: config issues, required areas, cold storage, staging and pickup-bay capacity, docks, pallet space. · 收货、后仓存储、暂存区域及容量，卸货门和卸货场设置，默认区域和区域编辑。`goLiveCheck` 检查门店能不能开业：配置问题、必需的区域、冷链存储、暂存格位和取货车位、卸货门、托盘位。
- `src/backroom.ts`: backroom rack layout and forklift routes, and the second-floor unloading and restock area of two-floor stores. · 后仓货架布局和叉车路线，以及两层门店二楼的卸货区和补货区。
- `src/editing.ts`: geometry for the layout editor: draw, rotate, move, paste and distribute shelf runs, with their ends snapped to nearby walkable segments. · 布局编辑的几何操作：画、旋转、移动、粘贴、等距排列货架通道，两端吸附到附近的行走线段上。
- `src/validate.ts`: `validateStoreConfig` checks structure (zod), then meaning (unique IDs, categories and floors exist, every location reachable from staging). It is also the separate entry `@storewright/store-config/validate`, so the in-browser hub can load it on demand. · 先做结构校验（zod），再做语义校验（ID 唯一、类别和楼层存在、所有货位都能从暂存点走到）。它也是单独的入口 `@storewright/store-config/validate`，浏览器里的中枢可以按需加载。
- `src/store-config.test.ts`: templates, generator, floor connectors, backroom, layout editing, areas and the go-live check. · 测试：模板、生成器、楼层连接、后仓、布局编辑、区域、开业检查。

## Use · 用法

Run from the repo root. The package has no build step: the apps compile its TypeScript source with Vite or tsx. · 在仓库根目录运行。这个包没有构建步骤，由各个应用用 Vite 或 tsx 编译源码。

Run this package's tests. · 运行这个包的测试。

```bash
npx vitest run packages/store-config
```

Type-check the whole repo. · 检查整个仓库的类型。

```bash
npm run typecheck
```

## Depends on · 依赖

- **Uses · 依赖：** `@storewright/domain`; third-party `zod`
- **Used by · 使用它的模块：** `@storewright/synth`, `@storewright/algorithms`, `@storewright/ops`, `@storewright/sim-engine`, `@storewright/simulator`, `@storewright/server`, `@storewright/sim-cli`; the tests of `@storewright/ai` · 以及 `@storewright/ai` 的测试

## Design docs · 设计文档

Most design docs are in Chinese; the [English overview](../../docs/en/overview.md#4-planning-twin-simulator) summarizes them. · 设计文档以中文为主，英文概览是它们的摘要。

- [04 Tech stack](../../docs/04-tech-stack.md): customization architecture (§4) · 定制化架构（第 4 节）
- [07 Simulator](../../docs/07-simulator.md): store customization (§5) · 门店定制（第 5 节）
- [12 Business modules](../../docs/12-business-modules.md): the home-improvement template (§4) · 家居建材模板（第 4 节）
- [Decision 0006](../../docs/decisions/0006-simulator-v4.md): layout-editing geometry moves into store-config (§3) · 布局编辑的几何操作放进 store-config（第 3 节）
- [Decision 0011](../../docs/decisions/0011-phase6-plan.md): the second industry template (§4) · 第二个行业模板（第 4 节）
- [Decision 0013](../../docs/decisions/0013-phase8-plan.md): areas (§4) and pickup bays (§5) · 区域（第 4 节）和取货车位（第 5 节）
- [Decision 0015](../../docs/decisions/0015-v1-release.md): validation split into its own entry for a lighter demo (§2) · 校验拆成单独的入口，演示更轻（第 2 节）
- [Decision 0019](../../docs/decisions/0019-yard-access-deliveries-harbor.md): dock doors, truck yard, two floors and the online-order area · 卸货门、卸货场、二楼和线上订单区
