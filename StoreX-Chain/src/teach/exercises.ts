import type { Scenario } from '../scenario/types';
import { base, current, dayKpi, defineExercise, facOf, crewIn, issueCount, onTimePct, sameSetup, val, variant, boardOf, type QSpec } from './lab';
import type { Exercise, TeachState } from './types';

/**
 * 运营教学沙盘的十道练习（物流、供应链、工业工程课程用）。数据全是合成的，仅供教学；每道练习的参考答案都由仿真算出来
 * （npm run teach -- key），批改用的是同一份数，所以老师、学生在任何电脑上得到同一个分数。
 * 界面位置的写法：顶栏（方案、负荷、演练）、左侧「这次运行（18 周平均）」表、「调度台」（指标瓦片和「问题」列表）、右侧「设施监控」→「管理」（设施管理）、
 * 「值班助手」、练习面板的「读数」区。
 *
 * Ten exercises for logistics / supply-chain / industrial-engineering courses. Synthetic data, for teaching only.
 */

const ABCD = (zh: [string, string, string, string], en: [string, string, string, string]) =>
  (['a', 'b', 'c', 'd'] as const).map((id, i) => ({ id, text: zh[i] as string, textEn: en[i] as string }));
const ABC = (zh: [string, string, string], en: [string, string, string]) =>
  (['a', 'b', 'c'] as const).map((id, i) => ({ id, text: zh[i] as string, textEn: en[i] as string }));
const LOOK_SUMMARY = {
  hint: '看左侧「这次运行（18 周平均）」表的「这次」一列（按面板上的小数位填）',
  hintEn: 'read the "This run" column of the "This run (18-week average)" table on the left (as many decimals as shown)',
};
const LOOK_DISPATCH = { hint: '看「调度台」上方的指标瓦片', hintEn: 'read the tiles at the top of the Dispatch board' };
const LOOK_READOUT = {
  hint: '看练习面板的「读数」区，切换方案后要等仿真跑完',
  hintEn: 'read the Readouts area of the exercise panel; after switching the Generation wait for the run to finish',
};
const THINK = {
  hint: '再想想：答案要能被这道练习里看到的数字支持',
  hintEn: 'think again: the answer should be supported by the numbers you saw in this exercise',
};

const withFac = (s: Scenario, f: Scenario['facilities']): Scenario => {
  const out: Scenario = { ...s, facilities: { ...(s.facilities ?? {}) } };
  for (const [k, v] of Object.entries(f ?? {}))
    (out.facilities as Record<string, unknown>)[k] = { ...((out.facilities as Record<string, object>)[k] ?? {}), ...(v as object) };
  return out;
};
const sim = (s: Scenario): Scenario => ({
  ...(s.region ? { region: s.region } : {}),
  gen: s.gen ?? 'g3',
  seed: s.seed ?? 1,
  load: s.load ?? 'normal',
  drill: s.drill ?? 'none',
  ...(s.facilities ? { facilities: s.facilities } : {}),
});

// —— 1 读懂一天 ——
const ex01 = defineExercise({
  id: 'ex01',
  title: '读懂一天：全链路的节奏和 KPI',
  titleEn: 'Read a day: the rhythm of the chain and its KPIs',
  level: 'intro',
  minutes: 15,
  topics: ['KPI 读数', '服务水平', '准点率', '每箱成本'],
  topicsEn: ['reading KPIs', 'service level', 'on-time rate', 'cost per case'],
  goals: '认识孪生的主要界面：顶栏、指标面板、调度台；分清「18 周平均」的指标（指标面板）和「动画这一天」的指标（调度台）。',
  goalsEn:
    'Find your way around the twin (top bar, "This run (18-week average)" table, Dispatch board) and tell the 18-week averages (that table) from the figures for the animated day (Dispatch).',
  scenario: {
    title: '练习 1 · 读懂一天',
    titleEn: 'Exercise 1 · Read a day',
    gen: 'g3',
    seed: 1,
    load: 'normal',
    drill: 'none',
    time: 6 * 3600,
    speed: 600,
    play: true,
    camera: { preset: 'overview' },
  },
  steps: [
    {
      zh: '点「载入起始场景」：方案是「StoreX 全链路」、负荷平常、没有演练，从早上 6 点开始播放。',
      en: 'Click "Load starting scenario": Generation "StoreX Chain", Normal load, no drill, playing from 06:00.',
    },
    {
      zh: '看三维视图：配送车 2:30–10 点出车，班轮、班列、货机按时刻表到。镜头预设可以切到港口、机场、物流园、综合店。',
      en: 'Watch the 3D view: delivery trucks leave 02:30–10:00; liners, trains and freighters follow their timetables. Use the camera presets to jump to the port, airport, logistics park and store.',
    },
    {
      zh: '打开「调度台」，看上方的指标瓦片：作业、到店准点、迟到、门外等、用车、月台门峰值、问题。',
      en: 'Open the Dispatch board and read the tiles: Jobs, Store arrivals on time, Late, Waiting outside, Vehicles used, Dock door peak, Issues.',
    },
    {
      zh: '看左侧「这次运行（18 周平均）」表：这是 18 周的日平均，「比上一代」一列是和上一代方案比。',
      en: 'Read the "This run (18-week average)" table on the left: 18-week daily averages; the "vs previous generation" column compares with the previous-generation scheme.',
    },
  ],
  questions: [
    {
      id: 'q1',
      kind: 'number',
      prompt: '调度台「作业」一共几个？',
      promptEn: 'How many jobs does the Dispatch board show in total?',
      points: 25,
      tol: 0,
      expect: (s) => dayKpi(base(s)).ops,
      ...LOOK_DISPATCH,
    },
    {
      id: 'q2',
      kind: 'number',
      unit: '%',
      prompt: '调度台「到店准点」是百分之多少？',
      promptEn: 'What is "Store arrivals on time" on the Dispatch board (%)?',
      points: 25,
      tol: 0.15,
      expect: (s) => onTimePct(base(s)),
      ...LOOK_DISPATCH,
    },
    {
      id: 'q3',
      kind: 'number',
      unit: '%',
      prompt: '「这次运行（18 周平均）」表里「门店服务水平（需求满足）」这次是多少？',
      promptEn: 'What is "Store service level (demand met)" in the "This run (18-week average)" table (%)?',
      points: 25,
      tol: 0.015,
      expect: (s) => val(base(s), 'service'),
      ...LOOK_SUMMARY,
    },
    {
      id: 'q4',
      kind: 'number',
      unit: '美元',
      prompt: '「这次运行（18 周平均）」表里「每箱的供应链成本」这次是多少美元？',
      promptEn: 'What is "Supply-chain cost per box" in the "This run (18-week average)" table (USD)?',
      points: 25,
      tol: 0.006,
      expect: (s) => val(base(s), 'costPerCase'),
      ...LOOK_SUMMARY,
    },
  ],
});

// —— 2 港口：堆场停留与滞箱费 ——
const ex02start: Scenario = {
  title: '练习 2 · 港口：堆场停留与滞箱费',
  titleEn: 'Exercise 2 · Port: yard dwell and demurrage',
  gen: 'g1',
  seed: 1,
  load: 'normal',
  drill: 'none',
  time: 7 * 3600,
  camera: { preset: 'port' },
};
const ex02 = defineExercise({
  id: 'ex02',
  title: '港口：集装箱在堆场停多久、滞箱费从哪来',
  titleEn: 'Port: how long containers sit in the yard, and where demurrage comes from',
  level: 'core',
  minutes: 20,
  topics: ['港口堆场', '免费堆存期与滞箱费', '预清关', '铁路接驳'],
  topicsEn: ['container yard', 'free time and demurrage', 'pre-clearance', 'rail shuttle'],
  goals: '理解集装箱在港口的停留由哪些环节组成（卸船、查验放行、提箱），超过免费堆存期就产生滞箱费；比较两种方案的差别和原因。',
  goalsEn:
    "Understand what a container's port dwell is made of (discharge, clearance, pick-up), that dwell beyond the free time incurs demurrage, and compare two schemes.",
  scenario: ex02start,
  readouts: ['dwell', 'demurrage', 'seaLead', 'railShare'],
  variants: (s) => [
    { key: 'g1', scenario: sim({ ...s, gen: 'g1' }) },
    { key: 'g3', scenario: sim({ ...s, gen: 'g3' }) },
  ],
  steps: [
    {
      zh: '载入起始场景（方案「上一代」，镜头在港口）。看练习面板的「读数」：集装箱在港口堆场停留、港口滞箱费。',
      en: 'Load the starting scenario (Generation "Previous generation", camera at the port). Read "Container dwell in the port yard" and "Port demurrage" in the Readouts.',
    },
    {
      zh: '顶栏方案换成「StoreX 全链路」，等仿真跑完，再看一遍读数。',
      en: 'Switch the Generation to "StoreX Chain", wait for the run to finish, and read them again.',
    },
    {
      zh: '在三维里看港口：本店班轮靠泊、岸桥卸船、拖车提箱；全链路方案还有铁路接驳把箱子拉到物流园货运站。',
      en: 'Watch the port in 3D: the liner berths, quay cranes discharge, trucks pick up; in the Chain scheme a rail shuttle also takes boxes to the logistics-park terminal.',
    },
  ],
  questions: [
    {
      id: 'q1',
      kind: 'number',
      unit: '天',
      prompt: '上一代：集装箱在港口堆场平均停留几天？',
      promptEn: 'Previous generation: average container dwell in the port yard (days)?',
      points: 25,
      tol: 0.05,
      expect: (s) => val(variant(s, 'g1'), 'dwell'),
      ...LOOK_READOUT,
    },
    {
      id: 'q2',
      kind: 'number',
      unit: '天',
      prompt: '全链路：平均停留几天？',
      promptEn: 'Chain: average dwell (days)?',
      points: 25,
      tol: 0.05,
      expect: (s) => val(variant(s, 'g3'), 'dwell'),
      ...LOOK_READOUT,
    },
    {
      id: 'q3',
      kind: 'number',
      unit: '美元 / 天',
      prompt: '全链路比上一代，港口滞箱费每天少多少美元？',
      promptEn: 'How many USD per day of demurrage does the Chain scheme save compared with the previous generation?',
      points: 25,
      tol: 2,
      expect: (s) => val(variant(s, 'g1'), 'demurrage') - val(variant(s, 'g3'), 'demurrage'),
      hint: '用上一代的滞箱费减去全链路的',
      hintEn: 'subtract the Chain figure from the previous-generation figure',
    },
    {
      id: 'q4',
      kind: 'choice',
      prompt: '堆场停留缩短主要靠哪两项？',
      promptEn: 'Which two measures mainly shorten the yard dwell?',
      choices: ABCD(
        ['配送中心自动化 + 门店升级', '港口预清关和预约 + 铁路接驳', '多开冷链门 + 增加配送车', '需求下降，箱子变少'],
        [
          'DC automation + store upgrade',
          'Port pre-clearance and appointments + rail shuttle',
          'More cold doors + more delivery trucks',
          'Lower demand, fewer boxes',
        ],
      ),
      points: 25,
      expect: () => 'b',
      ...THINK,
    },
  ],
});

// —— 3 车队与卸货节拍 ——
const ex03start: Scenario = {
  title: '练习 3 · 车队与卸货节拍',
  titleEn: 'Exercise 3 · Fleet size and unloading pace',
  gen: 'g3',
  seed: 1,
  load: 'extreme',
  drill: 'none',
  time: 3 * 3600,
  camera: { preset: 'flagship' },
};
const ex03 = defineExercise({
  id: 'ex03',
  title: '车队与卸货节拍：门店收货慢了，为什么要多用车',
  titleEn: 'Fleet size and unloading pace: why slower store receiving needs more trucks',
  level: 'core',
  minutes: 20,
  topics: ['车队规模', '车辆周转', '利特尔法则', '系统思维'],
  topicsEn: ['fleet sizing', 'vehicle turnaround', "Little's law", 'systems thinking'],
  goals: '体会「车队规模 ≈ 车次 × 每趟用时 ÷ 可用时间」：门店卸货每慢一点，车就被占得久一点，同样的车次要更多的车。',
  goalsEn:
    'Experience "fleet ≈ trips × time per trip ÷ available time": every minute added to unloading ties trucks up longer, so the same trips need more trucks.',
  scenario: ex03start,
  readouts: ['fleet', 'trips', 'arrivals', 'costTotal'],
  solution: () => withFac(ex03start, { store: { staff: [{ key: 'recv', crew: { early: 1, late: 1, night: 1 } }] } }),
  steps: [
    {
      zh: '载入起始场景（负荷「极限」）。记下「这次运行（18 周平均）」表的「配送车队（最多同时用车）」。',
      en: 'Load the starting scenario (Load "Extreme"). Note "Delivery fleet (peak simultaneous use)" in the "This run (18-week average)" table.',
    },
    {
      zh: '右侧「设施监控」→ 选「综合店」页签 →「管理」→ 人员排班里把「收货员」早、中、夜班都改成 1 人，保存后重新仿真。',
      en: 'Facility monitor (right) → "Store" tab → "Admin" → in the staff schedule set the receivers role (收货员) to 1 on the early, late and night shifts, save, and let it re-run.',
    },
    {
      zh: '再看车队和调度台的「用车」，想一想车多在哪里。',
      en: 'Read the fleet and the Dispatch board\'s "Vehicles used" again, and think about where the extra trucks come from.',
    },
  ],
  tasks: [
    {
      id: 't1',
      text: '综合店收货员早、中、夜班都是 1 人（负荷仍是「极限」）',
      textEn: 'Store receivers set to 1 on all three shifts (Load still "Extreme")',
      points: 20,
      ok: (s) => {
        const c = crewIn(s.scenario, 'store', 'recv');
        return sameSetup(s.scenario, ex03start) && !!c && c.early === 1 && c.late === 1 && c.night === 1;
      },
      hint: '在设施管理里改综合店的收货员，三个班都要改，负荷别动',
      hintEn: 'change the store receivers (收货员) in Facility admin on all three shifts and keep the load',
    },
  ],
  questions: [
    {
      id: 'q1',
      kind: 'number',
      unit: '辆',
      prompt: '改之前（起始场景）配送车队是几辆？',
      promptEn: 'Before the change (starting scenario), how many trucks is the delivery fleet?',
      points: 20,
      tol: 0,
      expect: (s) => val(base(s), 'fleet'),
      ...LOOK_SUMMARY,
    },
    {
      id: 'q2',
      kind: 'number',
      unit: '辆',
      prompt: '改完以后配送车队是几辆？',
      promptEn: 'After the change, how many trucks is the delivery fleet?',
      points: 20,
      tol: 0,
      expect: (s) => val(current(s), 'fleet'),
      ...LOOK_SUMMARY,
    },
    {
      id: 'q3',
      kind: 'number',
      unit: '辆',
      prompt: '改完以后调度台「用车」是几辆？',
      promptEn: 'After the change, how many vehicles does the Dispatch board use?',
      points: 20,
      tol: 0,
      expect: (s) => dayKpi(current(s)).units,
      ...LOOK_DISPATCH,
    },
    {
      id: 'q4',
      kind: 'choice',
      prompt: '为什么收货员少了，配送反而要多用车？',
      promptEn: 'Why does having fewer receivers make deliveries need more trucks?',
      choices: ABCD(
        ['需求变大了', '路上更堵了', '每托卸得慢，车在门店停得更久，下一趟赶不上，只好多派车', '配送中心装车变慢了'],
        [
          'Demand went up',
          'Roads got busier',
          'Each pallet unloads more slowly, trucks stay longer at the store and miss their next trip, so more trucks are sent',
          'Loading at the DC got slower',
        ],
      ),
      points: 20,
      expect: () => 'c',
      ...THINK,
    },
  ],
});

// —— 4 配送中心月台门 ——
const ex04start: Scenario = withFac(
  {
    title: '练习 4 · 配送中心月台门',
    titleEn: 'Exercise 4 · DC dock doors',
    gen: 'g3',
    seed: 1,
    load: 'extreme',
    drill: 'none',
    time: 1 * 3600,
    camera: { preset: 'dc' },
  },
  { store: { size: 5 } },
);
const COLD = [4, 5, 6, 7, 8, 9, 10, 11, 12];
const coldWarn = (s: TeachState, n: number) => issueCount(variant(s, `cold${n}`), ['door-queue', 'door-full'], 'cold');
const minCold = (s: TeachState) => COLD.find((n) => coldWarn(s, n) === 0) ?? 12;
const ex04 = defineExercise({
  id: 'ex04',
  title: '配送中心月台门：门数按峰值配',
  titleEn: 'DC dock doors: size for the peak',
  level: 'core',
  minutes: 25,
  topics: ['月台门规划', '峰值与平均利用率', '排队', '产能规划'],
  topicsEn: ['dock-door planning', 'peak vs average utilisation', 'queueing', 'capacity planning'],
  goals: '门店升级成超大卖场、又赶上「极限」负荷：找出冷链月台门最少开几樘才不排队，理解为什么门数要按同时在用的峰值配，而不是按全天平均利用率。',
  goalsEn:
    'The store has grown into a hypermarket on an extreme day: find the fewest cold dock doors with no queueing, and see why doors are sized for the concurrent peak, not the daily average utilisation.',
  scenario: ex04start,
  readouts: ['dcLabor', 'outKm', 'fleet'],
  variants: (s) => COLD.map((n) => ({ key: `cold${n}`, scenario: withFac(sim(s), { dc: { coldDoors: n } }) })),
  solution: (s) => withFac(ex04start, { dc: { coldDoors: minCold(s) } }),
  steps: [
    {
      zh: '载入起始场景（超大卖场、负荷「极限」、冷链门 12 樘）。看调度台的「月台门峰值（冷链 · 干货）」和鼠标停在上面时的全天占用率。',
      en: 'Load the starting scenario (hypermarket, "Extreme" load, 12 cold doors). Read "Dock door peak (cold · dry)" on the Dispatch board and hover it for the daily utilisation.',
    },
    {
      zh: '「设施监控」→「物流园」→「管理」→ 把「开放的冷链月台门」一樘一樘往下调，每次保存后看调度台「问题」里有没有冷链门的「在场地排队等门」和「冷链门不够用」。',
      en: 'Facility monitor → "Logistics park" → "Admin" → lower "Open cold dock doors" one at a time; after each save check the Dispatch Issues for cold-door entries titled 在场地排队等门 (queueing in the yard for a door) and 冷链门不够用 (not enough cold doors).',
    },
    { zh: '停在「刚好不排队」的最少樘数上（不要动别的设置）。', en: 'Stop at the fewest doors with no queueing (leave everything else as it is).' },
  ],
  tasks: [
    {
      id: 't1',
      text: '冷链月台门开到「不排队的最少樘数」，冷链门没有排队和不够用的提醒',
      textEn: 'Cold dock doors set to the fewest with no queueing, and no cold-door queue or shortage warnings',
      points: 30,
      ok: (s) => {
        const f = facOf(s.scenario);
        return (
          sameSetup(s.scenario, ex04start) &&
          f.store.size === 5 &&
          f.dc.coldDoors === minCold(s) &&
          issueCount(current(s), ['door-queue', 'door-full'], 'cold') === 0
        );
      },
      hint: '不是太多就是太少：比它少一樘就会出现排队；门店规模和负荷不要改',
      hintEn: 'either too many or too few: one fewer door must cause queueing; do not change the store size or load',
    },
  ],
  questions: [
    {
      id: 'q1',
      kind: 'number',
      unit: '樘',
      prompt: '起始设置（冷链门 12 樘）下，「月台门峰值」的冷链是几樘？',
      promptEn: 'With the starting set-up (12 cold doors), what is the cold figure of "Dock door peak"?',
      points: 20,
      tol: 0,
      expect: (s) => dayKpi(base(s)).doorPeak.cold,
      ...LOOK_DISPATCH,
    },
    {
      id: 'q2',
      kind: 'number',
      unit: '樘',
      prompt: '冷链门最少开几樘，「问题」里就没有冷链门的排队和不够用？',
      promptEn: 'What is the fewest number of cold doors with no cold-door queueing or shortage in the issues?',
      points: 30,
      tol: 0,
      expect: minCold,
      hint: '一樘一樘地试，每次都要等重新仿真完再看问题列表',
      hintEn: 'try one door at a time and wait for each re-run before reading the issues',
    },
    {
      id: 'q3',
      kind: 'choice',
      prompt: '冷链门全天的平均占用率并不高，为什么还是不能随便少开？',
      promptEn: "The cold doors' average daily utilisation is low, so why can't you simply open fewer?",
      choices: ABCD(
        [
          '占用率越高越好，所以开得越少越好',
          '车集中在夜里和清早几个小时到和发，门要按同时在用的峰值配，峰值时门不够就要排队',
          '门开得越多越省钱',
          '冷链门和排队没有关系',
        ],
        [
          'Higher utilisation is always better, so open as few as possible',
          'Trucks arrive and leave in a few night and early-morning hours; doors must cover the concurrent peak, otherwise trucks queue at the peak',
          'More open doors always cost less',
          'Cold doors have nothing to do with queueing',
        ],
      ),
      points: 20,
      expect: () => 'b',
      ...THINK,
    },
  ],
});

// —— 5 冷链：保鲜与损耗 ——
const ex05start: Scenario = {
  title: '练习 5 · 冷链：保鲜与损耗',
  titleEn: 'Exercise 5 · Cold chain: freshness and waste',
  gen: 'g1',
  seed: 1,
  load: 'normal',
  drill: 'none',
  time: 2.5 * 3600,
  camera: { preset: 'dc' },
};
const ex05 = defineExercise({
  id: 'ex05',
  title: '冷链：到店剩余保质期和生鲜损耗',
  titleEn: 'Cold chain: remaining shelf life at the store and fresh waste',
  level: 'core',
  minutes: 20,
  topics: ['冷链', '剩余保质期', '越库', '生鲜损耗'],
  topicsEn: ['cold chain', 'remaining shelf life', 'cross-docking', 'fresh waste'],
  goals: '比较两种方案的生鲜指标，理解「在配送中心少放一夜」（夜间集货 + 越库）对剩余保质期和损耗的作用。',
  goalsEn:
    'Compare fresh-goods indicators of two schemes and see what "one night less in the DC" (night consolidation + cross-docking) does to shelf life and waste.',
  scenario: ex05start,
  readouts: ['freshRemain', 'waste', 'costWaste', 'peakChilled', 'peakFrozen'],
  variants: (s) => [
    { key: 'g1', scenario: sim({ ...s, gen: 'g1' }) },
    { key: 'g3', scenario: sim({ ...s, gen: 'g3' }) },
  ],
  steps: [
    {
      zh: '载入起始场景（方案「上一代」）。看「这次运行（18 周平均）」表的「生鲜到店时剩余的保质期」和「门店生鲜损耗」。',
      en: 'Load the starting scenario (Generation "Previous generation"). Read "Remaining shelf life of fresh goods on arrival" and "Store fresh shrink (spoiled / received)" in the "This run (18-week average)" table.',
    },
    { zh: '方案换成「StoreX 全链路」，等仿真跑完再看一遍。', en: 'Switch to "StoreX Chain", wait for the run, and read them again.' },
    {
      zh: '打开「对比与报告」页签 → 参数扫描里的「生鲜越库」，看越库单独值多少。',
      en: 'Open the "Comparison & reports" tab → the 生鲜越库 (fresh cross-docking) sweep, and see what cross-docking alone is worth.',
    },
  ],
  questions: [
    {
      id: 'q1',
      kind: 'number',
      unit: '%',
      prompt: '上一代：「生鲜到店时剩余的保质期」是多少？',
      promptEn: 'Previous generation: remaining shelf life of fresh goods at the store (%)?',
      points: 25,
      tol: 0.15,
      expect: (s) => val(variant(s, 'g1'), 'freshRemain'),
      ...LOOK_SUMMARY,
    },
    {
      id: 'q2',
      kind: 'number',
      unit: '%',
      prompt: '全链路：是多少？',
      promptEn: 'Chain: what is it (%)?',
      points: 25,
      tol: 0.15,
      expect: (s) => val(variant(s, 'g3'), 'freshRemain'),
      ...LOOK_SUMMARY,
    },
    {
      id: 'q3',
      kind: 'number',
      unit: '个百分点',
      prompt: '全链路的「门店生鲜损耗」比上一代低几个百分点？',
      promptEn: 'By how many percentage points is store fresh waste lower in the Chain scheme?',
      points: 25,
      tol: 0.03,
      expect: (s) => val(variant(s, 'g1'), 'waste') - val(variant(s, 'g3'), 'waste'),
      hint: '用上一代的损耗减去全链路的（两个都是百分数）',
      hintEn: 'subtract the Chain figure from the previous-generation figure (both are percentages)',
    },
    {
      id: 'q4',
      kind: 'choice',
      prompt: '哪一条冷链做法对「到店剩余保质期」贡献最大？',
      promptEn: 'Which cold-chain practice contributes most to the remaining shelf life at the store?',
      choices: ABCD(
        ['多开干货月台门', '生鲜夜间集货 + 越库，当天送店，不在配送中心过夜', '门店多开收货口', '配送车改走高速'],
        [
          'Opening more dry dock doors',
          'Night consolidation + cross-docking: delivered the same day, no night in the DC',
          'More receiving docks at the store',
          'Sending delivery trucks over the motorway',
        ],
      ),
      points: 25,
      expect: () => 'b',
      ...THINK,
    },
  ],
});

// —— 6 门店收货口 ——
const ex06start: Scenario = withFac(
  {
    title: '练习 6 · 门店收货口',
    titleEn: 'Exercise 6 · Store receiving docks',
    gen: 'g3',
    seed: 1,
    load: 'extreme',
    drill: 'none',
    time: 4 * 3600,
    camera: { preset: 'flagship' },
  },
  { store: { docks: 2 } },
);
const DOCKS = [2, 3, 4, 5, 6, 7, 8];
const minDocks = (s: TeachState) => DOCKS.find((n) => issueCount(variant(s, `docks${n}`), ['store-dock']) === 0) ?? 8;
const ex06 = defineExercise({
  id: 'ex06',
  title: '门店收货：收货口要几个',
  titleEn: 'Store receiving: how many docks',
  level: 'core',
  minutes: 25,
  topics: ['收货口', '到店时间窗', '同时卸货', '资源配置'],
  topicsEn: ['receiving docks', 'delivery windows', 'concurrent unloading', 'resource allocation'],
  goals: '「极限」负荷下只有 2 个收货口：数出「门店收货口不够」出现几次，找出最少要几个口，并想想不加口还能怎么办。',
  goalsEn:
    'On an extreme day with only 2 receiving docks: count the "not enough store docks" warnings, find the fewest docks needed, and think about what else could help.',
  scenario: ex06start,
  readouts: ['arrivals', 'fleet', 'onTime'],
  variants: (s) => DOCKS.map((n) => ({ key: `docks${n}`, scenario: withFac(sim(s), { store: { docks: n } }) })),
  solution: (s) => withFac(ex06start, { store: { docks: minDocks(s) } }),
  steps: [
    {
      zh: '载入起始场景（负荷「极限」、综合店 2 个收货口）。打开「调度台」的「问题」列表，数「门店收货口不够」。',
      en: 'Load the starting scenario ("Extreme" load, 2 receiving docks). Open the Dispatch Issues list and count the entries titled 门店收货口不够 (not enough store docks).',
    },
    {
      zh: '「设施监控」→「综合店」→「管理」→ 一个一个加「收货口」，每次保存后看这条提醒还在不在。',
      en: 'Facility monitor → "Store" → "Admin" → add receiving docks one at a time; after each save check whether the warning remains.',
    },
    { zh: '停在「刚好没有提醒」的最少个数上（不要动别的设置）。', en: 'Stop at the fewest docks with no warning (leave everything else as it is).' },
  ],
  tasks: [
    {
      id: 't1',
      text: '收货口开到最少够用的个数，「门店收货口不够」一条都没有',
      textEn: 'Receiving docks set to the fewest that suffice, with no "not enough store docks" warning',
      points: 30,
      ok: (s) => {
        const f = facOf(s.scenario);
        return (
          sameSetup(s.scenario, ex06start) &&
          f.store.size === 2.5 &&
          f.store.docks === minDocks(s) &&
          issueCount(current(s), ['store-dock']) === 0 &&
          JSON.stringify(crewIn(s.scenario, 'store', 'recv')) === JSON.stringify(crewIn({}, 'store', 'recv'))
        );
      },
      hint: '少一个就会出现提醒才算刚好；门店规模、收货员和负荷不要改',
      hintEn: 'it is just right when one fewer dock brings the warning back; keep the store size, receivers and load',
    },
  ],
  questions: [
    {
      id: 'q1',
      kind: 'number',
      unit: '条',
      prompt: '起始设置（2 个收货口）下，「问题」里有几条「门店收货口不够」？',
      promptEn: 'With the starting set-up (2 docks), how many "not enough store docks" issues are listed?',
      points: 20,
      tol: 0,
      expect: (s) => issueCount(base(s), ['store-dock']),
      hint: '在调度台「问题」列表里数',
      hintEn: 'count them in the Dispatch "Issues" list',
    },
    {
      id: 'q2',
      kind: 'number',
      unit: '个',
      prompt: '最少要几个收货口才不出现这条提醒？',
      promptEn: 'What is the fewest number of docks with no such warning?',
      points: 30,
      tol: 0,
      expect: minDocks,
      hint: '一个一个地加，每次都要等重新仿真完再看',
      hintEn: 'add one at a time and wait for each re-run',
    },
    {
      id: 'q3',
      kind: 'choice',
      prompt: '不加收货口，还有什么办法能减少「收货口不够」？',
      promptEn: 'Without adding docks, what else reduces "not enough store docks"?',
      choices: ABCD(
        ['降低门店服务水平', '关掉一部分冷链门', '多排收货员加快卸货，或者让配送车错峰到店', '把门店规模调大'],
        [
          'Lower the store service level',
          'Close some cold doors',
          'Schedule more receivers to unload faster, or stagger truck arrivals',
          'Make the store bigger',
        ],
      ),
      points: 20,
      expect: () => 'c',
      ...THINK,
    },
  ],
});

// —— 7 演练：港口拥堵 ——
const ex07start: Scenario = {
  title: '练习 7 · 演练：港口拥堵',
  titleEn: 'Exercise 7 · Drill: port congestion',
  gen: 'g3',
  seed: 1,
  load: 'normal',
  drill: 'portCongestion',
  time: 8 * 3600,
  camera: { preset: 'port' },
};
const serviceBand = (s: TeachState) => {
  const d = Math.abs(val(variant(s, 'none'), 'service') - val(base(s), 'service'));
  return d < 0.05 ? 'a' : d < 1 ? 'b' : 'c';
};
const ex07 = defineExercise({
  id: 'ex07',
  title: '演练：港口拥堵的影响与应对',
  titleEn: 'Drill: impact of and response to port congestion',
  level: 'core',
  minutes: 20,
  topics: ['扰动演练', '韧性', '安全库存', '提前期'],
  topicsEn: ['disruption drill', 'resilience', 'safety stock', 'lead time'],
  goals: '本周班轮晚到 6 天、之后 10 天堆场停留翻倍：量出提前期和库存怎么变，解释为什么门店服务水平几乎没受影响。',
  goalsEn:
    "This week's liner is 6 days late and yard dwell doubles for 10 days: measure how lead time and inventory change, and explain why the store's service level barely moves.",
  scenario: ex07start,
  readouts: ['seaLead', 'dwell', 'dcInv', 'service', 'freshRemain'],
  variants: (s) => [{ key: 'none', scenario: sim({ ...s, drill: 'none' }) }],
  steps: [
    {
      zh: '载入起始场景（演练「港口拥堵」）。记下练习面板「读数」里的海运提前期、配送中心库存、门店服务水平。',
      en: 'Load the starting scenario (drill "Port congestion"). Note "Ocean: order to DC", "DC stock" and the store service level in the Readouts.',
    },
    { zh: '顶栏「演练」换成「正常的一天」，等仿真跑完再记一遍。', en: 'Set the Drill to "A normal day", wait for the run, and note them again.' },
    {
      zh: '可以再到「对比与报告」→ 演练和预案库里输入一条港口罢工的通知，看启动预案前后的韧性得分。',
      en: 'Optionally, in "Comparison & reports" → drills and playbooks, enter a port-strike notice and compare the resilience score with and without the playbook.',
    },
  ],
  questions: [
    {
      id: 'q1',
      kind: 'number',
      unit: '天',
      prompt: '和正常的一天比，「海运：下单到进配送中心」多了几天？',
      promptEn: 'Compared with a normal day, how many days longer is "Ocean: order to DC"?',
      points: 25,
      tol: 0.03,
      expect: (s) => val(base(s), 'seaLead') - val(variant(s, 'none'), 'seaLead'),
      hint: '用演练时的减去正常的一天的',
      hintEn: 'subtract the normal-day figure from the drill figure',
    },
    {
      id: 'q2',
      kind: 'choice',
      prompt: '门店服务水平变了多少？',
      promptEn: 'How much did the store service level change?',
      choices: ABC(
        ['几乎没变（不到 0.05 个百分点）', '降了 0.05–1 个百分点', '降了 1 个百分点以上'],
        ['Hardly at all (less than 0.05 points)', 'Down 0.05–1 points', 'Down more than 1 point'],
      ),
      points: 25,
      expect: serviceBand,
      hint: '比一比两次的「门店服务水平」',
      hintEn: 'compare the two store service levels',
    },
    {
      id: 'q3',
      kind: 'number',
      unit: '天',
      prompt: '配送中心库存（天）变了多少？变少写负数。',
      promptEn: 'How did "DC stock" (days) change? Write a negative number for a drop.',
      points: 25,
      tol: 0.02,
      expect: (s) => val(base(s), 'dcInv') - val(variant(s, 'none'), 'dcInv'),
      hint: '演练时的减去正常的一天的，注意正负号',
      hintEn: 'drill minus normal day; mind the sign',
    },
    {
      id: 'q4',
      kind: 'choice',
      prompt: '港口晚了，门店为什么还能照常有货？',
      promptEn: 'The port is late, so why do the shelves stay stocked?',
      choices: ABCD(
        ['港口拥堵对本店没有影响', '门店不卖进口货', '配送中心和门店的库存顶住了晚到的几天（配送中心库存天数下降就是证据）', '改用了空运'],
        [
          'Port congestion does not affect this store',
          'The store sells no imported goods',
          'Inventory in the DC and store covered the late days (the drop in DC inventory days is the evidence)',
          'Goods switched to air freight',
        ],
      ),
      points: 25,
      expect: () => 'c',
      ...THINK,
    },
  ],
});

// —— 8 压力测试 ——
const LOADS4 = ['normal', 'peak', 'high', 'extreme'] as const;
const ex08start: Scenario = {
  title: '练习 8 · 压力测试',
  titleEn: 'Exercise 8 · Stress test',
  gen: 'g3',
  seed: 1,
  load: 'normal',
  drill: 'none',
  time: 3 * 3600,
  camera: { preset: 'overview' },
};
const ISSUE_CHOICES = [
  ['a', 'peak'],
  ['b', 'wait'],
  ['c', 'cutoff'],
  ['d', 'store-dock'],
] as const;
const topIssue = (s: TeachState) => {
  const b = boardOf(variant(s, 'extreme'));
  let best: string = 'a';
  let n = -1;
  for (const [id, code] of ISSUE_CHOICES) {
    const c = b.issues.filter((i) => i.code === code).length;
    if (c > n) [best, n] = [id, c];
  }
  return best;
};
const ex08 = defineExercise({
  id: 'ex08',
  title: '压力测试：从平常到极限，瓶颈在哪',
  titleEn: 'Stress test: from normal to extreme, where is the bottleneck',
  level: 'advanced',
  minutes: 30,
  topics: ['压力测试', '规模效应', '瓶颈识别', '产能'],
  topicsEn: ['stress testing', 'economies of scale', 'bottleneck finding', 'capacity'],
  goals: '把负荷从平常一路调到极限，记录车队、每箱成本和调度台的问题，找出最先吃紧的环节，解释每箱成本为什么反而下降。',
  goalsEn:
    'Step the load from normal to extreme, record fleet, cost per case and the Dispatch issues, find what gets tight first, and explain why cost per case falls.',
  scenario: ex08start,
  readouts: ['fleet', 'dcLabor', 'costPerCase', 'co2Local', 'arrivals'],
  variants: (s) => LOADS4.map((l) => ({ key: l, scenario: sim({ ...s, load: l }) })),
  steps: [
    {
      zh: '载入起始场景（负荷平常）。记下读数里的车队、配送中心工时、每箱成本、本地排放。',
      en: 'Load the starting scenario (normal load). Note the fleet, DC labour, cost per case and local emissions in the Readouts.',
    },
    {
      zh: '顶栏「负荷」依次换成「旺季」「高负荷」「极限」，每次等仿真跑完记一遍，并看调度台「问题」的种类。',
      en: 'Set the Load to "Peak season", "High load" and "Extreme" in turn; after each run note the readouts and the kinds of Dispatch issues.',
    },
    {
      zh: '可以问值班助手「整条链现在卡在哪一环」，再用调度台核对。',
      en: 'Optionally ask the duty assistant "where is the chain congested now" and check it against the Dispatch board.',
    },
  ],
  questions: [
    {
      id: 'q1',
      kind: 'number',
      unit: '辆',
      prompt: '「极限」负荷时，配送车队几辆？',
      promptEn: 'At "Extreme" load, how many trucks is the delivery fleet?',
      points: 20,
      tol: 0,
      expect: (s) => val(variant(s, 'extreme'), 'fleet'),
      ...LOOK_READOUT,
    },
    {
      id: 'q2',
      kind: 'number',
      unit: '美元',
      prompt: '「极限」负荷时，每箱的供应链成本是多少美元？',
      promptEn: 'At "Extreme" load, what is the supply-chain cost per case (USD)?',
      points: 20,
      tol: 0.006,
      expect: (s) => val(variant(s, 'extreme'), 'costPerCase'),
      ...LOOK_READOUT,
    },
    {
      id: 'q3',
      kind: 'choice',
      prompt: '「极限」负荷时，调度台「问题」里条数最多的是哪一类？',
      promptEn: 'At "Extreme" load, which kind of Dispatch issue appears most often?',
      choices: ABCD(
        ['高峰拥堵', '到早了', '赶不上分配', '门店收货口不够'],
        ['Rush-hour congestion (高峰拥堵)', 'Arrived early (到早了)', 'Missed the allocation (赶不上分配)', 'Not enough store docks (门店收货口不够)'],
      ),
      points: 30,
      expect: topIssue,
      hint: '负荷换成「极限」以后，在「问题」列表里按标题数一数',
      hintEn: 'after switching to Extreme, count the issue titles in the list',
    },
    {
      id: 'q4',
      kind: 'choice',
      prompt: '负荷从平常到极限，每箱成本为什么反而下降？',
      promptEn: 'Why does the cost per case fall as the load rises from normal to extreme?',
      choices: ABCD(
        ['运费降价了', '少算了人工', '配送中心、车队这些固定的投入被更多的箱数摊薄（规模效应）', '门店卖得少了'],
        [
          'Freight rates dropped',
          'Labour was left out',
          'Fixed resources such as the DC and fleet are spread over more cases (economies of scale)',
          'The store sold less',
        ],
      ),
      points: 30,
      expect: () => 'c',
      ...THINK,
    },
  ],
});

// —— 9 方案对比 ——
const GEN_ID = { g1: 'a', g2: 'b', g3: 'c' } as const;
const ex09start: Scenario = {
  title: '练习 9 · 方案对比',
  titleEn: 'Exercise 9 · Comparing schemes',
  gen: 'g1',
  seed: 1,
  load: 'normal',
  drill: 'none',
  time: 8 * 3600,
  camera: { preset: 'overview' },
};
const ex09 = defineExercise({
  id: 'ex09',
  title: '方案对比：上一代 / StoreX / StoreX 全链路',
  titleEn: 'Comparing schemes: previous generation / StoreX / StoreX Chain',
  level: 'core',
  minutes: 20,
  topics: ['供应链设计', '信息共享', '库存', '成本与排放'],
  topicsEn: ['supply-chain design', 'information sharing', 'inventory', 'cost and emissions'],
  goals: '三种方案各跑一遍，比较服务、库存、成本、排放，理解「只升级门店」和「整条链一起升级」的区别。',
  goalsEn:
    'Run all three schemes and compare service, inventory, cost and emissions, to see the difference between upgrading only the store and upgrading the whole chain.',
  scenario: ex09start,
  readouts: ['service', 'waste', 'dcInv', 'fleet', 'costPerCase', 'co2Local'],
  variants: (s) => (['g1', 'g2', 'g3'] as const).map((g) => ({ key: g, scenario: sim({ ...s, gen: g }) })),
  steps: [
    { zh: '载入起始场景（方案「上一代」），记下读数。', en: 'Load the starting scenario (Generation "Previous generation") and note the readouts.' },
    {
      zh: '方案依次换成「StoreX」「StoreX 全链路」，每次等仿真跑完再记。',
      en: 'Switch to "StoreX" and then "StoreX Chain", noting the readouts after each run.',
    },
    {
      zh: '「这次运行（18 周平均）」表的「比上一代」一列也能直接看出差别。',
      en: 'The "vs previous gen." column of the "This run (18-week average)" table shows the differences directly.',
    },
  ],
  questions: [
    {
      id: 'q1',
      kind: 'choice',
      prompt: '三种方案里「每箱的供应链成本」最低的是？',
      promptEn: 'Which scheme has the lowest supply-chain cost per case?',
      choices: ABC(['上一代', 'StoreX', 'StoreX 全链路'], ['Previous generation', 'StoreX', 'StoreX Chain']),
      points: 25,
      expect: (s) => {
        const c = (['g1', 'g2', 'g3'] as const).map((g) => [g, val(variant(s, g), 'costPerCase')] as const);
        return GEN_ID[c.reduce((a, b) => (b[1] < a[1] ? b : a))[0]];
      },
      ...LOOK_READOUT,
    },
    {
      id: 'q2',
      kind: 'number',
      unit: '天',
      prompt: '全链路比上一代，配送中心库存少了几天？',
      promptEn: 'How many days less DC inventory does the Chain scheme hold than the previous generation?',
      points: 25,
      tol: 0.05,
      expect: (s) => val(variant(s, 'g1'), 'dcInv') - val(variant(s, 'g3'), 'dcInv'),
      hint: '上一代的减去全链路的',
      hintEn: 'previous generation minus Chain',
    },
    {
      id: 'q3',
      kind: 'number',
      unit: '个百分点',
      prompt: 'StoreX（只升级门店）比上一代，门店生鲜损耗低了几个百分点？',
      promptEn: 'By how many percentage points is store fresh waste lower with StoreX (store upgrade only) than with the previous generation?',
      points: 25,
      tol: 0.03,
      expect: (s) => val(variant(s, 'g1'), 'waste') - val(variant(s, 'g2'), 'waste'),
      hint: '上一代的减去 StoreX 的',
      hintEn: 'previous generation minus StoreX',
    },
    {
      id: 'q4',
      kind: 'choice',
      prompt: '为什么只升级门店时配送中心库存几乎没变，全链路才明显降下来？',
      promptEn: 'Why does DC inventory hardly change when only the store is upgraded, but drop clearly with the whole chain?',
      choices: ABCD(
        [
          '配送中心的库存取决于上游怎么补货：全链路共享销售数据、生鲜越库、自动化配送中心，上游的补货才跟着变',
          '门店升级会增加配送中心的库存',
          '两种方案没有区别',
          '全链路少卖了货',
        ],
        [
          'DC inventory depends on how the upstream replenishes: the Chain shares sales data, cross-docks fresh goods and automates the DC, so upstream replenishment changes too',
          'A store upgrade increases DC inventory',
          'There is no difference between the schemes',
          'The Chain sells less',
        ],
      ),
      points: 25,
      expect: () => 'a',
      ...THINK,
    },
  ],
});

// —— 10 值班助手查原因 ——
const lateIssue = (s: TeachState) => boardOf(base(s)).issues.find((i) => i.code === 'late');
const ex10 = defineExercise({
  id: 'ex10',
  title: '值班助手查原因：问它，再用调度台核对',
  titleEn: 'Root cause with the duty assistant: ask, then verify on the Dispatch board',
  level: 'advanced',
  minutes: 25,
  topics: ['根因分析', '可审计的 AI', '人在回路', '数据核对'],
  topicsEn: ['root-cause analysis', 'auditable AI', 'human in the loop', 'data verification'],
  goals: '用值班助手找出今天迟到的那一趟和原因，再在调度台上核对它说的数字；理解助手为什么只「提议」、不「执行」。',
  goalsEn:
    "Use the duty assistant to find today's late trip and its cause, verify its numbers on the Dispatch board, and understand why the assistant only proposes and never executes.",
  scenario: {
    title: '练习 10 · 值班助手查原因',
    titleEn: 'Exercise 10 · Root cause with the duty assistant',
    gen: 'g3',
    seed: 1,
    load: 'normal',
    drill: 'none',
    time: 11 * 3600,
    camera: { preset: 'flagship' },
  },
  steps: [
    {
      zh: '载入起始场景（平常的一天，11 点）。在「值班助手」里问「现在哪些车晚了」，再问「晚得最多的那辆是啥原因」。',
      en: 'Load the starting scenario (a normal day, 11:00). Ask the duty assistant "which vehicles are late now", then "what caused the latest one".',
    },
    {
      zh: '打开「调度台」的「问题」列表，找到「迟到」（或「直送车迟到」）那一条，核对作业编号和晚了几分钟。',
      en: 'Open the Dispatch "Issues" list, find the entry titled 迟到 or 直送车迟到 (late), and check the job ID and how many minutes late it was.',
    },
    {
      zh: '再对助手说「直接把第一张建议卡批了」，看它怎么回答。',
      en: 'Then tell the assistant "approve the first recommendation card right away" and see how it answers.',
    },
  ],
  questions: [
    {
      id: 'q1',
      kind: 'text',
      prompt: '调度台「问题」里「迟到」（或「直送车迟到」）的那一趟，作业编号是？',
      promptEn: 'In the Dispatch issues, what is the job ID of the late trip (迟到 / 直送车迟到)?',
      points: 25,
      expect: (s) => lateIssue(s)?.ops[0] ?? '—',
      hint: '「迟到」（或「直送车迟到」）那一条的第一个编号',
      hintEn: 'the first ID in the late entry',
    },
    {
      id: 'q2',
      kind: 'number',
      unit: '分钟',
      prompt: '它晚了几分钟？',
      promptEn: 'How many minutes late was it?',
      points: 25,
      tol: 1,
      expect: (s) => Number(/晚 (\d+) 分钟/.exec(lateIssue(s)?.text ?? '')?.[1] ?? 0),
      hint: '看「迟到」（或「直送车迟到」）那一条的说明',
      hintEn: 'read the text of the late entry',
    },
    {
      id: 'q3',
      kind: 'choice',
      prompt: '让值班助手「直接把第一张建议卡批了」，它会怎么做？',
      promptEn: 'If you tell the assistant to "approve the first card right away", what does it do?',
      choices: ABCD(
        ['马上执行', '只准备一个待确认的提议，要有权限的人在界面里确认才执行', '拒绝回答任何问题', '把建议卡删掉'],
        [
          'Executes it immediately',
          'Prepares a proposal only; a person with the right role must confirm it in the UI before anything happens',
          'Refuses to answer anything',
          'Deletes the card',
        ],
      ),
      points: 25,
      expect: () => 'b',
      ...THINK,
    },
    {
      id: 'q4',
      kind: 'choice',
      prompt: '怎样判断助手的回答可信？',
      promptEn: "How can you tell whether the assistant's answer can be trusted?",
      choices: ABCD(
        ['回答越长越可信', '回答里的数字都标了出处（调度台、看板、仓储中心计划），可以逐个核对', '助手从不出错', '回答得越快越可信'],
        [
          'Longer answers are more trustworthy',
          'Every number is tied to a source (Dispatch board, KPI board, hub plans) that you can check one by one',
          'The assistant never makes mistakes',
          'Faster answers are more trustworthy',
        ],
      ),
      points: 25,
      expect: () => 'b',
      ...THINK,
    },
  ],
});

export const ALL_EXERCISES: readonly Exercise[] = [ex01, ex02, ex03, ex04, ex05, ex06, ex07, ex08, ex09, ex10];
export type { QSpec };
