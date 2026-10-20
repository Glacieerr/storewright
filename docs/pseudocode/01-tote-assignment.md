# 伪代码 01 · 分箱（订单 → 框任务）

> 实现：`packages/algorithms/src/totes.ts` · 工程约束 EC-1、EC-4 · 决策 P-01、P-03、P-04、GM-01

## 输入与输出

- 输入：一个订单（订单行 = 商品 + 数量）、商品主数据（温区、处理方式、尺寸、重量、压放等级）、门店配置（框内径、重量上限、装填系数、大件规则）
- 输出：框任务列表（每个框只属于这个订单）+ 大件清单（一件一签）

## 伪代码

```text
function ASSIGN_TOTES(order):
    standard ← []
    oversized ← []

    // 1. 大件分类：按门店规则，第一条命中为准
    for line in order.lines:
        facts ← { 单件重量, 整行重量, 能否放进框, 履约类型, 类别, 温区 }
        class ← FIRST_MATCH(store.sizeRules, facts, default = STANDARD)
        if class = STANDARD:
            standard.append(line)
        else:
            for i in 1..line.qty:
                oversized.append(Piece(line, i / line.qty, teamLift = class = TEAM_LIFT))

    // 2. 分段：温区 × 履约类型 × 是否化学品（化学品单独装框）
    segments ← GROUP_BY(standard, line → (温区, 履约类型, 是否化学品))

    // 3. 段内单遍首次适应：重物在下、易碎在上
    capacity ← 框容积 × 装填系数
    for segment in segments:
        lines ← SORT(segment, by 压放等级 升序, 单件体积 降序, 行号)
        totes ← []
        for line in lines:
            repeat line.qty times:
                target ← 第一个满足 (体积 + v ≤ capacity 且 重量 + w ≤ 重量上限) 的框
                if target 不存在:
                    target ← 新框          // 单件超过装填系数但放得下时，允许独占一个框
                    totes.append(target)
                PUT(target, line, 1)
        segment.totes ← totes

    // 4. 编号：按 常温 → 冷藏 → 冷冻 → 热食 排序，生成标签上的 x / n
    all ← CONCAT(segments 按温区排序)
    for i, tote in ENUMERATE(all):
        tote.index ← i + 1
        tote.count ← |all|
    return (all, oversized)
```

## 不变式（由属性测试保证）

| 不变式 | 测试 |
|---|---|
| 每个框的重量 ≤ 上限 | `algorithms.test.ts` |
| 多件框的体积 ≤ 容积 × 装填系数 | 同上 |
| 一个框只属于一个订单、只有一个温区 | 同上 |
| 化学品不与食品混装；没有「易碎品之后又装入重物」 | 同上 |
| 每件商品恰好出现一次（在框里或在大件清单里） | 同上 |

## 刻意不做的事

- **不在框之间交换商品**来减少框数，也不做迭代式局部搜索（工程约束 EC-4）。分箱结果一旦确定就不再变化，标签可以预先打印。
