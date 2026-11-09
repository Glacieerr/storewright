import './lab.css';
import { disruptionText, DRILL_TODAY, NOTICE_LABEL, NOTICE_PRESETS, noticeDisruptions, parseNotice, PLAYBOOKS, playbooksFor, SCORE_SCALE, SEVERITY_LABEL, type DrillReport, type DrillScore, type Notice, type PlaybookKey } from '../../src/analysis/drill';
import { GEN_LABEL, type Gen } from '../../src/sim/config';
import { labCall, type Progress } from './labClient';
import { mountLineChart } from './labCharts';
import { isEn, t, tx } from './i18n';

/**
 * 「对比与报告」页的演练和预案库：输入一条通知（或点一个模板），先显示认出来的内容和对应的扰动，
 * 再在后台线程里跑「不启动预案 / 启动预案」（每次 3 个种子，各和没有扰动的那次比），给出韧性得分、逐日的服务水平和一段演练报告。
 * 预案库列出每个预案的触发条件、负责人和步骤，以及最近一次演练的得分（存在本机浏览器里）。
 */
const LAST_KEY = 'storex-chain-playbooks';
interface Last {
  score: number;
  without: number;
  at: string;
  notice: string;
  gen: Gen;
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f0 = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '—');
const f1 = (x: number) => (Number.isFinite(x) ? (Math.abs(x) < 0.05 ? '0' : x.toFixed(1)) : '—');
const usd = (x: number) => (Math.abs(x) <= 0.5 ? '—' : `${x < 0 ? '−' : ''}$${f0(Math.abs(x))}`);
const WEEK = [t('一'), t('二'), t('三'), t('四'), t('五'), t('六'), t('日')];
const PRESET_OF: Record<PlaybookKey, string> = { port: 'strike', airport: 'storm', highway: 'highway', supplier: 'supplier', surge: 'holiday' };

// —— 英文界面：预案、通知、扰动这些运行时文字逐段翻；中文界面原样 ——
/** 列表（负责人、认出来的内容）：英文界面逐项翻、用逗号 */
const list = (items: readonly string[], zh: string) => (isEn() ? items.map((s) => esc(tx(s))).join(', ') : items.map(esc).join(zh));
/** 「什么时候 · 谁：做什么」（英文的「什么时候」在行首，首字母大写） */
const stepLi = (s: { when: string; owner: string; text: string }) => {
  const when = tx(s.when);
  return `<li><b>${esc(isEn() ? when.charAt(0).toUpperCase() + when.slice(1) : when)}</b> · ${esc(tx(s.owner))}${isEn() ? ': ' : '：'}${esc(tx(s.text))}</li>`;
};
/** 预案名去掉括号里的补充（「港口拥堵预案（含罢工、台风停工）」→「港口拥堵预案」） */
const shortTitle = (title: string) => (isEn() ? tx(title).replace(/\s*\(.*\)$/, '') : title.replace(/（.*）$/, ''));
/** 加引号的预案名列表 */
const quoted = (titles: string[]) => (isEn() ? titles.map((x) => `"${esc(tx(x))}"`).join(', ') : titles.map((x) => `「${esc(x)}」`).join('、'));
/** 英文界面的通知框显示模板的英文；解析器只认中文，解析前把模板的英文换回中文原文（自己打的中文照样认） */
const shownNotice = (zh: string) => tx(zh);
const noticeSource = (s: string) => (isEn() ? (NOTICE_PRESETS.find((p) => tx(p.text) === s)?.text ?? s) : s);

function loadLast(): Partial<Record<PlaybookKey, Last>> {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}') as Partial<Record<PlaybookKey, Last>>;
  } catch {
    return {};
  }
}
function saveLast(r: DrillReport): void {
  const all = loadLast();
  for (const k of r.playbooks) all[k] = { score: r.with.score, without: r.without.score, at: new Date().toISOString(), notice: r.notice.text, gen: r.gen };
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(all));
  } catch {
    /* 隐私模式存不了：只是下次打开看不到上次的得分 */
  }
}

export function mountDrills(root: HTMLElement): void {
  root.classList.add('lab');
  root.innerHTML = `
    <h2>${t('演练和预案库')}</h2>
    <p class="lead">${t('把一条通知（台风预警、港口罢工、节假日抢购、道路封闭、供应商停产、机场关闭）变成仿真里的扰动，同一个种子分别跑「不启动预案」和「启动预案」，都和没有扰动的那次逐日比（每次 3 个种子）。「不启动预案」= 发现慢、临场应对；「启动预案」= 通知触发的预案把对应的手段打开。通知按第 {drillToday} 天（周{week}）收到算。', { drillToday: DRILL_TODAY, week: WEEK[DRILL_TODAY % 7] })}</p>
    <textarea class="dl-text" aria-label="${t('通知的内容')}">${esc(shownNotice(NOTICE_PRESETS[0]?.text ?? ''))}</textarea>
    <div class="lab-chips">${NOTICE_PRESETS.map((p) => `<button data-p="${p.key}">${esc(tx(p.label))}</button>`).join('')}</div>
    <div class="lab-row"><label>${t('方案')} <select class="dl-gen">${(['g3', 'g2', 'g1'] as Gen[]).map((g) => `<option value="${g}">${tx(GEN_LABEL[g])}</option>`).join('')}</select></label><button class="lab-btn primary dl-run">${t('开始演练')}</button><span class="lab-bar"><i></i></span><span class="dl-msg"></span></div>
    <div class="lab-parse dl-parse"></div>
    <div class="dl-result"></div>
    <h3>${t('预案库')}</h3>
    <div class="lab-row"><button class="lab-btn dl-all">${t('每个预案按标准通知演练一遍')}</button><span class="dl-msg2"></span></div>
    <div class="dl-sum"></div>
    <div class="lab-library dl-lib"></div>
    <p class="lab-note">${t('韧性得分（0–100）：{map}；每一项按比平常差多少线性扣分，{label}降 {zero} 个百分点、最差一天的缺货降 {zero2} 个百分点、空运生鲜最差一天降 {zero3} 个百分点、准时送达最差一天降 {zero4} 个百分点、多花平常 3 周成本的 {zero5}% 时这一项为 0 分。多花的钱按每箱成本的变化算（需求突增时多卖的货本身要多花的不算），加上应对成本（过桥采购的差价、备降机场的卡车运费）。', { map: Object.values(SCORE_SCALE).map((s) => t('{label} {points} 分', { label: tx(s.label), points: s.points })).join(isEn() ? ', ' : '、'), label: tx(SCORE_SCALE.service.label), zero: SCORE_SCALE.service.zero, zero2: SCORE_SCALE.stockout.zero, zero3: SCORE_SCALE.fresh.zero, zero4: SCORE_SCALE.late.zero, zero5: SCORE_SCALE.cost.zero })}</p>`;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const text = q<HTMLTextAreaElement>('.dl-text');
  const gen = q<HTMLSelectElement>('.dl-gen');
  const run = q<HTMLButtonElement>('.dl-run');
  const all = q<HTMLButtonElement>('.dl-all');
  const bar = q<HTMLElement>('.lab-bar > i');
  const msg = q<HTMLElement>('.dl-msg');
  const msg2 = q<HTMLElement>('.dl-msg2');
  const parse = q<HTMLElement>('.dl-parse');
  const result = q<HTMLElement>('.dl-result');
  const sum = q<HTMLElement>('.dl-sum');
  const lib = q<HTMLElement>('.dl-lib');
  let busy = false;

  const showParse = () => {
    const n = parseNotice(noticeSource(text.value.trim()));
    if (!n) {
      parse.innerHTML = `<span class="bad">${t('没认出是哪种情况。换个说法（带上「台风」「罢工」「封闭」「停产」「抢购」「机场」这类词），或者点一个模板。')}</span>`;
      run.disabled = true;
      return;
    }
    run.disabled = busy;
    const dis = noticeDisruptions(n);
    parse.innerHTML = `${t('认出来：{map}', { map: list(n.found, '，') })}<ul>${dis.map((x) => `<li>${esc(tx(disruptionText(x)))}</li>`).join('')}</ul>${t('会启动：')}${isEn() ? ' ' : ''}${quoted(playbooksFor(dis).map((b) => b.title))}`;
  };
  text.oninput = showParse;
  for (const b of root.querySelectorAll<HTMLButtonElement>('.lab-chips button'))
    b.onclick = () => {
      text.value = shownNotice(NOTICE_PRESETS.find((p) => p.key === b.dataset.p)?.text ?? '');
      showParse();
    };

  const drill = async (noticeText: string, g: Gen, label: (p: Progress) => string): Promise<DrillReport | undefined> => {
    const n: Notice | undefined = parseNotice(noticeText);
    if (!n) return undefined;
    return labCall<DrillReport>({ type: 'drill', notice: n, gen: g }, (p) => {
      bar.style.width = `${Math.round((p.done / p.total) * 100)}%`;
      msg.textContent = label(p);
    });
  };
  const setBusy = (on: boolean) => {
    busy = on;
    run.disabled = on || !parseNotice(noticeSource(text.value.trim()));
    all.disabled = on;
    result.style.opacity = on && result.childElementCount ? '0.5' : '';
  };
  const go = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await drill(noticeSource(text.value.trim()), gen.value as Gen, (p) => t('演练中：{text}', { text: tx(p.text) }));
      if (r) {
        saveLast(r);
        bar.style.width = '100%';
        msg.textContent = t('用了 {ms} 秒（{length} 个种子 × {v3} 次运行）', { ms: (r.ms / 1000).toFixed(1), length: r.seeds.length, v3: 1 + 2 + r.each.length });
        renderResult(result, r);
        renderLib(lib, (k) => void one(k));
      }
    } catch (err) {
      msg.textContent = t('演练出错：{err}', { err: String(err) });
    } finally {
      setBusy(false);
    }
  };
  const one = async (k: PlaybookKey) => {
    if (busy) return;
    const preset = NOTICE_PRESETS.find((p) => p.key === PRESET_OF[k]);
    if (!preset) return;
    text.value = shownNotice(preset.text);
    showParse();
    await go();
  };
  run.onclick = () => void go();
  all.onclick = async () => {
    if (busy) return;
    setBusy(true);
    const rowsOut: { title: string; notice: string; r: DrillReport }[] = [];
    try {
      for (const [i, p] of PLAYBOOKS.entries()) {
        const preset = NOTICE_PRESETS.find((x) => x.key === PRESET_OF[p.key]);
        if (!preset) continue;
        msg2.textContent = t('第 {i} / {length} 个：{title}', { i: i + 1, length: PLAYBOOKS.length, title: tx(p.title) });
        const r = await drill(preset.text, gen.value as Gen, (pr) => `${shortTitle(p.title)}${isEn() ? ': ' : '：'}${tx(pr.text)}`);
        if (!r) continue;
        saveLast(r);
        rowsOut.push({ title: p.title, notice: preset.text, r });
        renderLib(lib, (k) => void one(k));
      }
      msg2.textContent = t('{gen}：{length} 个预案演练完了', { gen: tx(GEN_LABEL[gen.value as Gen]), length: rowsOut.length });
      sum.innerHTML = `<div class="table-wrap"><table><thead><tr><th>${t('预案')}</th><th>${t('标准通知')}</th><th>${t('不启动预案')}</th><th>${t('启动预案')}</th><th>${t('少卖的件数')}</th></tr></thead><tbody>${rowsOut
        .map((x) => `<tr><td>${esc(tx(x.title))}</td><td>${esc(tx(x.notice))}</td><td>${t('{f0} 分', { f0: f0(x.r.without.score) })}</td><td>${t('{f0} 分', { f0: f0(x.r.with.score) })}</td><td>${f0(Math.max(0, x.r.without.lostUnits))} → ${f0(Math.max(0, x.r.with.lostUnits))}</td></tr>`)
        .join('')}</tbody></table></div>`;
    } catch (err) {
      msg2.textContent = t('演练出错：{err}', { err: String(err) });
    } finally {
      setBusy(false);
    }
  };
  showParse();
  renderLib(lib, (k) => void one(k));
}

/**
 * 英文界面的演练报告：和 drill.ts 的 drillText 同样的几句、同样的数，用英文的句子拼（中文界面直接用 r.text）。
 * English drill report built from the same fields and numbers as drillText().
 */
function drillTextEn(r: DrillReport): string {
  const n = r.notice;
  const line = (x: DrillScore) =>
    t('扰动后 3 周门店服务水平平均降 {a} 个百分点、最差一天降 {b} 个，空运生鲜最差一天降 {c} 个，准时送达最差一天降 {d} 个，少卖 {e} 件，{f}', {
      a: f1(Math.max(0, x.windowDrop)),
      b: f1(x.worstDrop),
      c: f1(x.airDrop),
      d: f1(x.onTimeDrop),
      e: f0(Math.max(0, x.lostUnits)),
      f: x.extraCost > 0.5 ? t('多花约 {x}', { x: usd(x.extraCost) }) : x.extraCost < -0.5 ? t('每箱成本反而略降（多卖的货摊薄了固定成本）') : t('没有多花钱'),
    });
  const titleOf = (k: PlaybookKey) => shortTitle(PLAYBOOKS.find((p) => p.key === k)?.title ?? k);
  const saved = r.without.lostUnits > 1 ? Math.max(0, Math.min(100, ((r.without.lostUnits - r.with.lostUnits) / r.without.lostUnits) * 100)) : 0;
  const out = [
    t('通知：「{text}」认出来是{kind}（{sev}），在仿真里对应{dis}。', { text: tx(n.text), kind: tx(NOTICE_LABEL[n.kind]), sev: tx(SEVERITY_LABEL[n.severity]), dis: r.disruptions.map((x) => tx(disruptionText(x))).join('; ') }),
    t('不启动预案：{line}。', { line: line(r.without) }),
    t('启动{books}：{line}。', { books: r.playbooks.map((k) => `"${titleOf(k)}"`).join(', '), line: line(r.with) }),
    t('韧性得分从 {a} 分到 {b} 分{c}。', { a: f0(r.without.score), b: f0(r.with.score), c: r.without.lostUnits > 1 ? t('，少卖的件数挽回 {n}%', { n: f0(saved) }) : '' }),
  ];
  const best = r.each.length ? [...r.each].sort((a, b) => b.score.score - a.score.score)[0] : undefined;
  if (best && PLAYBOOKS.some((p) => p.key === best.key)) out.push(t('单独启动时最管用的是「{title}」（{n} 分）。', { title: titleOf(best.key), n: f0(best.score.score) }));
  if (r.without.score >= 98 && r.with.score >= 98 && Math.abs(r.without.lostUnits) < 50) out.push(t('这次扰动没有影响到门店（库存和路线够用），预案的作用看不出来；可以试更严重的情况。'));
  else if (r.with.score + 2 < r.without.score) out.push(t('这次预案反而更差：应对手段的成本超过了它挽回的损失，可以把触发条件定得更严。'));
  return out.join(' ');
}

function parts(s: DrillScore): string {
  const items: [string, number, number][] = [
    [SCORE_SCALE.service.label, s.parts.service, SCORE_SCALE.service.points],
    [SCORE_SCALE.stockout.label, s.parts.stockout, SCORE_SCALE.stockout.points],
    [SCORE_SCALE.fresh.label, s.parts.fresh, SCORE_SCALE.fresh.points],
    [SCORE_SCALE.late.label, s.parts.late, SCORE_SCALE.late.points],
    [SCORE_SCALE.cost.label, s.parts.cost, SCORE_SCALE.cost.points],
  ];
  return `<div class="lab-parts">${items.map(([k, v, max]) => `<div><span>${tx(k)}</span><span class="lab-track"><i style="width:${Math.round((v / max) * 100)}%"></i></span><span>${f0(v)}/${max}</span></div>`).join('')}</div>`;
}

function renderResult(el: HTMLElement, r: DrillReport): void {
  const books = r.playbooks.map((k) => PLAYBOOKS.find((p) => p.key === k)).filter((p): p is (typeof PLAYBOOKS)[number] => !!p);
  const row = (label: string, a: string, b: string) => `<tr><td>${label}</td><td>${a}</td><td>${b}</td></tr>`;
  el.innerHTML = `
    <div class="lab-scores">
      <div class="lab-score"><div class="k">${t('不启动预案 · {gen}', { gen: tx(GEN_LABEL[r.gen]) })}</div><div class="v">${f0(r.without.score)} <small>${t('分')}</small></div>${parts(r.without)}</div>
      <div class="lab-score"><div class="k">${t('启动预案')}</div><div class="v">${f0(r.with.score)} <small>${t('分')}</small></div>${parts(r.with)}</div>
    </div>
    <div class="lab-grid">
      <div class="dl-chart"></div>
      <div>
        <div class="table-wrap"><table>
          <thead><tr><th>${t('和没有扰动比（3 个种子平均）')}</th><th>${t('不启动预案')}</th><th>${t('启动预案')}</th></tr></thead>
          <tbody>
            ${row(t('扰动后 3 周的服务水平降多少'), t('{f1} 个百分点', { f1: f1(Math.max(0, r.without.windowDrop)) }), t('{f1} 个百分点', { f1: f1(Math.max(0, r.with.windowDrop)) }))}
            ${row(t('最差一天降多少'), t('{f1} 个百分点', { f1: f1(r.without.worstDrop) }), t('{f1} 个百分点', { f1: f1(r.with.worstDrop) }))}
            ${row(t('空运生鲜最差一天'), t('{f1} 个百分点', { f1: f1(r.without.airDrop) }), t('{f1} 个百分点', { f1: f1(r.with.airDrop) }))}
            ${row(t('准时送达最差一天'), t('{f1} 个百分点', { f1: f1(r.without.onTimeDrop) }), t('{f1} 个百分点', { f1: f1(r.with.onTimeDrop) }))}
            ${row(t('少卖的件数（3 周）'), f0(Math.max(0, r.without.lostUnits)), f0(Math.max(0, r.with.lostUnits)))}
            ${row(t('应对成本（过桥采购、备降机场的卡车）'), usd(r.without.responseCost), usd(r.with.responseCost))}
            ${row(t('多花的钱合计（含应对成本）'), usd(r.without.extraCost), usd(r.with.extraCost))}
          </tbody>
        </table></div>
        <p class="lab-note">${t('多花的钱按每箱成本的变化乘箱数算，再加上应对成本；需求突增时多卖的货摊薄了固定成本，每箱成本可能反而下降，所以合计可能是负的。')}</p>
        ${r.each.length ? `<h3>${t('每个预案单独启动')}</h3><div class="table-wrap"><table><thead><tr><th>${t('预案')}</th><th>${t('得分')}</th><th>${t('少卖的件数')}</th></tr></thead><tbody>${r.each.map((e) => `<tr><td>${esc(tx(PLAYBOOKS.find((p) => p.key === e.key)?.title ?? e.key))}</td><td>${t('{f0} 分', { f0: f0(e.score.score) })}</td><td>${f0(Math.max(0, e.score.lostUnits))}</td></tr>`).join('')}</tbody></table></div>` : ''}
      </div>
    </div>
    <h3>${t('演练报告')}</h3>
    <p class="lab-text">${esc(isEn() ? drillTextEn(r) : r.text)}</p>
    ${books.map((b) => `<h3>${esc(tx(b.title))}</h3><p class="lab-note">${t('触发：{trigger}。负责人：{map}。仿真里对应：{levers}。', { trigger: esc(tx(b.trigger)), map: list(b.owners, '、'), levers: esc(tx(b.levers)) })}</p><ol class="lab-steps">${b.steps.map(stepLi).join('')}</ol>`).join('')}`;
  const from = r.series.from;
  const n = r.series.base.length;
  mountLineChart(el.querySelector('.dl-chart') as HTMLElement, {
    title: t('门店每天的服务水平'),
    subtitle: t('第 {from}–{from2} 天，需求满足的比例（%），阴影是扰动的日子', { from: from + 1, from2: from + n }),
    x: Array.from({ length: n }, (_, i) => t('第 {from} 天（周{week}）', { from: from + i + 1, week: WEEK[(from + i) % 7] })),
    tick: (i) => (i % 5 === 0 ? t('第 {from} 天', { from: from + i + 1 }) : undefined),
    series: [
      { name: t('没有扰动'), color: 'var(--ink2)', values: r.series.base },
      { name: t('启动预案'), color: 'var(--c1)', values: r.series.with },
      { name: t('不启动预案'), color: 'var(--c2)', values: r.series.without },
    ],
    fmt: (x) => `${x.toFixed(1)}%`,
    band: { from: r.span[0] - from, to: r.span[1] - from, label: t('扰动') },
    aria: t('扰动前后门店每天的服务水平：没有扰动、不启动预案、启动预案'),
  });
}

function renderLib(el: HTMLElement, onRun: (k: PlaybookKey) => void): void {
  const last = loadLast();
  el.innerHTML = PLAYBOOKS.map((p) => {
    const l = last[p.key];
    const when = l ? new Date(l.at).toLocaleString(isEn() ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    return `<div class="lab-book">
      <h4>${esc(tx(p.title))}</h4>
      <div class="meta">${t('触发：{trigger}', { trigger: esc(tx(p.trigger)) })}</div>
      <div class="meta">${t('负责人：{map} · 仿真里对应：{levers}', { map: list(p.owners, '、'), levers: esc(tx(p.levers)) })}</div>
      <ol class="lab-steps">${p.steps.map(stepLi).join('')}</ol>
      <div class="last">${l ? `${t('最近一次演练（{when}，{gen}）：', { when, gen: tx(GEN_LABEL[l.gen] ?? '') })}<b>${t('{f0} 分', { f0: f0(l.score) })}</b>${t('（不启动预案 {f0} 分）', { f0: f0(l.without) })}` : t('还没有演练过')}</div>
      <button class="lab-btn" data-k="${p.key}">${t('按标准通知演练')}</button>
    </div>`;
  }).join('');
  for (const b of el.querySelectorAll<HTMLButtonElement>('button[data-k]')) b.onclick = () => onRun(b.dataset.k as PlaybookKey);
}
