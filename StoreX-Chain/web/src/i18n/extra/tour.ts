/**
 * English UI strings for the tour feature, keyed by the Chinese source text (merged into ../en.ts).
 * Each feature keeps its own file so parallel work does not collide in one big dictionary.
 * The journey text itself (titles, facts, notes) is bilingual data from src/tour/container.ts.
 */
export const EN_TOUR: Record<string, string> = {
  一个集装箱从船到货架: 'One container, ship to shelf',
  '演示导览：跟着一个本店的集装箱，从班轮、港口堆场、物流园配送中心一路到门店货架（约 1 分钟，← → 翻页，Esc 退出）':
    "Guided tour: follow one of the store's containers from the liner and the port yard through the logistics-park DC to the store shelf (about 1 minute; ← → to step, Esc to exit)",
  '演示导览：一个集装箱从船到货架': 'Guided tour: one container, ship to shelf',
  仿真记录: 'Simulation record',
  '这一段的时刻、门、车都来自仿真和作业计划的记录，动画里看得到': 'Times, doors and vehicles in this step come from the simulation and operating-plan records, and you can see it in the animation',
  按规则估算: 'Estimated by rule',
  '这一段按规则推出来（例如方案的平均停留、先进先出配车），不是逐件的记录': "Derived by a rule (for example the scheme's average dwell or first-in, first-out truck assignment), not an item-level record",
  今天的同类作业: 'Same step, today',
  '这个箱的这一段不在动画这一天：用今天同一个环节的另一件货演示': 'This step of the box falls outside the animated day, so another load doing the same step today stands in',
  '第 {i} / {n} 段': 'Step {i} / {n}',
  导览结束: 'Tour complete',
  退出导览: 'Exit tour',
  '退出导览（Esc）': 'Exit tour (Esc)',
  各段: 'Steps',
  '跳过约 {d} 天': 'Skipping about {d} days',
  '动画时刻 {clock}': 'Animation time {clock}',
  上一段: 'Previous',
  继续: 'Resume',
  下一段: 'Next',
  '从船到货架，走完了': 'Ship to shelf: done',
  复制这个场景的链接: 'Copy a link to this scenario',
  做一道相关练习: 'Try a related exercise',
  再看一遍: 'Watch again',
  '这一趟 {n} 段里 {r} 段直接来自仿真记录。': '{r} of the {n} steps on this run come straight from simulation records.',
  '极限负荷（压力测试那一档）那一天，本店的箱当天就从堆场提走、送进配送中心，来自仿真记录的段更多。':
    "On the Extreme day (the stress-test load level), the store's container leaves the port yard and reaches the DC the same day, so more steps come straight from simulation records.",
  换到极限负荷再看: 'Watch it on the Extreme day',
  '这一天里找不到可以跟的本店的箱、班列或空运货（换一组仿真或换个负荷再试）。': 'No store container, train box or air cargo to follow on this day (try another run or load level).',
  链接已复制: 'Link copied',
  '复制不了，请手动复制：': "Couldn't copy it; copy it by hand:",
  分享链接: 'Share link',
  '本店班轮的泊位 · 岸桥在这里卸箱': "The store liner's berth · quay cranes discharge here",
  '本店的箱 {box}': 'Store container {box}',
  在这里上架: 'Shelved here',
};
