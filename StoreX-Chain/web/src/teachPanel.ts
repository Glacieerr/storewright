import './teach.css';
import { kpi } from '../../src/analysis/kpi';
import type { Scenario } from '../../src/scenario/types';
import { EXERCISES, exerciseById, PASS_RATIO, type CheckResult, type Exercise, type TeachRun, type TeachState } from '../../src/teach';
import { appApi, whenApp } from './appBus';
import { isEn, t } from './i18n';

/**
 * 教学沙盘的练习面板（右侧抽屉里，main.ts 第一次打开时动态加载）：练习列表 → 一道练习的目标、步骤、读数、设置任务、问题 →
 * 「检查答案」（按场景重新仿真对照场景，批改和命令行 npm run teach 一样）→「导出我的作答」（给老师用命令行批改）。
 * 进度存在本机浏览器里（读写失败就不存，不影响使用）。
 * Teaching-sandbox panel: exercise list, one exercise (goals, steps, readouts, tasks, questions), auto-check and export.
 */
const KEY = 'storex-chain-teach';
interface Progress {
  best: number;
  max: number;
  passed: boolean;
  answers: Record<string, string>;
  at: string;
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const L = (zh: string, en: string) => (isEn() ? en : zh);
const LEVEL: Record<Exercise['level'], [string, string]> = { intro: ['入门', 'Intro'], core: ['基础', 'Core'], advanced: ['进阶', 'Advanced'] };

function loadAll(): Record<string, Progress> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Progress>;
  } catch {
    return {};
  }
}
function save(id: string, p: Progress): void {
  try {
    const all = loadAll();
    all[id] = p;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* 存不了（隐私模式等）就不存 */
  }
}

let host: HTMLElement | undefined;
let open: Exercise | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;

export function mountTeachPanel(el: HTMLElement): void {
  host = el;
  host.classList.add('tp');
  renderList();
}

/** 打开一道练习（场景里写了 exercise、或欢迎卡点「做一道练习」时调用） */
export function openExercise(id: string): void {
  const ex = exerciseById(id);
  if (!host) return;
  if (!ex) {
    renderList();
    return;
  }
  renderExercise(ex);
}

function stopTimer(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

function renderList(): void {
  if (!host) return;
  stopTimer();
  open = undefined;
  const all = loadAll();
  const cards = EXERCISES.map((ex) => {
    const p = all[ex.id];
    const badge = p
      ? p.passed
        ? `<span class="tp-badge ok">${t('已通过')} · ${p.best}</span>`
        : `<span class="tp-badge">${t('得分')} ${p.best}</span>`
      : `<span class="tp-badge none">${t('未做')}</span>`;
    return `<button type="button" class="tp-card" data-ex="${ex.id}">
      <span class="tp-card-top"><b>${ex.id.replace('ex', '')} · ${esc(L(ex.title, ex.titleEn))}</b>${badge}</span>
      <span class="tp-meta">${L(...LEVEL[ex.level])} · ${t('约 {n} 分钟', { n: ex.minutes })} · ${esc(L(ex.topics.join('、'), ex.topicsEn.join(', ')))}</span>
    </button>`;
  });
  const done = EXERCISES.filter((ex) => all[ex.id]?.passed).length;
  host.innerHTML = `<p class="tp-intro">${t('给物流、供应链、工业工程课程用的 10 道练习：每道有起始场景、操作步骤和问题，点「检查答案」自动批改（得分达到 {pass}% 算通过）。数据是合成的，仅供教学。', { pass: PASS_RATIO * 100 })}</p>
    <p class="tp-progress">${t('已通过 {done} / {n} 道', { done, n: EXERCISES.length })}</p>
    <div class="tp-list">${cards.join('')}</div>
    <p class="tp-note">${t('老师：命令行 npm run teach 可以批改学生导出的作答、生成参考答案；教学说明见 docs/teaching/。')}</p>`;
  for (const b of host.querySelectorAll<HTMLButtonElement>('[data-ex]')) b.onclick = () => openExercise(b.dataset.ex as string);
}

function questionHtml(ex: Exercise, saved: Record<string, string>): string {
  return ex.questions
    .map((q, i) => {
      const v = saved[q.id] ?? '';
      const label = `<span class="tp-qn">${i + 1}</span>${esc(L(q.prompt, q.promptEn))}`;
      if (q.kind === 'choice')
        return `<fieldset class="tp-q" data-q="${q.id}"><legend>${label}</legend>${(q.choices ?? [])
          .map(
            (c) =>
              `<label class="tp-choice"><input type="radio" name="tp-${q.id}" value="${c.id}"${v === c.id ? ' checked' : ''}><span><b>${c.id.toUpperCase()}</b> ${esc(L(c.text, c.textEn))}</span></label>`,
          )
          .join('')}</fieldset>`;
      return `<label class="tp-q" data-q="${q.id}"><span class="tp-qlabel">${label}</span><span class="tp-input"><input type="text" inputmode="${q.kind === 'number' ? 'decimal' : 'text'}" name="tp-${q.id}" value="${esc(v)}" autocomplete="off" spellcheck="false">${q.unit ? `<small>${esc(L(q.unit, q.unitEn ?? q.unit))}</small>` : ''}</span></label>`;
    })
    .join('');
}

function answersOf(ex: Exercise): Record<string, string> {
  const out: Record<string, string> = {};
  if (!host) return out;
  for (const q of ex.questions) {
    if (q.kind === 'choice') {
      const c = host.querySelector<HTMLInputElement>(`input[name="tp-${q.id}"]:checked`);
      if (c) out[q.id] = c.value;
    } else {
      const v = host.querySelector<HTMLInputElement>(`input[name="tp-${q.id}"]`)?.value.trim();
      if (v) out[q.id] = v;
    }
  }
  return out;
}

function renderExercise(ex: Exercise): void {
  if (!host) return;
  stopTimer();
  open = ex;
  const p = loadAll()[ex.id];
  const saved = p?.answers ?? {};
  host.innerHTML = `<button type="button" class="tp-back">← ${t('全部练习')}</button>
    <h3 class="tp-title">${ex.id.replace('ex', '')} · ${esc(L(ex.title, ex.titleEn))}</h3>
    <p class="tp-meta">${L(...LEVEL[ex.level])} · ${t('约 {n} 分钟', { n: ex.minutes })} · ${esc(L(ex.topics.join('、'), ex.topicsEn.join(', ')))}</p>
    <p class="tp-goal"><b>${t('目标')}</b> ${esc(L(ex.goals, ex.goalsEn))}</p>
    ${ex.background ? `<details class="tp-bg"><summary>${t('背景知识')}</summary><p>${esc(L(ex.background.zh, ex.background.en))}</p></details>` : ''}
    <button type="button" class="tp-primary" data-act="load">${t('载入起始场景')}</button>
    <ol class="tp-steps">${ex.steps.map((s) => `<li>${esc(L(s.zh, s.en))}</li>`).join('')}</ol>
    ${ex.readouts?.length ? `<section class="tp-readouts" aria-live="polite"><h4>${t('读数（这次仿真，和左侧「这次运行」表同一份数据）')}</h4><div class="tp-rgrid" data-readouts></div></section>` : ''}
    ${ex.tasks?.length ? `<section class="tp-tasks"><h4>${t('设置任务')}</h4><ul>${ex.tasks.map((x) => `<li>${esc(L(x.text, x.textEn))} <small>${t('{n} 分', { n: x.points })}</small></li>`).join('')}</ul></section>` : ''}
    <section class="tp-qs"><h4>${t('问题')}</h4>${questionHtml(ex, saved)}</section>
    <div class="tp-actions"><button type="button" class="tp-primary" data-act="check">${t('检查答案')}</button><button type="button" data-act="export">${t('导出我的作答')}</button></div>
    ${ex.think?.length ? `<details class="tp-bg"><summary>${t('课后讨论（不批改）')}</summary><ul>${ex.think.map((x) => `<li>${esc(L(x.zh, x.en))}</li>`).join('')}</ul></details>` : ''}
    <div class="tp-result" data-result aria-live="polite">${p ? `<p class="tp-meta">${t('上次最好：{best} / {max}', { best: p.best, max: p.max })}</p>` : ''}</div>`;
  host.querySelector<HTMLButtonElement>('.tp-back')!.onclick = () => renderList();
  host.querySelector<HTMLButtonElement>('[data-act="load"]')!.onclick = () => void loadStart(ex);
  host.querySelector<HTMLButtonElement>('[data-act="check"]')!.onclick = () => void check(ex);
  host.querySelector<HTMLButtonElement>('[data-act="export"]')!.onclick = () => exportAnswers(ex);
  // 答案边填边存（换页、刷新不丢）
  host.querySelector('.tp-qs')?.addEventListener('change', () => {
    const prev = loadAll()[ex.id];
    save(ex.id, { best: prev?.best ?? 0, max: prev?.max ?? 100, passed: prev?.passed ?? false, answers: answersOf(ex), at: new Date().toISOString() });
  });
  if (ex.readouts?.length) {
    void renderReadouts(ex);
    timer = setInterval(() => {
      if (!host?.isConnected || host.closest('[hidden]')) return;
      void renderReadouts(ex);
    }, 2000);
  }
  host.scrollTop = 0;
}

let lastReadout = '';
async function renderReadouts(ex: Exercise): Promise<void> {
  const box = host?.querySelector<HTMLElement>('[data-readouts]');
  const api = appApi();
  if (!box || !api || open !== ex) return;
  const st = await api.teachState({});
  if (!st) {
    box.innerHTML = `<span class="tp-muted">${t('仿真还没跑完')}</span>`;
    return;
  }
  const html = (ex.readouts ?? [])
    .map((key) => {
      const k = kpi(key);
      const v = k.get(st.result);
      const d = k.digits ?? 1;
      return `<span class="tp-rk">${esc(t(k.label))}</span><span class="tp-rv">${Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—'} <small>${esc(t(k.unit))}</small></span>`;
    })
    .join('');
  if (html !== lastReadout) box.innerHTML = lastReadout = html;
}

async function loadStart(ex: Exercise): Promise<void> {
  const api = await whenApp();
  const b = host?.querySelector<HTMLButtonElement>('[data-act="load"]');
  if (b) {
    b.disabled = true;
    b.textContent = t('正在载入…');
  }
  try {
    await api.applyScenario(ex.scenario);
  } finally {
    if (b) {
      b.disabled = false;
      b.textContent = t('载入起始场景');
    }
    lastReadout = '';
    if (open === ex) void renderReadouts(ex);
  }
}

/** 批改要的全部东西：现在的仿真 + 起始场景 + 对照场景（对照场景借用主程序的批改线程跑，按场景缓存） */
async function stateFor(ex: Exercise, answers: Record<string, string>): Promise<TeachState | undefined> {
  const api = await whenApp();
  const st = await api.teachState(answers, ex.scenario);
  if (!st) return undefined;
  const variants: Record<string, TeachRun> = {};
  for (const v of ex.variants?.(ex.scenario) ?? []) {
    const r = await api.teachState({}, v.scenario as Scenario);
    if (!r?.baseline) throw new Error(t('对照场景 {key} 没跑出来', { key: v.key }));
    variants[v.key] = r.baseline;
  }
  return { ...st, variants };
}

function resultHtml(r: CheckResult): string {
  const items = r.items.map((i) => `<li class="${i.ok ? 'ok' : 'bad'}">${esc(isEn() ? i.textEn : i.text)} <small>${i.points}</small></li>`).join('');
  return `<p class="tp-score ${r.passed ? 'ok' : 'bad'}">${t('得分 {score} / {max}', { score: r.score, max: r.max })} · ${r.passed ? t('通过') : t('没通过（及格线 {pass}%）', { pass: PASS_RATIO * 100 })}</p><ul class="tp-items">${items}</ul>`;
}

async function check(ex: Exercise): Promise<void> {
  if (busy || !host) return;
  busy = true;
  const out = host.querySelector<HTMLElement>('[data-result]');
  const btn = host.querySelector<HTMLButtonElement>('[data-act="check"]');
  const n = ex.variants?.(ex.scenario).length ?? 0;
  if (btn) btn.disabled = true;
  if (out) out.innerHTML = `<p class="tp-muted">${n ? t('正在批改…（还要跑 {n} 个对照场景）', { n }) : t('正在批改…')}</p>`;
  try {
    const answers = answersOf(ex);
    const st = await stateFor(ex, answers);
    if (!st) {
      if (out) out.innerHTML = `<p class="tp-muted">${t('仿真还没跑完，稍等再点「检查答案」')}</p>`;
      return;
    }
    const r = ex.check(st);
    if (out && open === ex) out.innerHTML = resultHtml(r);
    const prev = loadAll()[ex.id];
    save(ex.id, { best: Math.max(prev?.best ?? 0, r.score), max: r.max, passed: (prev?.passed ?? false) || r.passed, answers, at: new Date().toISOString() });
  } catch (e) {
    if (out) out.innerHTML = `<p class="tp-muted">${t('批改出错：{err}', { err: esc(String(e)) })}</p>`;
  } finally {
    busy = false;
    if (btn) btn.disabled = false;
  }
}

function exportAnswers(ex: Exercise): void {
  const api = appApi();
  const data = {
    format: 'storex-chain/teach-answers',
    version: 1,
    exercise: ex.id,
    scenario: api?.currentScenario() ?? ex.scenario,
    answers: answersOf(ex),
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${ex.id}-answers.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  const out = host?.querySelector<HTMLElement>('[data-result]');
  if (out)
    out.insertAdjacentHTML(
      'afterbegin',
      `<p class="tp-muted">${t('已导出 {file}：交给老师，用 npm run teach -- check {id} --answers {file} 批改', { file: `${ex.id}-answers.json`, id: ex.id })}</p>`,
    );
}
