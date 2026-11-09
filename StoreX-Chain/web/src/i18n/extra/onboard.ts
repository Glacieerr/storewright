/**
 * English UI strings for first contact (welcome card, guided tour, help button, teaching drawer host),
 * keyed by the Chinese source text (merged into ../en.ts).
 */
export const EN_ONBOARD: Record<string, string> = {
  // index.html — top bar and teaching drawer
  练习: 'Exercises',
  '教学沙盘：10 道练习，自动批改': 'Teaching sandbox: 10 exercises with automatic grading',
  '界面导览（随时再看）': 'Guided tour of the interface (any time)',
  界面导览: 'Guided tour of the interface',
  '教学沙盘：练习': 'Teaching sandbox: exercises',
  '教学沙盘 · 练习': 'Teaching sandbox · Exercises',
  关闭练习面板: 'Close the exercise panel',
  '正在载入练习…': 'Loading exercises…',
  '练习面板没能载入：{err}': 'The exercise panel could not load: {err}',
  // welcome card
  '欢迎来到 StoreX 全链路': 'Welcome to StoreX Chain',
  '一家综合店整条供应链的数字孪生：远洋班轮、货机、洲际班列和长途货车，经过港口、机场货站、物流园和配送中心，一直到门店的货架。全部在浏览器里运行，数据都是合成的。':
    "A digital twin of one large store's whole supply chain: ocean liners, freighters, intercontinental trains and long-haul trucks, through the port, the air cargo terminal, the logistics park and the distribution centre, all the way to the store shelf. Everything runs in your browser; all data is synthetic.",
  看一个集装箱从船到货架: 'Follow one container from ship to shelf',
  '一分钟的自动导览，镜头跟着货走': 'A one-minute guided tour; the camera follows the cargo',
  做一道练习: 'Try an exercise',
  '教学沙盘：改门、调车、做演练，自动批改': 'Teaching sandbox: change doors, fleets and drills, graded automatically',
  自己看看: 'Explore on my own',
  '先花 30 秒认识一下界面': 'Take 30 seconds to learn the interface first',
  不再显示: "Don't show again",
  // guided tour
  跳过: 'Skip',
  上一步: 'Back',
  下一步: 'Next',
  完成: 'Done',
  '1 / 选方案、区域、负荷和演练': '1 / Pick the scheme, region, load and drill',
  '上一代 / StoreX / 全链路三种方案；区域可以随机生成或自定义；负荷做压力测试；演练放进港口拥堵、机场关闭这些扰动。改完点「运行」，后台几秒钟仿真 18 周。':
    'Three schemes: previous generation / StoreX / full chain. The region can be random or custom; the load runs stress tests; drills add disruptions such as port congestion or an airport closure. Press “Run” and 18 weeks are simulated in the background in a few seconds.',
  '2 / 区域三维孪生': '2 / The regional 3D twin',
  '港口、机场、物流园、门店和路上的每一辆车、船、飞机都按仿真在走。拖动旋转、滚轮缩放；点一辆车看它的整趟路线；下面一排是镜头预设和图层（地名、规划图、车辆标签、监控画面、对比回放、天气、画质）。':
    'Every truck, ship and aircraft at the port, airport, logistics park, store and on the roads moves as simulated. Drag to rotate, scroll to zoom, click a vehicle to see its whole route; the row below holds camera presets and layers (place names, land-use plan, vehicle tags, monitors, split replay, weather, quality).',
  '3 / 时间轴': '3 / Timeline',
  '播放、暂停、拖到任一时刻；速度从 10 秒 / 秒到 30 分钟 / 秒。整个页面（三维、调度台、看板、助手）都跟着这个时钟走。':
    'Play, pause or drag to any moment; speed from 10 s/s to 30 min/s. The whole page (3D, dispatch board, KPI board, assistant) follows this clock.',
  '4 / 值班助手': '4 / Duty assistant',
  '用自然语言问：「现在哪些车晚了」「港口那边怎么样」「要是高速封两个钟头会怎样」。每个回答都标出数据来源；要改计划的建议只会提交给你确认，不会自己执行。':
    'Ask in plain language: “which trucks are late”, “how is the port doing”, “what if the highway closes for two hours”. Every answer cites its data; proposals that change the plan are only submitted for your confirmation, never executed on their own.',
  '5 / 分层看板': '5 / Layered KPI board',
  '集团、区域、设施、作业四层指标；超过阈值就告警，没人确认会往上报。': 'Group, region, facility and operation KPIs; crossing a threshold raises an alert, which escalates if nobody acknowledges it.',
  '6 / 调度台': '6 / Dispatch board',
  '当天的全部作业：船、火车、飞机、拖车、配送车和月台门。可以改出发时刻、换门、换车，或者让求解器排一遍，再看迟到和成本怎么变。':
    "The whole day's jobs: ships, trains, aircraft, drayage, delivery trucks and dock doors. Change departure times, swap doors or vehicles, or let the solver plan it, then see how lateness and cost change.",
  '7 / 更多入口': '7 / More entry points',
  '「分享」复制此刻的链接或导出场景文件；「场景库」一键切到精选场景；「练习」是教学沙盘的 10 道题；「?」随时再看这个导览。上面的页签是对比报告、网络规划和说明，右边切换中文 / English。':
    '“Share” copies a link to this moment or exports a scenario file; “Scenarios” jumps to curated scenarios; “Exercises” opens the 10 teaching-sandbox tasks; “?” replays this tour. The tabs above hold the comparison reports, network planning and the about page; switch the language (Chinese / English) on the right.',
};
