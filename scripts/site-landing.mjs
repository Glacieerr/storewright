// 在线演示站点的首页（site/index.html）：三个部分和开发者入口放在一页上，第一次来的人一眼看到从哪开始。
// 由 scripts/build-site.mjs 调用；纯静态、不依赖网络，跟随系统的浅色 / 深色，手机宽度可用。
// Landing page of the live demo: the three parts and the developer entry points on one page.
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * @param {{ hero?: string, has: (path: string) => boolean }} opt hero：首页大图的相对路径（没有就不放）；has：站点里有没有这个子目录
 */
export function landingHtml(opt) {
  const link = (href, en, zh, primary = false) => `<a class="btn${primary ? ' primary' : ''}" href="${href}"><span>${esc(en)}</span><small>${esc(zh)}</small></a>`;
  const dev = [
    opt.has('yard') ? link('./yard/', 'Truck-yard engine demo', '卸货场引擎演示') : '',
    opt.has('benchmark') ? link('./benchmark/', 'Duty-Desk Bench', '值班台基准') : '',
    link('https://github.com/Glacieerr/storewright', 'Source code', '源代码（GitHub）'),
  ].join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Storewright · Live demo</title>
<meta name="description" content="A personal open-source portfolio project: digital twins of grocery store operations and of a store's whole supply chain, from ship to shelf. Everything runs in your browser." />
<style>
:root { --bg: #f6f7f9; --card: #ffffff; --ink: #18202a; --muted: #5b6573; --line: #dfe3e8; --accent: #0f6fde; --accent-ink: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --bg: #11151a; --card: #1a2028; --ink: #e8edf3; --muted: #9aa6b4; --line: #2a323d; --accent: #4d9cff; --accent-ink: #0b1220; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
main { max-width: 1080px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { font-size: clamp(26px, 4vw, 38px); line-height: 1.2; margin: 0 0 6px; }
.lead { color: var(--muted); margin: 0 0 4px; max-width: 760px; }
.hero { margin: 22px 0 8px; border-radius: 14px; overflow: hidden; border: 1px solid var(--line); background: #000; }
.hero img { display: block; width: 100%; height: auto; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 16px; margin-top: 22px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 18px 18px 14px; display: flex; flex-direction: column; gap: 8px; }
.card h2 { font-size: 19px; margin: 0; }
.card .tag { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
.card p { margin: 0; color: var(--muted); font-size: 15px; }
.btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: auto; padding-top: 6px; }
.btn { display: inline-flex; flex-direction: column; text-decoration: none; color: var(--ink); border: 1px solid var(--line); border-radius: 10px; padding: 7px 12px; min-height: 44px; justify-content: center; }
.btn small { color: var(--muted); font-size: 12px; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.btn.primary small { color: var(--accent-ink); opacity: .85; }
.btn:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
footer { margin-top: 28px; color: var(--muted); font-size: 13px; }
footer a { color: inherit; }
</style>
</head>
<body>
<main>
<h1>Storewright · StoreX · StoreX Chain</h1>
<p class="lead">A personal open-source portfolio project: digital twins of grocery store operations and of a store's whole supply chain, from ship to shelf. Everything below runs in your browser — no install, no account.</p>
<p class="lead">个人开源作品集：门店运营和整条供应链（从远洋到货架）的数字孪生。下面的一切都在浏览器里运行，不用安装、不用账号。</p>
${opt.hero ? `<div class="hero"><img src="${opt.hero}" alt="Guided tour: one container travels from the ship through the port, the logistics park and the distribution centre to the store's shelf" width="960" height="540" /></div>` : ''}
<div class="grid">
  <section class="card">
    <span class="tag">Part 3 · 第三部分</span>
    <h2>StoreX Chain · 全链路孪生</h2>
    <p>Sea, rail, air and road freight into a distribution centre and on to the store, in a 3D regional twin with a dispatch board, a closed-loop twin and an auditable AI duty assistant.</p>
    <p>海运、铁路、空运、公路进配送中心再到门店：三维区域孪生、调度台、闭环孪生和可审计的 AI 值班助手。</p>
    <div class="btns">
      ${link('./storex-chain/?tour=container', 'One container, ship to shelf', '看一个集装箱从船到货架', true)}
      ${link('./storex-chain/', 'Open the twin', '打开孪生')}
      ${link('./storex-chain/?ex=ex01', 'Teaching exercises', '教学练习')}
    </div>
  </section>
  <section class="card">
    <span class="tag">Part 1 · 第一部分</span>
    <h2>Storewright · 门店孪生</h2>
    <p>A grocery store's 3D twin in sync with live operations: replay and forecast, fulfilment, backroom and replenishment, and AI on associate phones.</p>
    <p>门店的三维孪生和实时作业同步：回放和预测、线上履约、后仓和补货、员工手机上的 AI。</p>
    <div class="btns">
      ${link('./app/showcase.html', 'Open the showcase', '打开展示页', true)}
      ${link('./sim/', 'Store simulator', '门店模拟器')}
      ${link('./app/', 'Associate app', '员工端')}
    </div>
  </section>
  <section class="card">
    <span class="tag">Part 2 · 第二部分</span>
    <h2>StoreX · 2030 年的门店</h2>
    <p>The store redesigned for 2030 and compared item by item with the previous generation on the same simulation engine.</p>
    <p>为 2030 年重新设计的门店，在同一个仿真引擎上和上一代逐项比较。</p>
    <div class="btns">${link('./storex/', 'Open the StoreX simulator', '打开 StoreX 模拟器', true)}</div>
  </section>
  <section class="card">
    <span class="tag">For developers · 开发者</span>
    <h2>Libraries, benchmark, source · 库、基准、源码</h2>
    <p>Reusable pieces: a truck-yard and loading-dock motion engine, a vehicle-overlap audit, and an open benchmark for operations assistants.</p>
    <p>可以复用的部分：卸货场和月台的运动引擎、车辆重叠审计，以及运营助手的公开基准。</p>
    <div class="btns">${dev}</div>
  </section>
</div>
<footer>
<p>Not affiliated with any retailer or company; all data is synthetic. · 本项目与任何零售商、企业无隶属关系；数据都是合成的。</p>
<p><a href="./LICENSE">License (AGPL-3.0)</a> · <a href="./LICENSE-docs">Documentation license (CC BY 4.0)</a> · <a href="./THIRD_PARTY_NOTICES.md">Third-party notices</a></p>
</footer>
</main>
</body>
</html>
`;
}
