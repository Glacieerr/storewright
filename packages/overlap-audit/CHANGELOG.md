# Changelog · 变更记录

All notable changes to `@storewright/overlap-audit` are recorded here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - Unreleased (date set at the first release · 首次发布时填写日期)

### Added · 新增

- First release as a standalone library, extracted from StoreX Chain's overlap audit (`StoreX-Chain/scripts/overlaps.mjs`, `npm run overlaps`), which now uses it. 从 StoreX 全链路的重叠审计拆出来的第一个独立版本，审计脚本改用它。
- Footprints as quads or oriented boxes; separating-axis tests with an option for touching rectangles; `hitched` for tractor–trailer pairs. 车身矩形、分离轴检验、牵引车和挂车判断。
- Exact uniform-grid broad phase; pair-seconds tally by area, pair and static / moving; skip, ignore, area, pair and trace hooks; a still tracker. 精确的网格粗筛、「车对 × 秒」统计和钩子。
- Limits with a regression gate and a text / JSON report. 上限和报告。
- A JSON trajectory format and a CLI (exit code 1 over a limit, 2 on bad input) for trajectories from any engine. JSON 轨迹格式和命令行。
