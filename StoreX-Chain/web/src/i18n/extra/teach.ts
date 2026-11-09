/**
 * English UI strings for the teach feature, keyed by the Chinese source text (merged into ../en.ts).
 * Each feature keeps its own file so parallel work does not collide in one big dictionary.
 * (Exercise content itself — titles, steps, questions — carries its own English in src/teach/exercises.ts.)
 */
export const EN_TEACH: Record<string, string> = {
  已通过: 'Passed',
  得分: 'Score',
  未做: 'Not done',
  '约 {n} 分钟': 'about {n} min',
  '给物流、供应链、工业工程课程用的 10 道练习：每道有起始场景、操作步骤和问题，点「检查答案」自动批改（得分达到 {pass}% 算通过）。数据是合成的，仅供教学。':
    'Ten exercises for logistics, supply-chain and industrial-engineering courses. Each has a starting scenario, steps and questions; "Check answers" grades them automatically ({pass}% passes). Synthetic data, for teaching only.',
  '已通过 {done} / {n} 道': '{done} of {n} passed',
  '老师：命令行 npm run teach 可以批改学生导出的作答、生成参考答案；教学说明见 docs/teaching/。':
    'Instructors: the command line npm run teach grades exported answers and prints the answer key; see docs/teaching/.',
  全部练习: 'All exercises',
  目标: 'Goal',
  载入起始场景: 'Load starting scenario',
  '读数（这次仿真，和左侧「这次运行」表同一份数据）': 'Readouts (this run; same data as the "This run" table on the left)',
  设置任务: 'Set-up tasks',
  '{n} 分': '{n} pts',
  问题: 'Questions',
  检查答案: 'Check answers',
  导出我的作答: 'Export my answers',
  '上次最好：{best} / {max}': 'Best so far: {best} / {max}',
  仿真还没跑完: 'The simulation has not finished yet',
  '正在载入…': 'Loading…',
  '对照场景 {key} 没跑出来': 'The comparison run {key} did not finish',
  '得分 {score} / {max}': 'Score {score} / {max}',
  通过: 'Passed',
  '没通过（及格线 {pass}%）': 'Not passed (pass mark {pass}%)',
  '正在批改…（还要跑 {n} 个对照场景）': 'Grading… ({n} comparison runs to go)',
  '正在批改…': 'Grading…',
  '仿真还没跑完，稍等再点「检查答案」': 'The simulation has not finished; wait a moment and click "Check answers" again',
  '批改出错：{err}': 'Grading failed: {err}',
  '已导出 {file}：交给老师，用 npm run teach -- check {id} --answers {file} 批改':
    'Exported {file}: hand it in; the instructor grades it with npm run teach -- check {id} --answers {file}',
  '%': '%',
  背景知识: 'Background',
  '课后讨论（不批改）': 'Discussion (not graded)',
};
