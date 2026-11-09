import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kpi } from '../analysis/kpi';
import { parseScenario } from '../scenario/parse';
import type { Scenario } from '../scenario/types';
import { EXERCISES, exerciseById, PASS_RATIO, type Exercise } from '../teach';
import { specsOf } from '../teach/lab';
import { teachStateFor } from '../teach/run';

/**
 * 运营教学沙盘的命令行：列出练习、打印题目、批改学生交的作答、生成教师参考答案。
 *   npm run teach -- list
 *   npm run teach -- show ex03 [--en]
 *   npm run teach -- check ex03 --answers answers.json [--scenario my.json] [--json] [--en]
 *        answers.json 可以是 { "q1": 6, … }，也可以是练习面板「导出我的作答」的文件（{ exercise, scenario, answers }）
 *   npm run teach -- key [ex03] [--write]   参考答案（--write 写 docs/teaching/instructor/answer-key.md 和 .en.md）
 *   npm run teach -- manual [--write]        学生实验指导书（--write 写 docs/teaching/lab-manual.md 和 .en.md）
 * 批改按场景重新仿真（同样的场景每次结果一样），没及格退出码 1；文件读不了、场景不合法退出码 2。
 */
const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'list';
const flag = (k: string) => argv.includes(`--${k}`);
const opt = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const EN = flag('en');
const L = (zh: string, en: string) => (EN ? en : zh);
const LEVEL: Record<string, [string, string]> = { intro: ['入门', 'Intro'], core: ['基础', 'Core'], advanced: ['进阶', 'Advanced'] };

function need(id: string | undefined): Exercise {
  const ex = id ? exerciseById(id) : undefined;
  if (!ex) {
    process.stderr.write(L(`找不到练习 ${id ?? ''}（ex01–ex10）\n`, `No exercise ${id ?? ''} (ex01–ex10)\n`));
    process.exit(2);
  }
  return ex;
}

function show(ex: Exercise): string {
  const out: string[] = [];
  out.push(
    `${ex.id} · ${L(ex.title, ex.titleEn)}`,
    `${L('难度', 'Level')}: ${L(...(LEVEL[ex.level] as [string, string]))} · ${L('约', 'about')} ${ex.minutes} ${L('分钟', 'min')} · ${L(ex.topics.join('、'), ex.topicsEn.join(', '))}`,
    '',
    L(ex.goals, ex.goalsEn),
    '',
  );
  ex.steps.forEach((s, i) => out.push(`${i + 1}. ${L(s.zh, s.en)}`));
  if (ex.tasks?.length) {
    out.push('', L('设置任务', 'Set-up tasks') + ':');
    for (const t of ex.tasks) out.push(`  [${t.id}] ${L(t.text, t.textEn)} (${t.points} ${L('分', 'pts')})`);
  }
  out.push('', L('问题', 'Questions') + ':');
  for (const q of ex.questions) {
    out.push(`  [${q.id}] ${L(q.prompt, q.promptEn)}${q.unit ? ` (${L(q.unit, q.unitEn ?? q.unit)})` : ''}`);
    for (const c of q.choices ?? []) out.push(`       ${c.id}. ${L(c.text, c.textEn)}`);
  }
  if (ex.readouts?.length) out.push('', `${L('读数', 'Readouts')}: ${ex.readouts.map((k) => kpi(k).label).join('、')}`);
  return out.join('\n');
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    process.stderr.write(L(`读不了 ${path}：${String(e)}\n`, `Cannot read ${path}: ${String(e)}\n`));
    process.exit(2);
  }
}

function scenarioArg(ex: Exercise, fromAnswers?: unknown): Scenario {
  const raw = opt('scenario') ? readJson(opt('scenario') as string) : fromAnswers;
  if (raw === undefined) return ex.scenario;
  const r = parseScenario(raw);
  if (!r.scenario) {
    process.stderr.write(L('场景文件不合法：\n', 'Invalid scenario file:\n') + r.errors.map((e) => `  - ${e}\n`).join(''));
    process.exit(2);
  }
  return r.scenario;
}

/** 参考答案：起始场景下（设置任务按要求做完的话，题目的数也按要求的设置算） */
export function keyOf(ex: Exercise) {
  const st0 = teachStateFor(ex, ex.scenario, {});
  const target = ex.solution ? ex.solution(st0) : ex.scenario;
  const st = target === ex.scenario ? st0 : teachStateFor(ex, target, {});
  return ex.key ? ex.key(st) : [];
}

function keyMarkdown(en: boolean): string {
  const T = (zh: string, e: string) => (en ? e : zh);
  const out: string[] = [
    T('# 教师参考答案', '# Instructor answer key'),
    '',
    T(
      '由 `npm run teach -- key --write` 从仿真算出（默认区域、种子 1；仿真是确定的，任何电脑上一样）。批改用的是同一份数：数字题按题目里的容差、选择题按选项、设置任务按学生交的场景重新仿真后检查。',
      "Computed from the simulation by `npm run teach -- key --write` (default region, seed 1; the simulation is deterministic, so every computer gets the same numbers). Grading uses the same numbers: number questions within the stated tolerance, choices by option, and set-up tasks by re-running the student's scenario.",
    ),
    '',
    T(
      `每道练习满分 100，得分达到 ${PASS_RATIO * 100}% 算通过。数据是合成的，仅供教学。`,
      `Each exercise is worth 100 points; ${PASS_RATIO * 100}% passes. Synthetic data, for teaching only.`,
    ),
    '',
  ];
  for (const ex of EXERCISES) {
    out.push(`## ${ex.id} · ${en ? ex.titleEn : ex.title}`, '');
    const key = keyOf(ex);
    out.push(T('| 题 | 参考答案 | 分值 | 容差 |', '| Item | Answer | Points | Tolerance |'), '|---|---|---:|---|');
    for (const t of ex.tasks ?? []) out.push(`| ${t.id} | ${en ? t.textEn : t.text} | ${t.points} | — |`);
    for (const q of ex.questions) {
      const k = key.find((x) => x.id === q.id)?.answer ?? '';
      const choice = q.choices?.find((c) => k.startsWith(c.id));
      const ans = choice ? `${choice.id}. ${en ? choice.textEn : choice.text}` : `${k}${q.unit ? ` ${en ? (q.unitEn ?? q.unit) : q.unit}` : ''}`;
      const spec = specsOf(ex.id).find((x) => x.id === q.id);
      const tol = spec?.format === 'time' ? `± ${spec.tol ?? 1} min` : spec?.kind === 'number' ? `± ${spec.tol ?? 0}` : '—';
      out.push(`| ${q.id} | ${ans.replace(/\|/g, '\\|')} | ${spec?.points ?? ''} | ${tol} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

const GEN_T: Record<string, [string, string]> = { g1: ['上一代', 'Previous generation'], g2: ['StoreX', 'StoreX'], g3: ['StoreX 全链路', 'StoreX Chain'] };
const LOAD_T: Record<string, [string, string]> = {
  normal: ['平常', 'Normal'],
  peak: ['旺季', 'Peak season'],
  high: ['高负荷', 'High load'],
  extreme: ['极限', 'Extreme'],
};
const DRILL_T: Record<string, [string, string]> = {
  none: ['正常的一天', 'A normal day'],
  portCongestion: ['港口拥堵', 'Port congestion'],
  airportClosed: ['机场关闭', 'Airport closed'],
  highwayClosed: ['高速封闭', 'Motorway closed'],
  supplierOutage: ['供应商停产', 'Supplier outage'],
  demandSurge: ['需求突增', 'Demand surge'],
};

/** 起始场景写成一句话 */
function scenarioText(sc: Scenario, en: boolean): string {
  const T = (x: [string, string] | undefined, d: string) => (x ? x[en ? 1 : 0] : d);
  const parts = [
    `${en ? 'Generation' : '方案'} ${T(GEN_T[sc.gen ?? 'g3'], sc.gen ?? 'g3')}`,
    `${en ? 'Load' : '负荷'} ${T(LOAD_T[sc.load ?? 'normal'], sc.load ?? 'normal')}`,
    `${en ? 'Drill' : '演练'} ${T(DRILL_T[sc.drill ?? 'none'], sc.drill ?? 'none')}`,
  ];
  const f = sc.facilities;
  if (f?.store?.size !== undefined) parts.push(en ? `store size ${f.store.size} (hypermarket)` : `综合店规模 ${f.store.size}（超大卖场）`);
  if (f?.store?.docks !== undefined) parts.push(en ? `${f.store.docks} store receiving docks` : `综合店收货口 ${f.store.docks} 个`);
  if (f?.dc?.coldDoors !== undefined) parts.push(en ? `${f.dc.coldDoors} cold dock doors` : `冷链月台门 ${f.dc.coldDoors} 樘`);
  if (sc.time !== undefined)
    parts.push(
      `${en ? 'from' : '从'} ${String(Math.floor(sc.time / 3600)).padStart(2, '0')}:${String(Math.floor((sc.time % 3600) / 60)).padStart(2, '0')}${en ? '' : ' 开始'}`,
    );
  return parts.join(en ? ', ' : '，');
}

/** 实验指导书（学生用）：按练习定义和背景知识生成，和网页、命令行用的是同一份内容 */
function manualMarkdown(en: boolean): string {
  const T = (zh: string, e: string) => (en ? e : zh);
  const out: string[] = [
    T('# 运营教学沙盘 · 学生实验指导书', '# Operations teaching sandbox · Student lab manual'),
    '',
    T(
      '> 本文件由 `npm run teach -- manual --write` 按练习定义生成（和网页练习面板、批改用的是同一份内容）。数据全是合成的，仅供教学，不代表任何真实企业；本项目与任何零售商、企业无隶属关系。',
      '> Generated by `npm run teach -- manual --write` from the exercise definitions (the same content as the web panel and the grader). All data is synthetic and for teaching only; it represents no real company. This project is not affiliated with any retailer or company.',
    ),
    '',
    T('## 怎么做练习', '## How to work through an exercise'),
    '',
    T(
      '1. 打开孪生（在线演示或本地运行，见 [README](README.md)），点顶栏的「练习」，选一道练习。\n2. 点「载入起始场景」：方案、负荷、演练、设施和镜头都会设好。\n3. 按步骤操作，在界面里找到数字，填进问题里（数字按界面上显示的小数位填，单位不用写）。\n4. 点「检查答案」看哪里对、哪里不对（只给提示，不给答案），可以改了再查。\n5. 点「导出我的作答」，把 `exNN-answers.json` 交给老师；老师用命令行批改，分数和网页上一样。',
      '1. Open the twin (online demo or local, see the [README](README.en.md)), click "Exercises" in the top bar and pick one.\n2. Click "Load starting scenario": scheme, load, drill, facilities and camera are set for you.\n3. Follow the steps, find the numbers in the interface and enter them (as many decimals as shown; no units).\n4. Click "Check answers" to see what is right and what is not (hints only, no answers); fix and check again.\n5. Click "Export my answers" and hand in `exNN-answers.json`; your instructor grades it on the command line with the same score as the web page.',
    ),
    '',
    T(
      '**界面里的位置**：顶栏（方案、负荷、演练、运行）· 左侧「这次运行（18 周平均）」表（18 周的日平均，「比上一代」一列）· 「调度台」（动画那一天的作业：上方的指标瓦片、「问题」列表）· 右侧「设施监控」→「管理」（设施管理：设备、门数、人员排班）· 「值班助手」· 练习面板的「读数」区（这道练习要用的指标）。',
      '**Where things are**: top bar (scheme, load, drill, run) · "This run (18-week average)" table on the left (18-week daily averages, "vs previous generation" column) · Dispatch board (jobs of the animated day: tiles at the top, Issues list) · Facility monitor on the right → "Admin" (equipment, doors, staff schedule) · Duty assistant · the Readouts area of the exercise panel (the indicators this exercise needs).',
    ),
    '',
    T(
      `**评分**：每道练习满分 100，达到 ${PASS_RATIO * 100}% 算通过。数字题有容差（写在参考答案里），选择题只有一个正确选项，设置任务按你导出的场景重新仿真检查。`,
      `**Grading**: each exercise is worth 100 points; ${PASS_RATIO * 100}% passes. Number questions allow a tolerance, choice questions have one correct option, and set-up tasks are checked by re-running the scenario you export.`,
    ),
    '',
  ];
  for (const ex of EXERCISES) {
    const n = Number(ex.id.slice(2));
    out.push(`## ${T('练习', 'Exercise')} ${n} · ${en ? ex.titleEn : ex.title}`, '');
    out.push(
      `${T('难度', 'Level')}：${T(...(LEVEL[ex.level] as [string, string]))} · ${T('约', 'about')} ${ex.minutes} ${T('分钟', 'min')} · ${en ? ex.topicsEn.join(', ') : ex.topics.join('、')}`.replace(
        '：',
        en ? ': ' : '：',
      ),
      '',
    );
    out.push(`**${T('学习目标', 'Goal')}** ${en ? ex.goalsEn : ex.goals}`, '');
    if (ex.background) out.push(`**${T('背景知识', 'Background')}** ${en ? ex.background.en : ex.background.zh}`, '');
    out.push(
      `**${T('起始场景', 'Starting scenario')}** ${scenarioText(ex.scenario, en)}${T('（练习面板里点「载入起始场景」）。', ' (click "Load starting scenario" in the exercise panel).')}`,
      '',
    );
    out.push(`**${T('步骤', 'Steps')}**`, '');
    ex.steps.forEach((st, i) => out.push(`${i + 1}. ${en ? st.en : st.zh}`));
    out.push('');
    if (ex.tasks?.length) {
      out.push(`**${T('设置任务', 'Set-up tasks')}**`, '');
      for (const t of ex.tasks)
        out.push(`- ${en ? t.textEn : t.text}（${t.points} ${T('分', 'pts')}）`.replace('（', en ? ' (' : '（').replace('）', en ? ')' : '）'));
      out.push('');
    }
    out.push(`**${T('问题', 'Questions')}**`, '');
    ex.questions.forEach((q, i) => {
      out.push(
        `${i + 1}. ${en ? q.promptEn : q.prompt}${q.unit ? `（${en ? (q.unitEn ?? q.unit) : q.unit}）`.replace('（', en ? ' (' : '（').replace('）', en ? ')' : '）') : ''}`,
      );
      for (const c of q.choices ?? []) out.push(`   - ${c.id.toUpperCase()}. ${en ? c.textEn : c.text}`);
    });
    out.push('');
    out.push(
      `**${T('要交的东西', 'Hand in')}** ${T(`练习面板「导出我的作答」得到的 \`${ex.id}-answers.json\`；老师要求的话，再写 150–300 字的分析，回答下面的一道讨论题。`, `\`${ex.id}-answers.json\` from "Export my answers"; if your instructor asks, a 150–300-word analysis answering one of the discussion questions below.`)}`,
      '',
    );
    if (ex.think?.length) {
      out.push(`**${T('课后讨论（不批改）', 'Discussion (not graded)')}**`, '');
      for (const x of ex.think) out.push(`- ${en ? x.en : x.zh}`);
      out.push('');
    }
  }
  return out.join('\n');
}

async function main(): Promise<void> {
  if (cmd === 'list') {
    for (const ex of EXERCISES)
      process.stdout.write(
        `${ex.id}  ${L(...(LEVEL[ex.level] as [string, string])).padEnd(EN ? 8 : 4)}  ${String(ex.minutes).padStart(2)} ${L('分钟', 'min')}  ${L(ex.title, ex.titleEn)}\n`,
      );
    return;
  }
  if (cmd === 'show') {
    process.stdout.write(show(need(argv[1])) + '\n');
    return;
  }
  if (cmd === 'check') {
    const ex = need(argv[1]);
    const file = opt('answers');
    const raw = file ? (readJson(file) as Record<string, unknown>) : {};
    // 练习面板导出的文件：{ exercise, scenario, answers }
    const exported = raw && typeof raw === 'object' && 'answers' in raw ? raw : undefined;
    if (exported && typeof exported.exercise === 'string' && exported.exercise !== ex.id)
      process.stderr.write(
        L(`提醒：作答文件是 ${exported.exercise} 的，按 ${ex.id} 批改\n`, `Note: the answers file is for ${exported.exercise}; grading as ${ex.id}\n`),
      );
    const answers = ((exported ? exported.answers : raw) ?? {}) as Record<string, string | number>;
    const scenario = scenarioArg(ex, exported?.scenario);
    const st = teachStateFor(ex, scenario, answers);
    const r = ex.check(st);
    if (flag('json')) process.stdout.write(JSON.stringify({ exercise: ex.id, ...r }, null, 2) + '\n');
    else {
      process.stdout.write(`${ex.id} · ${L(ex.title, ex.titleEn)}\n`);
      for (const it of r.items) process.stdout.write(`  ${EN ? it.textEn : it.text}  (${it.points})\n`);
      process.stdout.write(
        L(
          `得分 ${r.score} / ${r.max}，${r.passed ? '通过' : '没通过'}（及格线 ${PASS_RATIO * 100}%）\n`,
          `Score ${r.score} / ${r.max}, ${r.passed ? 'passed' : 'not passed'} (pass mark ${PASS_RATIO * 100}%)\n`,
        ),
      );
    }
    process.exitCode = r.passed ? 0 : 1;
    return;
  }
  if (cmd === 'manual') {
    const dir = fileURLToPath(new URL('../../docs/teaching/', import.meta.url));
    if (flag('write')) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}lab-manual.md`, manualMarkdown(false) + '\n');
      writeFileSync(`${dir}lab-manual.en.md`, manualMarkdown(true) + '\n');
      process.stdout.write(L(`已写 ${dir}lab-manual.md 和 lab-manual.en.md\n`, `Wrote ${dir}lab-manual.md and lab-manual.en.md\n`));
    } else process.stdout.write(manualMarkdown(EN) + '\n');
    return;
  }
  if (cmd === 'key') {
    const id = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
    if (flag('write')) {
      const dir = fileURLToPath(new URL('../../docs/teaching/instructor/', import.meta.url));
      mkdirSync(dirname(`${dir}x`), { recursive: true });
      writeFileSync(`${dir}answer-key.md`, keyMarkdown(false) + '\n');
      writeFileSync(`${dir}answer-key.en.md`, keyMarkdown(true) + '\n');
      process.stdout.write(L(`已写 ${dir}answer-key.md 和 answer-key.en.md\n`, `Wrote ${dir}answer-key.md and answer-key.en.md\n`));
      return;
    }
    for (const ex of id ? [need(id)] : EXERCISES) {
      process.stdout.write(`${ex.id} · ${L(ex.title, ex.titleEn)}\n`);
      for (const k of keyOf(ex)) process.stdout.write(`  ${k.id}: ${k.answer}\n`);
    }
    return;
  }
  process.stderr.write(
    L(
      '用法：npm run teach -- list | show exNN | check exNN --answers a.json [--scenario s.json] [--json] | key [exNN] [--write] | manual [--write]\n',
      'Usage: npm run teach -- list | show exNN | check exNN --answers a.json [--scenario s.json] [--json] | key [exNN] [--write] | manual [--write]\n',
    ),
  );
  process.exitCode = 2;
}

void main();
