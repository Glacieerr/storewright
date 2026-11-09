import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseScenario } from '../src/scenario/parse';
import { answerOk, EXERCISES, exerciseById, parseNum, PASS_RATIO, type Exercise, type TeachState } from '../src/teach';
import { specsOf } from '../src/teach/lab';
import { teachStateFor } from '../src/teach/run';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** tsx 的命令行（工作区里装在根目录的 node_modules） */
const TSX = createRequire(import.meta.url).resolve('tsx/cli');

/** 按参考答案填的答案（选择题取选项字母） */
function answersOf(ex: Exercise, st: TeachState): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const k of ex.key?.(st) ?? []) {
    const q = ex.questions.find((x) => x.id === k.id);
    if (!q) continue;
    out[k.id] = q.kind === 'choice' ? (k.answer.split('（')[0] as string) : q.kind === 'number' ? Number(k.answer) : k.answer;
  }
  return out;
}

/** 起始场景的状态（每道练习只算一次，几个测试共用） */
const starts = new Map<string, TeachState>();
function start(ex: Exercise): TeachState {
  let st = starts.get(ex.id);
  if (!st) starts.set(ex.id, (st = teachStateFor(ex, ex.scenario, {})));
  return st;
}

/** 做完设置任务以后的状态（参考答案按它算） */
function solved(ex: Exercise, answers: Record<string, string | number> = {}): TeachState {
  const st0 = start(ex);
  const target = ex.solution ? ex.solution(st0) : ex.scenario;
  return target === ex.scenario ? { ...st0, answers } : teachStateFor(ex, target, answers);
}

describe('教学沙盘 · 练习定义', () => {
  it('十道练习，编号连续、中英文齐全、每道满分 100', () => {
    expect(EXERCISES.map((e) => e.id)).toEqual(['ex01', 'ex02', 'ex03', 'ex04', 'ex05', 'ex06', 'ex07', 'ex08', 'ex09', 'ex10']);
    for (const ex of EXERCISES) {
      expect(ex.title && ex.titleEn && ex.goals && ex.goalsEn).toBeTruthy();
      expect(ex.topics.length).toBe(ex.topicsEn.length);
      expect(ex.steps.every((s) => s.zh && s.en)).toBe(true);
      expect(ex.questions.length).toBeGreaterThanOrEqual(2);
      expect(ex.questions.every((q) => q.prompt && q.promptEn && (q.kind !== 'choice' || (q.choices?.length ?? 0) >= 3))).toBe(true);
      const total = [...(ex.tasks ?? []), ...specsOf(ex.id)].reduce((a, x) => a + x.points, 0);
      expect(total, ex.id).toBe(100);
      expect(exerciseById(ex.id)).toBe(ex);
    }
  });

  it('起始场景和对照场景都是合法的场景文件', () => {
    for (const ex of EXERCISES) {
      expect(parseScenario(ex.scenario).errors, ex.id).toEqual([]);
      for (const v of ex.variants?.(ex.scenario) ?? []) expect(parseScenario(v.scenario).errors, `${ex.id}/${v.key}`).toEqual([]);
      expect(ex.scenario.exercise, '起始场景里不写 exercise（套用时不会再打开练习）').toBeUndefined();
    }
  });
});

describe('教学沙盘 · 批改', () => {
  it('按参考答案、做完设置任务：每道练习都是满分', { timeout: 120_000 }, () => {
    for (const ex of EXERCISES) {
      const key = solved(ex);
      const st = { ...key, answers: answersOf(ex, key) };
      const r = ex.check(st);
      expect(r.items.filter((i) => !i.ok).map((i) => `${ex.id}.${i.id} ${i.text}`)).toEqual([]);
      expect(r.score).toBe(r.max);
      expect(r.passed).toBe(true);
    }
  });

  it('答错、没做设置任务：扣分、不及格；同样的输入重新仿真结果一样', { timeout: 120_000 }, () => {
    for (const ex of EXERCISES) {
      const wrong = Object.fromEntries(ex.questions.map((q) => [q.id, q.kind === 'choice' ? 'z' : q.kind === 'number' ? -9999 : '不知道']));
      const a = ex.check({ ...start(ex), answers: wrong });
      expect(a.score, ex.id).toBe(0);
      expect(a.passed).toBe(false);
      // 确定性：抽两道（一道带 9 个对照场景）重新仿真一遍，批改结果一模一样
      if (ex.id === 'ex01' || ex.id === 'ex04') expect(ex.check(teachStateFor(ex, ex.scenario, wrong))).toEqual(a);
    }
  });

  it('设置任务：只改了一半不给分（练习 3：收货员只改早班）', { timeout: 60_000 }, () => {
    const ex = exerciseById('ex03') as Exercise;
    const half = { ...ex.scenario, facilities: { store: { staff: [{ key: 'recv', crew: { early: 1 } }] } } };
    const r = ex.check(teachStateFor(ex, half, {}));
    expect(r.items.find((i) => i.id === 't1')?.ok).toBe(false);
  });

  it('设置任务：门开多了不算「最少」（练习 4）', { timeout: 60_000 }, () => {
    const ex = exerciseById('ex04') as Exercise;
    const target = ex.solution?.(start(ex));
    const n = target?.facilities?.dc?.coldDoors as number;
    expect(n).toBeGreaterThanOrEqual(4);
    expect(n).toBeLessThanOrEqual(12);
    const more = { ...target, facilities: { ...target?.facilities, dc: { coldDoors: Math.min(12, n + 1) } } };
    expect(ex.check(teachStateFor(ex, more, {})).items.find((i) => i.id === 't1')?.ok).toBe(n === 12);
  });

  it('答案的写法：单位、千分位、全角、时刻都能认', () => {
    expect(parseNum('99.58%')).toBe(99.58);
    expect(parseNum('14,516 美元')).toBe(14516);
    expect(parseNum('−0.22')).toBe(-0.22);
    expect(parseNum('约 6 辆')).toBe(6);
    expect(parseNum('没有')).toBeUndefined();
    const q = { id: 'x', prompt: '', promptEn: '', kind: 'number' as const, points: 1, tol: 0.05, expect: () => 1, hint: '', hintEn: '' };
    expect(answerOk(q, 4.37, '4.40')).toBe(true);
    expect(answerOk(q, 4.37, '4.5')).toBe(false);
    expect(answerOk({ ...q, kind: 'text' }, 'DS-BEV-2', ' ds-bev-2 ')).toBe(true);
    expect(answerOk({ ...q, kind: 'text', format: 'time', tol: 1 }, '09:30', '9:31')).toBe(true);
    expect(answerOk({ ...q, kind: 'choice' }, 'b', 'B')).toBe(true);
    expect(PASS_RATIO).toBe(0.7);
  });
});

describe('教学沙盘 · 文档', () => {
  it('实验指导书、参考答案是按现在的练习生成的（改了练习要重新运行 manual --write、key --write）', () => {
    const doc = (f: string) => readFileSync(join(ROOT, 'docs/teaching', f), 'utf8');
    const zh = doc('lab-manual.md');
    const en = doc('lab-manual.en.md');
    const kz = doc('instructor/answer-key.md');
    const ke = doc('instructor/answer-key.en.md');
    for (const ex of EXERCISES) {
      for (const q of ex.questions) {
        expect(zh, `${ex.id}.${q.id}`).toContain(q.prompt);
        expect(en, `${ex.id}.${q.id}`).toContain(q.promptEn);
      }
      for (const st of ex.steps) expect(zh).toContain(st.zh);
      expect(kz).toContain(ex.title);
      expect(ke).toContain(ex.titleEn);
      expect(ex.background?.zh && ex.background.en && ex.think?.length, ex.id).toBeTruthy();
    }
  });
});

describe('教学沙盘 · 命令行', () => {
  const run = (args: string[]) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [TSX, join(ROOT, 'src/cli/teach.ts'), ...args], { cwd: ROOT, encoding: 'utf8' }) };
    } catch (e) {
      const err = e as { status: number; stdout: string };
      return { code: err.status, out: err.stdout };
    }
  };

  it('check：全对退出码 0，答错退出码 1；也认练习面板导出的文件', { timeout: 120_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'teach-'));
    const ex = exerciseById('ex01') as Exercise;
    const good = answersOf(ex, solved(ex));
    writeFileSync(join(dir, 'good.json'), JSON.stringify({ exercise: 'ex01', scenario: ex.scenario, answers: good }));
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ q1: 1, q2: 2 }));
    const ok = run(['check', 'ex01', '--answers', join(dir, 'good.json'), '--json']);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out).score).toBe(100);
    const bad = run(['check', 'ex01', '--answers', join(dir, 'bad.json')]);
    expect(bad.code).toBe(1);
    writeFileSync(join(dir, 'broken.json'), JSON.stringify({ gen: 'g9' }));
    expect(run(['check', 'ex01', '--answers', join(dir, 'bad.json'), '--scenario', join(dir, 'broken.json')]).code).toBe(2);
  });
});
