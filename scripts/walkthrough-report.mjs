// 全流程走查的图文报告：读 experiments/results/walkthrough/steps.ndjson（和可选的 findings.json），
// 生成 experiments/results/walkthrough/report.html。截图以相对路径引用（shots/…），与报告放在同一目录。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), 'experiments/results/walkthrough');
const steps = readFileSync(join(dir, 'steps.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const findings = existsSync(join(dir, 'findings.json')) ? JSON.parse(readFileSync(join(dir, 'findings.json'), 'utf8')) : { meta: {}, items: [] };

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// 去掉终端颜色代码
const clean = (s) => String(s ?? '').replace(/\u001b\[[0-9;]*m/g, '');

const sections = [];
for (const s of steps) {
  let sec = sections.find((x) => x.name === s.section);
  if (!sec) sections.push((sec = { name: s.section, steps: [] }));
  sec.steps.push(s);
}
const total = steps.filter((s) => s.ms > 0 || s.shot);
const passed = total.filter((s) => s.ok).length;
const failed = total.length - passed;
const seconds = Math.round(steps.reduce((a, s) => a + s.ms, 0) / 1000);
const shots = steps.filter((s) => s.shot).length;

const KIND = { fixed: '已修复', open: '待决定', note: '说明' };

const html = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Storewright 全流程走查</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans+Condensed:wght@600;700&display=swap">
<style>
/* 版式：一列走查记录，左侧是步骤文字，右侧是这一步之后的截图；顶部是结论与发现的问题 */
:root {
  --bg: #f4f6f4;
  --surface: #ffffff;
  --fg: #16231e;
  --muted: #5d6c66;
  --line: #d9e1dd;
  --brand: #0f6e56;
  --brand-soft: #e3f0eb;
  --ok: #1d7a46;
  --fail: #b3261e;
  --warn: #9a6200;
  --font-body: 'Noto Sans SC', 'PingFang SC', 'Hiragino Sans GB', system-ui, sans-serif;
  --font-head: 'IBM Plex Sans Condensed', 'Noto Sans SC', 'PingFang SC', system-ui, sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #0e1513; --surface: #151e1b; --fg: #e4ece8; --muted: #9aaaa3; --line: #26332e; --brand: #4fbf98; --brand-soft: #18302a; --ok: #5fcf8d; --fail: #ff8a80; --warn: #e8b04b; color-scheme: dark; }
}
:root[data-theme="dark"] { --bg: #0e1513; --surface: #151e1b; --fg: #e4ece8; --muted: #9aaaa3; --line: #26332e; --brand: #4fbf98; --brand-soft: #18302a; --ok: #5fcf8d; --fail: #ff8a80; --warn: #e8b04b; color-scheme: dark; }
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--fg); font: 15px/1.65 var(--font-body); padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 28px 64px; }
.wrap { max-width: 1120px; margin: 0 auto; display: grid; gap: 28px; }
h1, h2, h3 { font-family: var(--font-head); text-wrap: balance; margin: 0; line-height: 1.25; }
h1 { font-size: clamp(26px, 4vw, 36px); letter-spacing: 0.01em; }
h2 { font-size: 22px; }
h3 { font-size: 16px; font-family: var(--font-body); font-weight: 700; }
p { margin: 0; }
.muted { color: var(--muted); }
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
header { display: grid; gap: 12px; }
.eyebrow { font: 600 12px/1 var(--font-mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--brand); }
.lede { max-width: 70ch; color: var(--muted); }
.tally { display: flex; flex-wrap: wrap; gap: 10px 28px; padding: 14px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.tally div { display: grid; gap: 2px; }
.tally b { font: 600 24px/1.1 var(--font-mono); font-variant-numeric: tabular-nums; }
.tally span { font-size: 12px; color: var(--muted); letter-spacing: 0.04em; }
.tally .bad b { color: var(--fail); }
nav.toc { display: flex; flex-wrap: wrap; gap: 8px; position: sticky; top: env(safe-area-inset-top, 0px); z-index: 2; background: var(--bg); padding-block: 10px; }
nav.toc a { font-size: 13px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--fg); text-decoration: none; background: var(--surface); }
nav.toc a .n { font-family: var(--font-mono); color: var(--muted); margin-right: 6px; }
nav.toc a.has-fail { border-color: var(--fail); color: var(--fail); }
nav.toc a:focus-visible, button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.findings { display: grid; gap: 10px; padding: 18px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; }
.finding { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; padding-block: 10px; border-top: 1px solid var(--line); }
.finding:first-of-type { border-top: 0; }
.pill { display: inline-block; font: 600 11px/1 var(--font-mono); letter-spacing: 0.06em; padding: 5px 8px; border-radius: 6px; white-space: nowrap; align-self: start; }
.pill.fixed { background: var(--brand-soft); color: var(--brand); }
.pill.open { background: color-mix(in srgb, var(--warn) 16%, transparent); color: var(--warn); }
.pill.note { background: color-mix(in srgb, var(--muted) 14%, transparent); color: var(--muted); }
.pill.ok { background: color-mix(in srgb, var(--ok) 14%, transparent); color: var(--ok); }
.pill.fail { background: color-mix(in srgb, var(--fail) 14%, transparent); color: var(--fail); }
.finding p { grid-column: 2; color: var(--muted); font-size: 14px; }
section.sec { display: grid; gap: 14px; scroll-margin-top: 64px; }
.sec-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; }
.sec-head .count { font: 13px var(--font-mono); color: var(--muted); }
ol.steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
li.step { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 16px; padding: 14px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }
li.step.wide { grid-template-columns: minmax(0, 1fr) 440px; }
li.step.noshot { grid-template-columns: minmax(0, 1fr); }
li.step.failed { border-color: color-mix(in srgb, var(--fail) 55%, var(--line)); }
.step-text { display: grid; gap: 6px; align-content: start; min-width: 0; }
.step-meta { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; font-size: 12px; color: var(--muted); }
.note { white-space: pre-wrap; font-size: 14px; color: var(--fg); overflow-wrap: anywhere; }
.err { white-space: pre-wrap; font: 12.5px/1.5 var(--font-mono); color: var(--fail); background: color-mix(in srgb, var(--fail) 7%, transparent); padding: 8px 10px; border-radius: 6px; overflow-x: auto; }
.shot { display: block; padding: 0; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--bg); cursor: zoom-in; width: 100%; }
.shot img { display: block; width: 100%; height: auto; max-height: 420px; object-fit: cover; object-position: top; }
dialog { border: 0; padding: 0; background: transparent; max-width: min(96vw, 1400px); max-height: 94vh; }
dialog::backdrop { background: rgba(8, 14, 12, 0.82); }
dialog img { display: block; max-width: 100%; max-height: 90vh; height: auto; border-radius: 6px; }
dialog form { text-align: right; margin-top: 8px; }
dialog button { font: 14px var(--font-body); padding: 6px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); color: var(--fg); cursor: pointer; }
footer { color: var(--muted); font-size: 13px; border-top: 1px solid var(--line); padding-top: 16px; }
@media (max-width: 760px) {
  li.step, li.step.wide { grid-template-columns: minmax(0, 1fr); }
  .shot img { max-height: 520px; }
}
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
</style>
<div class="wrap">
<header>
  <span class="eyebrow">全流程走查 · ${esc(findings.meta.date ?? new Date().toISOString().slice(0, 10))}</span>
  <h1>Storewright 全流程走查</h1>
  <p class="lede">${esc(findings.meta.summary ?? '在真实浏览器里逐个流程操作员工端、控制台、浏览器内演示、模拟器和接口，每一步记录结果、用时和截图。全部为合成数据。')}</p>
  <div class="tally">
    <div><b>${sections.length}</b><span>个流程</span></div>
    <div><b>${total.length}</b><span>个步骤</span></div>
    <div><b>${passed}</b><span>通过</span></div>
    <div class="${failed ? 'bad' : ''}"><b>${failed}</b><span>未通过</span></div>
    <div><b>${shots}</b><span>张截图</span></div>
    <div><b>${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}</b><span>操作用时（分:秒）</span></div>
  </div>
</header>
${findings.items.length ? `<section class="findings" aria-labelledby="f-h">
  <h2 id="f-h">走查中发现的问题</h2>
  ${findings.items.map((f) => `<div class="finding"><span class="pill ${esc(f.kind)}">${esc(KIND[f.kind] ?? f.kind)}</span><h3>${esc(f.title)}</h3><p>${esc(f.detail)}</p></div>`).join('\n  ')}
</section>` : ''}
<nav class="toc" aria-label="流程">
  ${sections.map((s, i) => `<a href="#s${i + 1}" class="${s.steps.some((x) => !x.ok) ? 'has-fail' : ''}"><span class="n">${String(i + 1).padStart(2, '0')}</span>${esc(s.name)}</a>`).join('\n  ')}
</nav>
${sections
  .map((sec, i) => {
    const ok = sec.steps.filter((x) => x.ok).length;
    return `<section class="sec" id="s${i + 1}" aria-labelledby="h${i + 1}">
  <div class="sec-head"><h2 id="h${i + 1}">${String(i + 1).padStart(2, '0')} · ${esc(sec.name)}</h2><span class="count">${ok}/${sec.steps.length} 通过</span></div>
  <ol class="steps">
  ${sec.steps
    .map((s) => {
      const wide = s.device && /控制台|电脑/.test(s.device);
      return `<li class="step${s.ok ? '' : ' failed'}${s.shot ? (wide ? ' wide' : '') : ' noshot'}">
      <div class="step-text">
        <div class="step-meta"><span class="pill ${s.ok ? 'ok' : 'fail'}">${s.ok ? '通过' : '未通过'}</span>${s.device ? `<span>${esc(s.device)}</span>` : ''}${s.ms ? `<span class="mono">${(s.ms / 1000).toFixed(1)} s</span>` : ''}</div>
        <h3>${esc(s.title)}</h3>
        ${s.note ? `<p class="note">${esc(clean(s.note))}</p>` : ''}
        ${s.error ? `<pre class="err">${esc(clean(s.error))}</pre>` : ''}
      </div>
      ${s.shot ? `<button class="shot" type="button" data-src="${esc(s.shot)}" aria-label="放大截图：${esc(s.title)}"><img src="${esc(s.shot)}" alt="${esc(s.title)}" loading="lazy"></button>` : ''}
    </li>`;
    })
    .join('\n  ')}
  </ol>
</section>`;
  })
  .join('\n')}
<footer>${esc(findings.meta.footer ?? '运行方式：npm run build:all，然后 npm run walkthrough（Playwright + 本机 Chrome；真实后端与浏览器内演示站点各一个）。本项目与任何零售商、企业无隶属关系。')}</footer>
</div>
<dialog id="viewer"><img id="viewer-img" alt=""><form method="dialog"><button>关闭</button></form></dialog>
<script>
  const dlg = document.getElementById('viewer');
  const img = document.getElementById('viewer-img');
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.shot');
    if (!b) return;
    img.src = b.dataset.src;
    img.alt = b.getAttribute('aria-label') || '';
    dlg.showModal();
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
</script>
`;
writeFileSync(join(dir, 'report.html'), html);
console.log(`report: ${join(dir, 'report.html')} (${sections.length} sections, ${total.length} steps, ${failed} failed, ${shots} screenshots)`);
