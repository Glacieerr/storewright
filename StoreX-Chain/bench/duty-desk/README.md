# 值班台基准数据集（Duty-Desk Bench）

[English](README.en.md) · 方法、排行榜和答错的每一题：[docs/benchmark.md](../../docs/benchmark.md)

320 道问供应链运营值班助手的中文题，分四套、每套 80 题，每题有期望的意图、主工具、回答形态和提问人的角色；另外有外部系统在同一个仿真时刻作答所需要的全部数据。数据是合成的，来自个人开源作品集项目；本项目与任何零售商、企业无隶属关系。

## 文件

| 路径 | 内容 |
|---|---|
| `data/blind1.jsonl` … `data/blind4.jsonl` | 四套题（B01–B80、C01–C80、D01–D80、E01–E80），一行一题。格式：`schema/item.schema.json`。 |
| `data/dev.jsonl` | 开发时用的 176 道标准问题（只作参考：事实一项是代码里的检查，而且用了好几个时刻）。 |
| `schema/item.schema.json` | 题目的 JSON Schema。 |
| `schema/prediction.schema.json` | 预测文件每一行的 JSON Schema。 |
| `context/tools.json` | 值班助手能调用的 31 个工具：名字、说明、JSON Schema 参数、种类（`read` 只读、`compute` 计算、`proposal` 提议）。 |
| `context/snapshot.json` | 常用只读工具在评测时刻的结果（中文的文字 + 结构化数据）。 |
| `examples/builtin.predictions.jsonl` | 内置助手自己的预测，按提交格式写（评它的分和内置那一行完全一样）。 |
| `results/*.json` | 每个系统的评分结果（每套、每项、每题）。 |
| `site/index.html` | 中英双语的静态结果页，按 `results/` 生成。 |

在 `StoreX-Chain/` 目录运行 `npm run bench -- export`（题目、schema、评测时刻的数据、示例）和 `npm run bench -- run --all` / `report`（结果、网页）重新生成。

## 一道题

```json
{"set":"blind4","id":"E03","question":"M3现在跑哪了","role":"dispatcher","pair":"S1",
 "expect":{"intent":"vehicle","tools":["get_vehicle"],"behavior":"answer"},"note":"M3 = M03."}
```

- `role`：viewer（只读）、dispatcher（调度员）、manager（站长）、regional（区域经理），决定提问人能批什么。
- `pair`：值相同的几题按顺序在同一段对话里问。
- `expect.behavior`：`answer` 正常回答、`clarify` 问一句、`decline` 说明超出范围、`refuse` 拒绝跳过确认或审批、`proposal` 给出等人确认的批准 / 否决提议。
- `accept`：出题人标为「也可以」、而且条件在评测时刻成立的做法。
- `note`：出题人的说明（英文）。

## 数据卡

- **来源。** 每一套由一个单独启动的 AI 写作代理（通用的语言模型代理）出题，它只看一份简短的文字说明，不许打开仓库、训练语料、标准问题和别的题。题目原样收进来，只有 B69 换了一处中性的措辞。
- **规模和覆盖。** 4 × 80 题；每套覆盖全部 36 类意图，有 5 段两轮对话，角色混合（大约六成调度员、四分之一站长，其余是区域经理和只读用户），回答形态混合（每套大约 53 道正常回答、10 道问一句、8 道超出范围、4–5 道拒绝、3–5 道提议）。
- **评测时刻。** 默认区域、仿真第 86 天 05:01（第一张迟到卡出来以后一分钟），附合成的仓储中心作业计划；此刻有两张待处理的建议卡、路上一辆车晚点、没有 M06 这辆车。
- **用途。** 比较不同的值班助手（规则、小模型、大模型）在物流运营场景里听懂请求、守审批规则的能力；教学：怎样诚实地评测一个助手。
- **不适合。** 评回答的文笔；真实的运营决策；对任何真实企业下结论。
- **污染。** 第一到第三套已经看过，只当回归题；第四套仍是盲测（首次运行是正式成绩）。数据公开以后，以后的模型可能见过这些题。
- **局限。** 题少（单套 95% 区间约正负 10 个百分点）、只有一个合成时刻、只有中文、标注由一个人把关、题目由语言模型代理写。
- **许可证。** CC BY 4.0（题目、schema、评测时刻的数据、结果、网页）。评分的代码是 AGPL-3.0-only。

## 评一份预测文件

```bash
npm run bench -- score --pred my.jsonl --name my-bot --save   # 打印表格和答错的每一题；保存 results/my-bot.json
npm run bench -- report                                         # 加进 docs/benchmark*.md 和 site/index.html
```
