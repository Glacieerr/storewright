# @storewright/sim-cli

Command-line experiments and reports: simulate one day, compare policies with common random numbers, run a sensitivity analysis, and generate the AI and industry reports.

命令行实验与报告：仿真一天、用公共随机数对比策略、做敏感性分析，生成 AI 效益报告和行业迁移报告。

## What's inside · 主要内容

- `src/main.ts`: argument parsing and the commands `run`, `compare`, `sensitivity`, `ai-report` and `industry-report`; any other command prints the help. · 参数解析和五个命令；其他命令打印帮助。
- `src/report.ts`: Markdown for one day's metrics, policy comparisons (means, 95% confidence intervals, paired differences) and sensitivity tables. · 生成 Markdown：一天的指标、策略对比（均值、95% 置信区间、配对差值）、敏感性表格。
- `src/aiReport.ts`: the AI benefit report: offline evaluation of five model families, AI on and off in operations, the arrival-time trade-off curve, sensitivity. · AI 效益报告：五个模型族的离线评估、运营上的 AI 开和关、到店时间的取舍曲线、敏感性分析。
- `src/industryReport.ts`: the mid-size grocery store and the home-improvement store compared on the same core. · 同一套核心上的中型超市和家居建材店对比。

## Use · 用法

Run from the repo root; the app has no scripts of its own. Templates are `small`, `medium`, `large` and `hardware`. Reports go to `experiments/results/` unless `--out` says otherwise. · 在仓库根目录运行，这个应用没有自己的脚本。模板有 `small`、`medium`、`large`、`hardware`。报告默认写入 `experiments/results/`，可以用 `--out` 改。

Simulate one day and print the metrics (`--events file.json` exports the event log). · 仿真一天并打印指标（`--events 文件.json` 导出事件日志）。

```bash
npm run sim -- --template medium --policy optimized --seed 42
```

Compare the baseline with the optimized policy, with the efficiency profile and the ablation. · 对比基线和优化策略，加上效率优先档位和消融实验。

```bash
npm run compare -- --template medium --reps 30 --profiles --ablation
```

Sensitivity analysis, the AI report and the industry report. · 敏感性分析、AI 效益报告、行业迁移报告。

```bash
npm run sensitivity
```

```bash
npm run ai-report
```

```bash
npm run industry-report
```

There are no unit tests in this app; CI runs a short comparison. · 这个应用没有单元测试；持续集成会跑一次简短的对比。

## Depends on · 依赖

- **Uses · 依赖：** `@storewright/sim-engine`, `@storewright/store-config`, `@storewright/synth`, `@storewright/algorithms`, `@storewright/ai`, `@storewright/domain`
- **Used by · 使用它的地方：** the root scripts `sim`, `compare`, `sensitivity`, `ai-report` and `industry-report`; `.github/workflows/ci.yml` runs `compare` with 5 repetitions. · 根目录的这五个脚本；持续集成用 5 次重复跑 `compare`。

## Design docs · 设计文档

Most design docs are in Chinese; the [English overview](../../docs/en/overview.md#10-results) summarizes them. · 设计文档以中文为主，英文概览是它们的摘要。

- [05 Evaluation & roadmap](../../docs/05-evaluation-and-roadmap.md): how the gains are measured (part 1) · 怎样衡量效益（第一部分）
- [06 Phase 1 results](../../docs/06-phase1-results.md): calibration, main results, ablation, sensitivity · 校准、主要结果、消融、敏感性
- [11 AI results & model cards](../../docs/11-ai-results.md): the output of `ai-report` · `ai-report` 的结果
- [12 Business modules](../../docs/12-business-modules.md): the second industry (§4), the output of `industry-report` · 第二个行业（第 4 节），`industry-report` 的结果
- [Saved reports](../../docs/results/): comparisons for the small, medium and large stores, sensitivity for the medium store · 小型、中型、大型店的对比报告，中型店的敏感性报告
- Decisions [0002](../../docs/decisions/0002-phase1-engineering.md) (Phase 1 engineering), [0010](../../docs/decisions/0010-roadmap-and-phase5-plan.md) (AI report, §13), [0011](../../docs/decisions/0011-phase6-plan.md) (industry report, §6) · 决策记录：Phase 1 工程决策、AI 报告（第 13 节）、行业报告（第 6 节）
