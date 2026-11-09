import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Metric } from '../assistant/eval';
import type { ItemRow, SystemResult } from './run';
import { BENCH_NAME, BENCH_NAME_ZH, BENCH_SETS, BENCH_VERSION, type SetKey } from './sets';

/**
 * 按 bench/duty-desk/results/*.json 重写报告：docs/benchmark.en.md、docs/benchmark.md 里标记之间的表格，和静态网页 bench/duty-desk/site/index.html。
 * 报告里的每个数都来自结果文件（不手写数字）。
 * Regenerates the benchmark tables in the docs and the static page from the result files.
 */
type Lang = 'en' | 'zh';
const DOCS = fileURLToPath(new URL('../../docs/', import.meta.url));
const REPO = 'https://github.com/Glacieerr/storewright/blob/main/StoreX-Chain';
/** 系统的排列顺序：内置在最前，其余按合计的「四项都对」 */
const ORDER = ['builtin', 'lr', 'nb', 'nearest', 'keyword'];

export function loadResults(root: string): SystemResult[] {
  const dir = join(root, 'results');
  if (!existsSync(dir)) return [];
  const list = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as SystemResult);
  const rank = (r: SystemResult) => (ORDER.includes(r.system) ? ORDER.indexOf(r.system) : ORDER.length);
  return list.sort((a, b) =>
    a.system === 'builtin'
      ? -1
      : b.system === 'builtin'
        ? 1
        : b.total.all.ok / (b.total.all.n || 1) - a.total.all.ok / (a.total.all.n || 1) || rank(a) - rank(b) || (a.system < b.system ? -1 : 1),
  );
}

const pc = (m: Metric | undefined): string => (m && m.n ? `${((100 * m.ok) / m.n).toFixed(1)}%` : '—');
/** 二项比例的 95% Wilson 区间 */
export function wilson(m: Metric): [number, number] {
  if (!m.n) return [0, 0];
  const z = 1.96;
  const p = m.ok / m.n;
  const d = 1 + (z * z) / m.n;
  const c = (p + (z * z) / (2 * m.n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / m.n + (z * z) / (4 * m.n * m.n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const ci = (m: Metric) => {
  const [a, b] = wilson(m);
  return `${(100 * a).toFixed(1)}–${(100 * b).toFixed(1)}%`;
};
const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const setLabel = (k: SetKey, lang: Lang) => {
  const s = BENCH_SETS.find((x) => x.key === k)!;
  return lang === 'en' ? `${s.labelEn}${s.stillBlind ? ' (blind)' : ''}` : `${s.label}${s.stillBlind ? '（盲测）' : ''}`;
};
const label = (r: SystemResult, lang: Lang) => (lang === 'en' ? r.labelEn : r.label);
const MEASURES = ['intent', 'tool', 'behavior', 'safety', 'all'] as const;
const MEASURE_LABEL: Record<Lang, Record<(typeof MEASURES)[number], string>> = {
  en: { intent: 'Intent', tool: 'Tool', behavior: 'Behaviour', safety: 'Safety', all: 'All four' },
  zh: { intent: '意图', tool: '工具', behavior: '回答形态', safety: '安全', all: '四项都对' },
};
const BEHAVIOR_LABEL: Record<Lang, Record<string, string>> = {
  en: { answer: 'Answer', clarify: 'Ask back', decline: 'Decline (out of scope)', refuse: 'Refuse (skip a rule)', proposal: 'Proposal (to confirm)' },
  zh: { answer: '正常回答', clarify: '问一句', decline: '说明超出范围', refuse: '拒绝跳过规则', proposal: '提议（等人确认）' },
};
const ROLE_LABEL: Record<Lang, Record<string, string>> = {
  en: { viewer: 'Viewer', dispatcher: 'Dispatcher', manager: 'Station manager', regional: 'Regional manager' },
  zh: { viewer: '只读', dispatcher: '调度员', manager: '站长', regional: '区域经理' },
};

export function leaderboard(rs: readonly SystemResult[], lang: Lang): string {
  const L =
    lang === 'en'
      ? ['| System | ' + BENCH_SETS.map((s) => setLabel(s.key, lang)).join(' | ') + ' | Total (320) | 95% interval |']
      : ['| 系统 | ' + BENCH_SETS.map((s) => setLabel(s.key, lang)).join(' | ') + ' | 合计（320 题） | 95% 区间 |'];
  L.push(`|---|${BENCH_SETS.map(() => '---').join('|')}|---|---|`);
  for (const r of rs)
    L.push(
      `| ${md(label(r, lang))} | ${BENCH_SETS.map((s) => (r.sets[s.key] ? `${pc(r.sets[s.key]!.metrics.all)} (${r.sets[s.key]!.metrics.all.ok})` : '—')).join(' | ')} | **${pc(r.total.all)}** (${r.total.all.ok}) | ${ci(r.total.all)} |`,
    );
  L.push(
    '',
    lang === 'en'
      ? 'Cells: share of items with all four measures right (count out of 80). Set 4 is the only set that has not been used to change the assistant.'
      : '格子里是四项都对的比例（80 题里对了几题）。只有第四套没有被用来改过值班助手。',
  );
  return L.join('\n');
}

export function measuresTable(rs: readonly SystemResult[], key: SetKey | 'total', lang: Lang): string {
  const ML = MEASURE_LABEL[lang];
  const L = [`| ${lang === 'en' ? 'System' : '系统'} | ${MEASURES.map((m) => ML[m]).join(' | ')} |`, `|---|${MEASURES.map(() => '---').join('|')}|`];
  for (const r of rs) {
    const ms = key === 'total' ? r.total : r.sets[key]?.metrics;
    if (!ms) continue;
    L.push(`| ${md(label(r, lang))} | ${MEASURES.map((m) => `${pc(ms[m])} (${ms[m].ok}/${ms[m].n})`).join(' | ')} |`);
  }
  return L.join('\n');
}

export function historyTable(builtin: SystemResult | undefined, lang: Lang): string {
  const ML = MEASURE_LABEL[lang];
  const L =
    lang === 'en'
      ? [`| Set | Assistant version at the first run | ${MEASURES.map((m) => ML[m]).join(' | ')} | Built-in now (all four) |`]
      : [`| 题目 | 首次运行时的值班助手 | ${MEASURES.map((m) => ML[m]).join(' | ')} | 内置现在（四项都对） |`];
  L.push(`|---|---|${MEASURES.map(() => '---').join('|')}|---|`);
  for (const s of BENCH_SETS) {
    const o = s.official;
    const now = builtin?.sets[s.key]?.metrics.all;
    L.push(
      `| ${setLabel(s.key, lang)} | ${lang === 'en' ? o.versionEn : o.version} | ${MEASURES.map((m) => `${pc({ ok: o[m], n: 80 })} (${o[m]})`).join(' | ')} | ${now ? `${pc(now)} (${now.ok})` : '—'} |`,
    );
  }
  L.push(
    '',
    lang === 'en'
      ? 'The official score of a set is the first run of the assistant version of that time. Sets 1–3 were studied afterwards (failures fixed through general improvements), so their current scores are regression numbers, not blind results.'
      : '每套的正式成绩是当时那一版值班助手第一次跑这套题的结果。第一到第三套之后被看过（按通用的改进修了问题），所以它们现在的成绩只是回归数字，不是盲测成绩。',
  );
  return L.join('\n');
}

function itemsOf(r: SystemResult): ItemRow[] {
  return BENCH_SETS.flatMap((s) => r.sets[s.key]?.items ?? []);
}

export function breakdownTables(r: SystemResult, lang: Lang): string {
  const items = itemsOf(r);
  const head = lang === 'en' ? '| | Items | Behaviour right | All four right |' : '| | 题数 | 形态对 | 四项都对 |';
  const row = (name: string, xs: ItemRow[]) =>
    `| ${name} | ${xs.length} | ${pc({ ok: xs.filter((x) => x.ok.behavior).length, n: xs.length })} | ${pc({ ok: xs.filter((x) => x.ok.all).length, n: xs.length })} (${xs.filter((x) => x.ok.all).length}) |`;
  const L: string[] = [];
  L.push(lang === 'en' ? '**By expected behaviour**' : '**按期望的回答形态**', '', head, '|---|---|---|---|');
  for (const b of ['answer', 'clarify', 'decline', 'refuse', 'proposal']) {
    const xs = items.filter((x) => x.want.behavior === b);
    if (xs.length) L.push(row(BEHAVIOR_LABEL[lang][b] as string, xs));
  }
  L.push('', lang === 'en' ? "**By asker's role**" : '**按提问人的角色**', '', head, '|---|---|---|---|');
  for (const role of ['dispatcher', 'manager', 'regional', 'viewer']) {
    const xs = items.filter((x) => x.role === role);
    if (xs.length) L.push(row(ROLE_LABEL[lang][role] as string, xs));
  }
  L.push('', lang === 'en' ? '**Single question vs. follow-up in a conversation**' : '**单独一问 / 同一段对话里接着问**', '', head, '|---|---|---|---|');
  L.push(
    row(
      lang === 'en' ? 'Single question' : '单独一问',
      items.filter((x) => !x.pair),
    ),
  );
  L.push(
    row(
      lang === 'en' ? 'Multi-turn' : '多轮',
      items.filter((x) => !!x.pair),
    ),
  );
  return L.join('\n');
}

export function missesList(r: SystemResult, lang: Lang, notes: ReadonlyMap<string, string>): string {
  const L: string[] = [];
  const ML = MEASURE_LABEL[lang];
  for (const s of BENCH_SETS) {
    const miss = (r.sets[s.key]?.items ?? []).filter((x) => !x.ok.all);
    L.push(`**${setLabel(s.key, lang)}** — ${lang === 'en' ? `${miss.length} of 80 not fully right` : `80 题里 ${miss.length} 题没有四项都对`}`, '');
    for (const x of miss) {
      const failed = MEASURES.filter((m) => m !== 'all' && !x.ok[m])
        .map((m) => ML[m])
        .join(lang === 'en' ? ', ' : '、');
      const want = `${x.want.intent} / ${x.want.tools.join(', ') || '—'} / ${x.want.behavior}`;
      const got = `${x.got.intent} / ${x.got.tools.join(', ') || '—'} / ${x.got.behavior}`;
      const note = notes.get(x.id);
      L.push(
        lang === 'en'
          ? `- **${x.id}** (${ROLE_LABEL.en[x.role]}${x.pair ? `, conversation ${x.pair}` : ''}) 「${md(x.q)}」 — expected \`${want}\`, got \`${got}\`; wrong: ${failed}. Said: 「${md(x.said)}」${note ? ` Author's note: ${md(note)}` : ''}`
          : `- **${x.id}**（${ROLE_LABEL.zh[x.role]}${x.pair ? `，对话 ${x.pair}` : ''}）「${md(x.q)}」——期望 \`${want}\`，实际 \`${got}\`；错在：${failed}。回答的结论：「${md(x.said)}」`,
      );
    }
    L.push('');
  }
  return L.join('\n').trimEnd();
}

/** 把文件里 <!-- bench:name:start --> 和 <!-- bench:name:end --> 之间换成新内容 */
export function inject(text: string, name: string, body: string): string {
  const a = `<!-- bench:${name}:start -->`;
  const b = `<!-- bench:${name}:end -->`;
  const i = text.indexOf(a);
  const j = text.indexOf(b);
  if (i < 0 || j < i) throw new Error(`缺标记 ${a} / ${b}`);
  return `${text.slice(0, i + a.length)}\n${body}\n${text.slice(j)}`;
}

function notesMap(): Map<string, string> {
  return new Map(BENCH_SETS.flatMap((s) => s.items.filter((x) => x.note).map((x) => [x.id, x.note as string] as [string, string])));
}

export function docBlocks(rs: readonly SystemResult[], lang: Lang): Record<string, string> {
  const builtin = rs.find((r) => r.system === 'builtin');
  const gen = rs.map((r) => `${r.system} ${r.generated}`).join(', ');
  return {
    leaderboard: `${leaderboard(rs, lang)}\n\n${lang === 'en' ? 'All five measures on set 4 (the blind set):' : '第四套（盲测）的五项：'}\n\n${measuresTable(rs, 'blind4', lang)}\n\n${lang === 'en' ? 'All five measures over the 320 items:' : '320 题合计的五项：'}\n\n${measuresTable(rs, 'total', lang)}\n\n${lang === 'en' ? `Generated by \`npm run bench -- report\` from \`bench/duty-desk/results/*.json\` (${gen}; ${BENCH_NAME} ${BENCH_VERSION}).` : `由 \`npm run bench -- report\` 按 \`bench/duty-desk/results/*.json\` 生成（${gen}；${BENCH_NAME_ZH} ${BENCH_VERSION}）。`}`,
    history: historyTable(builtin, lang),
    breakdown: builtin ? breakdownTables(builtin, lang) : '—',
    misses: builtin ? missesList(builtin, lang, notesMap()) : '—',
  };
}

// —— 静态网页 ——

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/** 网页里用到的数据（内联进页面，不依赖网络） */
export function siteData(rs: readonly SystemResult[]): unknown {
  const builtin = rs.find((r) => r.system === 'builtin');
  const notes = notesMap();
  return {
    bench: { name: BENCH_NAME, nameZh: BENCH_NAME_ZH, version: BENCH_VERSION, repo: REPO },
    sets: BENCH_SETS.map((s) => ({ key: s.key, label: s.label, labelEn: s.labelEn, blind: s.stillBlind, official: s.official })),
    systems: rs.map((r) => ({
      key: r.system,
      label: r.label,
      labelEn: r.labelEn,
      description: r.description,
      descriptionEn: r.descriptionEn,
      generated: r.generated,
      software: r.software,
      sets: Object.fromEntries(Object.entries(r.sets).map(([k, v]) => [k, v.metrics])),
      total: r.total,
      ci: wilson(r.total.all),
    })),
    misses: builtin
      ? itemsOf(builtin)
          .filter((x) => !x.ok.all)
          .map((x) => ({ id: x.id, q: x.q, role: x.role, pair: x.pair ?? null, want: x.want, got: x.got, ok: x.ok, said: x.said, note: notes.get(x.id) ?? '' }))
      : [],
    breakdown: builtin
      ? {
          behavior: ['answer', 'clarify', 'decline', 'refuse', 'proposal'].map((b) => {
            const xs = itemsOf(builtin).filter((x) => x.want.behavior === b);
            return { key: b, n: xs.length, behavior: xs.filter((x) => x.ok.behavior).length, all: xs.filter((x) => x.ok.all).length };
          }),
          role: ['dispatcher', 'manager', 'regional', 'viewer'].map((k) => {
            const xs = itemsOf(builtin).filter((x) => x.role === k);
            return { key: k, n: xs.length, behavior: xs.filter((x) => x.ok.behavior).length, all: xs.filter((x) => x.ok.all).length };
          }),
        }
      : null,
  };
}

export function siteHtml(rs: readonly SystemResult[]): string {
  const data = JSON.stringify(siteData(rs)).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(BENCH_NAME)} · ${esc(BENCH_NAME_ZH)}</title>
<meta name="description" content="An auditable benchmark for an operations duty assistant: 320 blind questions, five measures, reproducible baselines. Part of the StoreX Chain open-source portfolio project." />
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2430;--muted:#5b6575;--line:#dfe3ea;--accent:#1f6feb;--good:#1a7f37;--warn:#9a6700;--bad:#cf222e;--bar:#c9d7f2;--bar2:#1f6feb}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1318;--card:#171c23;--ink:#e6e9ef;--muted:#9aa4b2;--line:#2a313b;--accent:#58a6ff;--good:#3fb950;--warn:#d29922;--bad:#f85149;--bar:#23314a;--bar2:#58a6ff}}
:root[data-theme=dark]{--bg:#0f1318;--card:#171c23;--ink:#e6e9ef;--muted:#9aa4b2;--line:#2a313b;--accent:#58a6ff;--good:#3fb950;--warn:#d29922;--bad:#f85149;--bar:#23314a;--bar2:#58a6ff}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:1060px;margin:0 auto;padding:24px 16px 64px}
header{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:8px}
h1{font-size:26px;margin:0}h2{font-size:19px;margin:32px 0 10px}p{margin:8px 0}.muted{color:var(--muted)}
.lang button{border:1px solid var(--line);background:var(--card);color:var(--ink);padding:5px 12px;border-radius:6px;cursor:pointer;font:inherit}
.lang button[aria-pressed=true]{border-color:var(--accent);color:var(--accent);font-weight:600}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.tile b{display:block;font-size:24px}.tile span{color:var(--muted);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:right;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th:first-child,td:first-child{text-align:left;white-space:normal;min-width:180px}th{font-size:13px;color:var(--muted);font-weight:600}
tr.top td{font-weight:600}.n{color:var(--muted);font-size:12px;margin-left:3px}
.bar{display:inline-block;height:8px;border-radius:4px;background:var(--bar);width:80px;vertical-align:middle;margin-left:6px;position:relative;overflow:hidden}.bar i{position:absolute;left:0;top:0;bottom:0;background:var(--bar2)}
details{border-top:1px solid var(--line);padding:8px 0}summary{cursor:pointer;font-weight:600}
.miss{padding:8px 0;border-bottom:1px dashed var(--line);font-size:14px}.miss:last-child{border-bottom:0}
.miss code{font-size:12.5px;background:var(--bg);padding:1px 5px;border-radius:4px}.tag{display:inline-block;font-size:12px;padding:0 6px;border-radius:9px;border:1px solid var(--bad);color:var(--bad);margin-right:4px}
.q{font-size:15px}footer{margin-top:40px;color:var(--muted);font-size:13px}a{color:var(--accent)}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;overflow-x:auto;font-size:13px}
</style>
</head>
<body>
<main>
<header><div><h1 id="title"></h1><p class="muted" id="subtitle"></p></div><div class="lang" role="group" aria-label="Language"><button data-l="en">EN</button> <button data-l="zh">中文</button></div></header>
<p id="intro"></p>
<div class="tiles" id="tiles"></div>
<h2 id="h-board"></h2><div class="card"><table id="board"></table><p class="muted" id="board-note"></p></div>
<h2 id="h-set4"></h2><div class="card"><table id="set4"></table></div>
<h2 id="h-history"></h2><div class="card"><table id="history"></table><p class="muted" id="history-note"></p></div>
<h2 id="h-break"></h2><div class="card"><table id="break"></table></div>
<h2 id="h-miss"></h2><p class="muted" id="miss-note"></p><div class="card" id="misses"></div>
<h2 id="h-submit"></h2><div class="card" id="submit"></div>
<footer id="foot"></footer>
</main>
<script id="data" type="application/json">${data}</script>
<script>
(function(){
var D=JSON.parse(document.getElementById('data').textContent);
var T={
en:{title:'Duty-Desk Bench',subtitle:'An auditable benchmark for an operations duty assistant · v'+D.bench.version,
intro:'320 Chinese questions in four sets, written by four separately started AI writing agents that worked only from a short description of the assistant and never saw its code, training data or the other sets. Every system answers at the same simulated moment and is scored on five measures. The official score of each set is the first run; set 4 is still blind. Data are synthetic; this is part of a personal open-source portfolio project and is not affiliated with any retailer or company.',
tiles:['questions','measures per question','systems compared','lowest safety score of any system'],
board:'Leaderboard: all four measures right',set4:'Set 4 (blind): every measure',history:'Official first-run scores',brk:'Built-in assistant by kind of question',miss:'Every item the built-in assistant gets wrong',
boardNote:'Cells: share of items with intent, tool, behaviour and safety all right (count of 80). Interval: 95% Wilson interval over 320 items.',
historyNote:'Each set\\u2019s official score is the first run of the assistant version at that time. Sets 1–3 were studied afterwards, so their current numbers are regression results.',
missNote:'Expected and actual are intent / tools / behaviour. Questions stay in their original Chinese; the author\\u2019s English note explains what was meant.',
sys:'System',set:'Set',total:'Total',ci:'95% interval',version:'Assistant version',now:'Built-in now',kind:'Kind',items:'Items',beh:'Behaviour right',all:'All four right',
m:{intent:'Intent',tool:'Tool',behavior:'Behaviour',safety:'Safety',all:'All four'},
b:{answer:'Answer',clarify:'Ask back',decline:'Decline (out of scope)',refuse:'Refuse (skip a rule)',proposal:'Proposal (to confirm)'},
r:{dispatcher:'Dispatcher',manager:'Station manager',regional:'Regional manager',viewer:'Viewer'},
expected:'expected',got:'got',wrong:'wrong',said:'said',note:'author\\u2019s note',conv:'conversation',blind:'blind',
submit:'Submit your own system',
submitBody:'<p>Read the items in <code>bench/duty-desk/data/*.jsonl</code>, let your system answer at the evaluation moment (use <code>context/snapshot.json</code> or call the same tools with <code>npm run bench -- tool</code>), write one JSON line per item as in <code>schema/prediction.schema.json</code>, then score it:</p><pre>npm run bench -- score --pred my.jsonl --name my-bot --save\\nnpm run bench -- report</pre><p>The optional LLM mode runs on the same items: <code>npm run bench -- run --system llm</code> (set it up first as in docs/06-llm-option.md; billed per call by your provider). Full method and limits: <a href="'+D.bench.repo+'/docs/benchmark.en.md">docs/benchmark.en.md</a>.</p>',
foot:'Generated from bench/duty-desk/results/*.json by npm run bench -- report. Documentation and data: CC BY 4.0; code: AGPL-3.0-only.'},
zh:{title:'值班台基准 Duty-Desk Bench',subtitle:'可审计的运营值班助手基准 · v'+D.bench.version,
intro:'四套共 320 道中文题，由四个各自独立启动的 AI 写作代理分别出题：它们只看过一份简短的助手说明，没看过代码、训练数据和别的题。所有系统在同一个仿真时刻作答，每题按五项评分。每套的正式成绩是首次运行；第四套仍是盲测。数据是合成的；这是个人开源作品集项目的一部分，与任何零售商、企业无隶属关系。',
tiles:['道题','项评分','个系统参加比较','各系统安全项的最低分'],
board:'排行榜：四项都对',set4:'第四套（盲测）：每一项',history:'正式成绩（首次运行）',brk:'内置助手：按题目类型',miss:'内置助手答错的每一题',
boardNote:'格子里是意图、工具、回答形态、安全四项都对的比例（80 题里对了几题）。区间：320 题的 95% Wilson 区间。',
historyNote:'每套的正式成绩是当时那一版值班助手第一次跑这套题的结果。第一到第三套之后被看过，所以现在的数字只是回归结果。',
missNote:'期望和实际都写成 意图 / 工具 / 回答形态。',
sys:'系统',set:'题目',total:'合计',ci:'95% 区间',version:'首次运行时的版本',now:'内置现在',kind:'类型',items:'题数',beh:'形态对',all:'四项都对',
m:{intent:'意图',tool:'工具',behavior:'回答形态',safety:'安全',all:'四项都对'},
b:{answer:'正常回答',clarify:'问一句',decline:'说明超出范围',refuse:'拒绝跳过规则',proposal:'提议（等人确认）'},
r:{dispatcher:'调度员',manager:'站长',regional:'区域经理',viewer:'只读'},
expected:'期望',got:'实际',wrong:'错在',said:'结论',note:'出题人说明',conv:'对话',blind:'盲测',
submit:'提交你自己的系统',
submitBody:'<p>读 <code>bench/duty-desk/data/*.jsonl</code> 里的题，让你的系统在评测时刻作答（用 <code>context/snapshot.json</code>，或者用 <code>npm run bench -- tool</code> 调同样的工具），每题写一行 JSON（格式见 <code>schema/prediction.schema.json</code>），然后评分：</p><pre>npm run bench -- score --pred my.jsonl --name my-bot --save\\nnpm run bench -- report</pre><p>可选的大模型模式也能跑同一套题：<code>npm run bench -- run --system llm</code>（先按 docs/06-llm-option.md 设好；按调用计费）。完整的方法和局限：<a href="'+D.bench.repo+'/docs/benchmark.md">docs/benchmark.md</a>。</p>',
foot:'由 npm run bench -- report 按 bench/duty-desk/results/*.json 生成。文档和数据：CC BY 4.0；代码：AGPL-3.0-only。'}};
function e(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function p(m){return m&&m.n?(100*m.ok/m.n).toFixed(1)+'%':'—'}
function bar(m){var w=m&&m.n?100*m.ok/m.n:0;return '<span class="bar"><i style="width:'+w.toFixed(1)+'%"></i></span>'}
var lang='en';
try{var q=new URLSearchParams(location.search).get('lang');lang=q==='zh'||q==='en'?q:(/^zh/i.test(navigator.language||'')?'zh':'en')}catch(_){}
function render(){
var t=T[lang];document.documentElement.lang=lang==='zh'?'zh-CN':'en';
document.querySelectorAll('.lang button').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.l===lang))});
function set(id,h){document.getElementById(id).innerHTML=h}
set('title',e(t.title));set('subtitle',e(t.subtitle));set('intro',e(t.intro));
var nq=D.sets.length?D.systems.reduce(function(a,s){return Math.max(a,s.total.all.n)},0):0;var minSafe=D.systems.reduce(function(a,s){return Math.min(a,s.total.safety.n?s.total.safety.ok/s.total.safety.n:1)},1);
var vals=[String(nq),'5',String(D.systems.length),(100*minSafe).toFixed(minSafe===1?0:1)+'%'];
set('tiles',t.tiles.map(function(x,i){return '<div class="tile"><b>'+e(vals[i])+'</b><span>'+e(x)+'</span></div>'}).join(''));
set('h-board',e(t.board));set('h-set4',e(t.set4));set('h-history',e(t.history));set('h-break',e(t.brk));set('h-miss',e(t.miss));set('h-submit',e(t.submit));
var sl=function(s){return (lang==='zh'?s.label:s.labelEn)+(s.blind?(lang==='zh'?'（'+t.blind+'）':' ('+t.blind+')'):'')};
var h='<tr><th>'+t.sys+'</th>'+D.sets.map(function(s){return '<th>'+e(sl(s))+'</th>'}).join('')+'<th>'+t.total+'</th><th>'+t.ci+'</th></tr>';
D.systems.forEach(function(s,i){h+='<tr'+(i===0?' class="top"':'')+'><td title="'+e(lang==='zh'?s.description:s.descriptionEn)+'">'+e(lang==='zh'?s.label:s.labelEn)+'</td>'+D.sets.map(function(x){var m=s.sets[x.key]&&s.sets[x.key].all;return '<td>'+p(m)+'<span class="n">'+(m?m.ok:'')+'</span></td>'}).join('')+'<td><b>'+p(s.total.all)+'</b>'+bar(s.total.all)+'</td><td>'+(100*s.ci[0]).toFixed(1)+'–'+(100*s.ci[1]).toFixed(1)+'%</td></tr>'});
set('board',h);set('board-note',e(t.boardNote));
var ms=['intent','tool','behavior','safety','all'];
h='<tr><th>'+t.sys+'</th>'+ms.map(function(m){return '<th>'+t.m[m]+'</th>'}).join('')+'</tr>';
D.systems.forEach(function(s){var x=s.sets.blind4;if(!x)return;h+='<tr><td>'+e(lang==='zh'?s.label:s.labelEn)+'</td>'+ms.map(function(m){return '<td>'+p(x[m])+'<span class="n">'+x[m].ok+'</span></td>'}).join('')+'</tr>'});
set('set4',h);
var b=D.systems.filter(function(s){return s.key==='builtin'})[0];
h='<tr><th>'+t.set+'</th><th>'+t.version+'</th>'+ms.map(function(m){return '<th>'+t.m[m]+'</th>'}).join('')+'<th>'+t.now+'</th></tr>';
D.sets.forEach(function(s){var o=s.official;var now=b&&b.sets[s.key]?b.sets[s.key].all:null;h+='<tr><td>'+e(sl(s))+'</td><td style="text-align:left;white-space:normal">'+e(lang==='zh'?o.version:o.versionEn)+'</td>'+ms.map(function(m){return '<td>'+p({ok:o[m],n:80})+'</td>'}).join('')+'<td>'+(now?p(now)+'<span class="n">'+now.ok+'</span>':'—')+'</td></tr>'});
set('history',h);set('history-note',e(t.historyNote));
h='';if(D.breakdown){h='<tr><th>'+t.kind+'</th><th>'+t.items+'</th><th>'+t.beh+'</th><th>'+t.all+'</th></tr>';
D.breakdown.behavior.forEach(function(x){if(x.n)h+='<tr><td>'+e(t.b[x.key])+'</td><td>'+x.n+'</td><td>'+p({ok:x.behavior,n:x.n})+'</td><td>'+p({ok:x.all,n:x.n})+bar({ok:x.all,n:x.n})+'</td></tr>'});
D.breakdown.role.forEach(function(x){if(x.n)h+='<tr><td>'+e(t.r[x.key])+'</td><td>'+x.n+'</td><td>'+p({ok:x.behavior,n:x.n})+'</td><td>'+p({ok:x.all,n:x.n})+bar({ok:x.all,n:x.n})+'</td></tr>'})}
set('break',h);set('miss-note',e(t.missNote));
h='';D.sets.forEach(function(s){var xs=D.misses.filter(function(x){return x.id[0]===({blind1:'B',blind2:'C',blind3:'D',blind4:'E'})[s.key]});
h+='<details'+(s.key==='blind4'?' open':'')+'><summary>'+e(sl(s))+' · '+xs.length+' / 80</summary>'+xs.map(function(x){var bad=['intent','tool','behavior','safety'].filter(function(m){return !x.ok[m]}).map(function(m){return '<span class="tag">'+t.m[m]+'</span>'}).join('');
return '<div class="miss"><b>'+e(x.id)+'</b> <span class="muted">'+e(t.r[x.role])+(x.pair?' · '+t.conv+' '+e(x.pair):'')+'</span><div class="q">'+e(x.q)+'</div>'+bad+' '+t.expected+' <code>'+e(x.want.intent+' / '+(x.want.tools.join(', ')||'—')+' / '+x.want.behavior)+'</code> '+t.got+' <code>'+e(x.got.intent+' / '+(x.got.tools.join(', ')||'—')+' / '+x.got.behavior)+'</code><div class="muted">'+t.said+'：'+e(x.said)+(lang==='en'&&x.note?'<br>'+t.note+': '+e(x.note):'')+'</div></div>'}).join('')+'</details>'});
set('misses',h);set('submit',t.submitBody);set('foot',e(t.foot));
}
document.querySelectorAll('.lang button').forEach(function(b){b.onclick=function(){lang=b.dataset.l;render();try{var u=new URL(location.href);u.searchParams.set('lang',lang);history.replaceState(null,'',u)}catch(_){}}});
render();
})();
</script>
</body>
</html>
`;
}

/** 重写报告：两份文档里的表格、静态网页；返回写了哪些文件 */
export function writeReports(root: string): string[] {
  const rs = loadResults(root);
  if (!rs.length) throw new Error('bench/duty-desk/results/ 里还没有结果：先跑 npm run bench -- run --all');
  const written: string[] = [];
  for (const [file, lang] of [
    ['benchmark.en.md', 'en'],
    ['benchmark.md', 'zh'],
  ] as const) {
    const p = join(DOCS, file);
    if (!existsSync(p)) continue;
    let text = readFileSync(p, 'utf8');
    for (const [name, body] of Object.entries(docBlocks(rs, lang))) text = inject(text, name, body);
    writeFileSync(p, text);
    written.push(`docs/${file}`);
  }
  mkdirSync(join(root, 'site'), { recursive: true });
  writeFileSync(join(root, 'site', 'index.html'), siteHtml(rs));
  written.push('bench/duty-desk/site/index.html');
  return written;
}
