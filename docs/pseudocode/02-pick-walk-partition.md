# 伪代码 02 · 分批与路线（框任务 → 拣货批次）

> 实现：`packages/algorithms/src/batching.ts`、`routing.ts` · 工程约束 EC-1、EC-2、EC-3、EC-5、EC-6 · 决策 P-02、P-12

## 输入与输出

- 输入：一个计划周期内释放的框任务**摘要**——只有框号、订单号、温区、时段、行数、件数、所涉通道。**不含重量和体积**（EC-1）
- 输出：拣货批次（每辆推车 ≤ 8 框、单一温区），每个批次带按路线顺序排列的拣货清单

## 伪代码

```text
function PLAN_PICK_WALKS(summaries):
    walks ← []
    // 1. 分组：常温同车、冷藏同车、冷冻同车，并按时段分开
    for group in GROUP_BY(summaries, s → (温区, 履约类型, 时段)):

        // 2. 划分单位：同一订单同温区的框作为整体（默认）；「效率优先」档位可以拆开
        units ← GROUP_BY(group, s → 订单号)，每个单位最多 8 框

        // 3. 全局排序：与输入顺序无关（EC-2）
        units ← SORT(units, by 所涉通道顺序的中位数, 最小值, 最大值, 订单号, 框序号)

        // 4. 对每个候选推车数 k：固定 k，求总用时最小的连续切分
        best ← none
        for k from ⌈框数 / 8⌉ upward:
            res ← PARTITION_INTO_K(units, k)
            if res 可行 且 res.total < best.total: best ← res
            if 连续 3 个 k 都没有改进: break
        walks.extend(best.groups)

    // 5. 每个批次确定之后才规划路线（EC-3），拣货顺序就是路线顺序（EC-5）
    return [BUILD_WALK(g) for g in walks]

function PARTITION_INTO_K(units, k):
    // dp[j][i]：用 j 辆车装下前 i 个单位的最小预计总用时
    dp[0][0] ← 0
    for j in 1..k:
        for i in j..n:
            for p from i-1 down to j-1:
                if 框数(p..i) > 8: break                    // 区间越往前越大，不必再看
                if 冷链批次 且 预计用时(p..i) > 冷链时限(件数): continue
                dp[j][i] ← min(dp[j][i], dp[j-1][p] + 预计用时(p..i))
    return 回溯 dp[k][n] 得到的 k 段

function 预计用时(区间):            // 只用标准工时
    return 基础时间 + 行数 × 每行时间 + 件数 × 每件时间 + 不同通道数 × 每通道时间

function 冷链时限(件数):            // 决策 P-12
    return clamp(20 分钟 + 0.5 分钟 × 件数, 15 分钟, 60 分钟)

function BUILD_WALK(group):
    stops ← 按主陈列位置汇总的拣货指令
    order ← ROUTE_TSP(stops 的节点, 起点 = 推车点, 终点 = 暂存区)
    return 按 order 排列的 stops

function ROUTE_TSP(nodes, start, end):
    seq ← 最近邻构造（距离 = 门店行走网络上的最短路径）
    repeat until 没有改进:
        for 每一段 (i..k):
            if 反转 i..k 使总长度变短: 反转      // 2-opt：只调整路线顺序
    return seq
```

## 配送行程（暂存之后，EC-6）

```text
function COMPOSE_TRIPS(本时段已暂存的配送订单):
    按目的地相对门店的方位角排序
    依次装入当前行程，直到 订单数 = 每趟上限（默认 4）或 超过车辆可装框数 / 重量
    车内位置：框最多的订单放尾箱，其次后排左、后排右，最少的放副驾
    // 行程状态只到「已交给司机」为止（EC-10）
```

## 不变式（由属性测试保证）

- 每辆车 ≤ 8 框、单一温区、每个框恰好出现一次；
- 打乱输入顺序，划分结果完全相同；
- 按订单划分时，同一订单同温区的框在同一辆车上；
- 由多个单位组成的冷链批次不超过冷链时限；
- 2-opt 之后的路线不比最近邻构造更长。
