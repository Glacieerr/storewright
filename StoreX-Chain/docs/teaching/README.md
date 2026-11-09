# 运营教学沙盘

[English](README.en.md)

给**物流、供应链管理、工业工程、交通运输**等课程用的教学包：一个在浏览器里打开就能用的区域供应链数字孪生（港口、机场、物流园、配送中心、门店，三维 + 调度台 + 值班助手），加上 **10 道练习**、**自动批改**和**教师参考答案**，中英文界面都能用。

> 数据全是合成的，仅供教学，不代表任何真实企业的运营数据，也不能用来做真实的生产决策。本项目是个人作品集 / 开源项目，与任何零售商、企业无隶属关系。

## 包里有什么

| 内容 | 位置 |
|---|---|
| 10 道练习（起始场景、步骤、问题、自动批改） | 网页顶栏「练习」；定义在 [`src/teach/exercises.ts`](../../src/teach/exercises.ts) |
| 学生实验指导书 | [lab-manual.md](lab-manual.md)（[English](lab-manual.en.md)） |
| 教师参考答案（从仿真算出） | [instructor/answer-key.md](instructor/answer-key.md)（[English](instructor/answer-key.en.md)） |
| 教学说明：知识点对应、讨论题、延伸作业、常见错误 | [instructor/teaching-notes.md](instructor/teaching-notes.md)（[English](instructor/teaching-notes.en.md)） |
| 批改命令行 | `npm run teach`（见下文） |

## 十道练习

| 编号 | 练习 | 难度 | 时长 | 知识点 |
|---|---|---|---|---|
| ex01 | 读懂一天：全链路的节奏和 KPI | 入门 | 15 分钟 | KPI 读数、服务水平、准点率、每箱成本 |
| ex02 | 港口：集装箱在堆场停多久、滞箱费从哪来 | 基础 | 20 分钟 | 港口堆场、免费堆存期与滞箱费、预清关、铁路接驳 |
| ex03 | 车队与卸货节拍：门店收货慢了，为什么要多用车 | 基础 | 20 分钟 | 车队规模、车辆周转、利特尔法则 |
| ex04 | 配送中心月台门：门数按峰值配 | 基础 | 25 分钟 | 月台门规划、峰值与平均利用率、排队 |
| ex05 | 冷链：到店剩余保质期和生鲜损耗 | 基础 | 20 分钟 | 冷链、剩余保质期、越库 |
| ex06 | 门店收货：收货口要几个 | 基础 | 25 分钟 | 收货口、到店时间窗、资源配置 |
| ex07 | 演练：港口拥堵的影响与应对 | 基础 | 20 分钟 | 扰动演练、韧性、安全库存、提前期 |
| ex08 | 压力测试：从平常到极限，瓶颈在哪 | 进阶 | 30 分钟 | 压力测试、规模效应、瓶颈识别 |
| ex09 | 方案对比：上一代 / StoreX / StoreX 全链路 | 基础 | 20 分钟 | 供应链设计、信息共享、库存、成本与排放 |
| ex10 | 值班助手查原因：问它，再用调度台核对 | 进阶 | 25 分钟 | 根因分析、可审计的 AI、人在回路 |

合计约 3.5 小时。建议的安排：

- **两次课（各 90 分钟）**：第一次 ex01、ex02、ex05、ex09（读指标、比方案）；第二次 ex03、ex04、ex06、ex07（改设置、做演练）。ex08、ex10 留作课后作业。
- **一次实验课（3–4 小时）**：全部 10 道，分组做，最后每组讲一道讨论题。
- **只有一节课**：ex01 + ex04 + ex07，三道覆盖「读指标 → 改设置 → 做演练」。

## 准备

**在线演示（不用安装）**：<https://glacieerr.github.io/storewright/storex-chain/>（首次推送后可用）。全部练习都在浏览器里跑，学生只要一台能打开网页的电脑（建议用最新的 Chrome、Edge、Firefox 或 Safari，有独立显卡更流畅）。

**本地运行**（离线教室、或者想改练习）：装 Node.js 22，在仓库根目录：

```bash
npm install
npm run dev -w storex-chain
```

浏览器打开 <http://localhost:5182>。界面右上角可以切换中文 / EN，也可以在网址后面加 `?lang=en`。

## 课堂上怎么用

1. 学生点顶栏「练习」→ 选一道 →「载入起始场景」（方案、负荷、演练、设施、镜头都会设好）。
2. 按步骤操作，在界面里找数字、改设置，把答案填进问题。
3. 「检查答案」即时反馈：对的打勾，错的给提示（不给答案），可以改了再查。进度存在本机浏览器里。
4. 做完点「导出我的作答」，得到 `exNN-answers.json`（里面有学生当时的场景和答案），交给老师。

练习面板还有每道题的「背景知识」和「课后讨论」；讨论题不批改，适合写短报告或课堂讨论。

## 批改

批改用的是同一套规则：按学生的场景**重新仿真**（同样的场景每次结果一样），数字题按容差、选择题按选项、设置任务看学生的场景有没有真的做到。所以老师和学生在任何电脑上得到的分数一样。

```bash
# 列出练习、打印一道题
npm run teach -w storex-chain -- list
npm run teach -w storex-chain -- show ex04

# 批改一份作答（及格退出码 0，没及格 1，文件不合法 2）
npm run teach -w storex-chain -- check ex04 --answers ex04-answers.json

# 机器可读的结果（可以汇总进成绩表）
npm run teach -w storex-chain -- check ex04 --answers ex04-answers.json --json

# 参考答案；--write 重新生成 instructor/answer-key*.md
npm run teach -w storex-chain -- key
```

一整个班的作答放在一个文件夹里时，可以这样批改（macOS / Linux 的 shell）：

```bash
for f in answers/*.json; do npm run -s teach -w storex-chain -- check ex04 --answers "$f" --json; done > results.jsonl
```

每道练习满分 100，得分达到 70% 算通过。也可以只用网页里的「检查答案」，不收作答文件。

## 想改练习、加练习

练习定义在 [`src/teach/exercises.ts`](../../src/teach/exercises.ts)：起始场景用[场景文件格式](../../src/scenario/types.ts)，每道题写 `expect(state)`（从仿真结果算出正确答案）和容差，设置任务写 `ok(state)`。背景知识和讨论题在 [`src/teach/background.ts`](../../src/teach/background.ts)。改完运行：

```bash
npm run teach -w storex-chain -- key --write      # 重新生成参考答案
npm run teach -w storex-chain -- manual --write   # 重新生成实验指导书
npx vitest run tests/teach.test.ts                # 检查：参考答案全对、答错扣分
```

## 许可

教学文档按 [CC BY 4.0](../../../LICENSE-docs) 发布：可以复制、改编、用于教学（包括收费课程），注明出处即可。代码按仓库的 [AGPL-3.0](../../../LICENSE) 发布。
