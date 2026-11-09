# 场景文件和分享链接

[English](07-scenarios.en.md)

**场景**是孪生里一个可以分享、可以复现的时刻：哪个区域、哪种方案、第几组仿真、什么负荷和演练、设施怎么改过、从几点开始看、镜头在哪、跟随哪辆车，以及要不要放演示导览、打开哪道练习。同一份场景在任何电脑上打开，看到的是同一个结果（仿真是确定的）。

场景有三种用法：

1. **分享链接**：顶栏「分享」复制当前状态的链接，别人打开就是你看到的样子。
2. **场景文件**（`.json`）：「分享 → 导出场景文件」下载，「导入场景文件」打开；场景库里的就是这样的文件（`web/public/scenarios/`）。
3. **命令行**：`npm run sim -- scenario 文件.json [--json]` 不开网页按场景跑一次，打印主要指标和调度台当天的 KPI；教学沙盘的自动批改（`npm run teach`）也读同一个格式。

格式由 `src/scenario/` 定义（`types.ts` 写了每个字段的含义，`parse.ts` 是检查规则），JSON Schema 在 [`scenario.schema.json`](scenario.schema.json)（编辑器里写 `"$schema": "./scenario.schema.json"` 就有补全）。

## 一个例子

```json
{
  "$schema": "../../docs/scenario.schema.json",
  "format": "storex-chain/scenario",
  "version": 1,
  "id": "port-congestion",
  "title": "港口拥堵演练",
  "titleEn": "Port congestion drill",
  "description": "班轮晚到 6 天、堆场停留翻倍时，港口和配送中心怎么排。",
  "gen": "g3",
  "seed": 1,
  "load": "normal",
  "drill": "portCongestion",
  "facilities": { "port": { "gateLanes": 3 }, "dc": { "dryDoors": 14 } },
  "time": "08:30",
  "speed": 60,
  "play": true,
  "camera": { "preset": "port" },
  "follow": "DR-02"
}
```

## 字段

所有字段都可以不写，不写就用网页的默认值。

| 字段 | 取值 | 说明 |
|---|---|---|
| `format`、`version` | `"storex-chain/scenario"`、`1` | 可以不写；写了就要对 |
| `id` | 小写字母、数字、连字符 | 场景库里的编号（和文件名一致） |
| `title` / `titleEn`、`description` / `descriptionEn` | 文字 | 中英文标题和说明 |
| `region` | `default`、`random-编号`、`custom-编号~选项…` | 和网址里的 `?region=` 一样；区域不同时网页会重新载入 |
| `gen` | `g1` / `g2` / `g3` | 上一代 / StoreX / StoreX 全链路 |
| `seed` | 1–9999 | 仿真的第几组 |
| `load` | `normal` / `peak` / `high` / `extreme` | 负荷档位 |
| `drill` | `none` / `portCongestion` / `airportClosed` / `highwayClosed` / `supplierOutage` / `demandSurge` | 演练（扰动） |
| `facilities` | `{ port, airport, dc, store }` 的部分字段 | 相对默认配置的改动，取值范围和管理台的滑块一样；`down`（检修设备）整个替换；`staff` 按岗位合并：`[{ "key": "recv", "crew": { "early": 3 } }]` |
| `time` | `"HH:MM"` 或当天的秒数 | 从几点开始看 |
| `speed` | 10 / 60 / 120 / 300 / 600 / 1800 | 播放速度（仿真每秒走几秒） |
| `play` | true / false | 打开就播放 |
| `camera` | `{ "preset": "overview" \| "port" \| "airport" \| "dc" \| "flagship" }` 或 `{ "position": [x,y,z], "target": [x,y,z] }` | 镜头 |
| `follow` | 车牌 / 编号（如 `DR-02`、`M03`）或作业编号 | 跟随一辆车 |
| `weather` | `auto` / `clear` / `cloudy` / `rain` / `fog` / `storm` | 天气 |
| `tab` | `twin` / `report` / `network` / `about` | 打开哪个页签 |
| `tour` | `container` | 打开就放演示导览「一个集装箱从船到货架」 |
| `exercise` | `ex01` … `ex10` | 打开教学沙盘的哪道练习 |

不认识的字段只提醒、不算错（以后的版本可能加字段）；取值不对的字段会逐条报错，整份场景不套用。

## 网页怎么套用场景

- **影响仿真的字段**（`region`、`gen`、`seed`、`load`、`drill`、`facilities`）不写就用默认值，所以同一份场景在谁的电脑上打开结果都一样；**看画面的字段**（`time`、`speed`、`play`、`camera`、`follow`、`weather`、`tab`）不写就保持当前的样子。
- 区域或设施和当前不同时，网页带着参数重新载入（15 秒内超过 3 次就停下并提示，防止来回跳）。
- 打开别人的链接时，设施以链接为准，**不覆盖**你在管理台里保存的配置；在管理台里保存设施时，如果网址带着场景参数，会换成带新设施的链接重新载入（方案、时刻、镜头都保留）。
- `tour` 和 `ex` 是一次性的：套用以后从网址里去掉，刷新不会重放导览、重开练习。
- 带场景参数打开时不弹欢迎卡和界面导览（`?onboard=1` 可以强制弹出，`?onboard=0` 总是不弹）。

## 分享链接里的参数

| 参数 | 场景字段 | 例子 |
|---|---|---|
| `region` | `region` | `region=random-3` |
| `gen`、`seed`、`load`、`drill` | 同名 | `gen=g3&seed=2&load=peak&drill=portCongestion` |
| `t` | `time` | `t=08:30` |
| `speed`、`play` | 同名 | `speed=60&play=1` |
| `cam` | `camera` | `cam=port` 或 `cam=x,y,z,tx,ty,tz` |
| `follow`、`weather`、`tour` | 同名 | `follow=DR-02&tour=container` |
| `ex` | `exercise` | `ex=ex03` |
| `fac` | `facilities` | base64url 编码的 JSON |
| `scenario` | — | 场景库里的文件编号：`scenario=port-congestion`，网址里其余参数覆盖文件里的 |
| `#report`、`#network`、`#about` | `tab` | 页签 |

`lang=en`（界面语言）不属于场景，分享时原样保留。

## 兼容性

- 格式版本是 `1`。只加字段时版本不变；改了已有字段的含义才升版本，并在 CHANGELOG 里写明。
- 旧链接里没有的字段按默认值处理，所以以前分享的链接以后还能打开。
