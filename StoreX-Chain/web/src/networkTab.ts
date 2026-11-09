import './networkTab.css';
import { BASE_RATE, crossBorder, MODE_LABEL, type BorderFlow, type CrossBorder } from '../../src/analysis/crossBorder';
import { allocate, ALLOC_FAMILIES, DEFAULT_OPTIONS, MAX_STORES, NET, planName, planNetwork, SITE_KIND_LABEL, STORE_KIND_LABEL, type NetOptions, type NetPlan } from '../../src/network/index';
import { networkMap } from '../../src/network/map';
import { capacityOf, fixedCost } from '../../src/network/model';
import type { Evaluation } from '../../src/network/solve';
import { isEn, t as tr, tx } from './i18n';

/**
 * 「网络规划」页：
 * - 多门店网络：在当前区域里放 N 家店，选开哪几个仓、每家店由哪个仓送、每天的线路和车，和今天只有物流园的网络比；
 *   货不够时怎么分给各店（公平分配）；
 * - 跨境：清关的步骤（和仿真用的时间对得上）、单证、查验概率、税费、到岸成本，以及汇率变了到岸成本变多少。
 * 计算都在浏览器里（规划一次几十毫秒）；带 data-tip 的元素悬停时显示说明。
 */
type Page = 'net' | 'border';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n0 = (x: number) => Math.round(x).toLocaleString('en-US');
const n1 = (x: number) => x.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const wan = (x: number) => (x / 10_000).toLocaleString('en-US', { maximumFractionDigits: 0 });
const signedWan = (x: number) => (Math.abs(x) < 5_000 ? '0' : `${x > 0 ? '+' : '−'}${wan(Math.abs(x))}`);
const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;
const hrs = (h: number) => (h >= 24 ? tr('{n1} 天', { n1: n1(h / 24) }) : h >= 1 || h === 0 ? tr('{n1} 小时', { n1: n1(h) }) : tr('{h} 分钟', { h: Math.round(h * 60) }));
const HAN = /\p{Script=Han}/u;
/** 英文的金额：84 万美元 → $840k，204 万美元 → $2.04M */
const usdShort = (x: number) => (x >= 1e6 ? `$${(x / 1e6).toFixed(x >= 1e7 ? 1 : 2).replace(/\.?0+$/, '')}M` : `$${Math.round(x / 1e3).toLocaleString('en-US')}k`);
/** 方案名（「物流园 + 西立交配送中心」）：英文界面逐段翻 */
const planEn = (name: string) => (isEn() ? name.split(' + ').map((x) => tx(x)).join(' + ') : name);
/** 英文界面里括号前空一格 */
const sp = () => (isEn() ? ' ' : '');
/** 英文的标签首字母大写（单证名在字典里是小写，句中用） */
const capEn = (s: string) => (isEn() ? s.charAt(0).toUpperCase() + s.slice(1) : s);
/** 「仿真：…」→「和仿真一致：…」（英文界面两段分别翻） */
const simText = (label: string) => (!isEn() ? label.replace(/^仿真：/, tr('和仿真一致：')) : label.startsWith('仿真：') ? `${tr('和仿真一致：')} ${tx(label.slice(3))}` : tx(label));
/** 数字后面的括号：中文全角、英文半角 */
const paren = (s: string) => (isEn() ? ` (${s})` : `（${s}）`);

const PARTS: [keyof Omit<Evaluation['costs'], 'total'>, string][] = [
  ['fixed', tr('固定成本（投资年金 + 固定运营费）')],
  ['handling', tr('仓内处理（收货、拣货、装车）')],
  ['inbound', tr('进仓运输（港口、铁路、机场、高速口 → 仓）')],
  ['outbound', tr('外送（仓 → 门店，按排出的线路）')],
  ['inventory', tr('安全库存的持有成本')],
  ['overflow', tr('超出能力交第三方仓')],
  ['service', tr('时效罚分（车程超过 1 小时）')],
];

export function renderNetwork(el: HTMLElement): void {
  let page: Page = 'net';
  const opts: NetOptions = { ...DEFAULT_OPTIONS, params: { ...DEFAULT_OPTIONS.params } };
  let gen: 'g1' | 'g3' = 'g3';
  let allocFam = ALLOC_FAMILIES.find((f) => f.key === 'DAIRY')?.key ?? (ALLOC_FAMILIES[0]?.key as string);
  let allocSupply = 0.7;
  let plan: NetPlan | undefined;

  el.innerHTML = `
  <div class="report nw-root">
    <section>
      <div class="nw-head">
        <div>
          <h2>${tr('网络规划')}</h2>
          <p class="lead">${tr('从一家店扩到一个门店网络：在这个区域里选开哪几个仓、每家店由哪个仓送、每天怎么排线路，货不够时怎么分；跨境来的货要哪些手续和单证、清关要多久、汇率变了成本变多少。区域、门店和数字都是合成的。')}</p>
        </div>
        <div class="seg" role="group" aria-label="${tr('网络规划的两页')}">
          <button data-page="net" aria-pressed="true">${tr('多门店网络')}</button>
          <button data-page="border" aria-pressed="false">${tr('跨境')}</button>
        </div>
      </div>
    </section>
    <div id="nw-net"></div>
    <div id="nw-border" hidden></div>
    <div class="nw-tip" id="nw-tip" hidden></div>
  </div>`;
  const root = el.querySelector('.nw-root') as HTMLElement;
  const netEl = el.querySelector('#nw-net') as HTMLElement;
  const borderEl = el.querySelector('#nw-border') as HTMLElement;
  const tip = el.querySelector('#nw-tip') as HTMLElement;

  // —— 悬停说明：一个提示框，跟着鼠标；键盘聚焦到能聚焦的图形上也显示 ——
  const showTip = (target: Element, x: number, y: number) => {
    const text = target.getAttribute('data-tip');
    if (!text) return;
    tip.textContent = text;
    tip.hidden = false;
    const box = root.getBoundingClientRect();
    const w = tip.offsetWidth;
    const left = Math.min(box.width - w - 8, Math.max(8, x - box.left + 14));
    tip.style.left = `${left}px`;
    tip.style.top = `${y - box.top + 16}px`;
  };
  root.addEventListener('pointermove', (e) => {
    const t = (e.target as Element).closest('[data-tip]');
    if (t) showTip(t, e.clientX, e.clientY);
    else tip.hidden = true;
  });
  root.addEventListener('pointerleave', () => (tip.hidden = true));
  root.addEventListener('focusin', (e) => {
    const t = (e.target as Element).closest('[data-tip]');
    if (!t) return;
    const r = t.getBoundingClientRect();
    showTip(t, r.left + r.width / 2, r.top + r.height / 2);
  });
  root.addEventListener('focusout', () => (tip.hidden = true));

  for (const b of el.querySelectorAll<HTMLButtonElement>('[data-page]'))
    b.onclick = () => {
      page = b.dataset.page as Page;
      for (const x of el.querySelectorAll('[data-page]')) x.setAttribute('aria-pressed', String(x === b));
      netEl.hidden = page !== 'net';
      borderEl.hidden = page !== 'border';
      if (page === 'border' && !borderEl.childElementCount) renderBorder();
    };

  // —————————————————————— 多门店网络 ——————————————————————
  netEl.innerHTML = `
    <section>
      <h2>${tr('多门店网络：选址、分配和线路')}</h2>
      <p class="lead">${tr('门店按规模折算货量，只算要经过仓的货（长途整车直送门店的不经过仓）。候选仓有现有的物流园（可以扩建）、新建配送中心和中转仓（不存货，物流园拣好的货用双挂车运过去换小车送）。每种开仓组合都精确求出最好的分配，再按实际排出的线路核算，取每年总成本最低的。')}</p>
      <div class="nw-controls">
        <label>${tr('门店数')} <input type="range" id="nw-n" min="1" max="${MAX_STORES}" step="1" value="${opts.n}"><output id="nw-n-out">${opts.n}</output></label>
        <label>${tr('需求增长')} <select id="nw-growth"><option value="1">${tr('现在')}</option><option value="1.3">+30%</option><option value="1.6">+60%</option><option value="2">${tr('翻一番')}</option></select></label>
        <label>${tr('远郊镇离高速口')} <select id="nw-outer"><option value="30">${tr('30 公里')}</option><option value="60">${tr('60 公里')}</option><option value="100">${tr('100 公里')}</option><option value="150">${tr('150 公里')}</option></select></label>
        <label>${tr('运价')} <select id="nw-freight"><option value="0.8">×0.8</option><option value="1">${tr('×1（现在）')}</option><option value="1.3">×1.3</option><option value="1.6">×1.6</option></select></label>
        <label><input type="checkbox" id="nw-expand"> ${tr('物流园可以扩建')}</label>
        <span class="note" id="nw-ms"></span>
      </div>
      <div class="heroes" id="nw-heroes"></div>
    </section>
    <section>
      <h2>${tr('地图')}</h2>
      <div class="nw-map" id="nw-map"></div>
      <ul class="nw-legend" aria-label="${tr('图例')}">
        <li><svg width="16" height="16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="3" fill="var(--nw-park)"/></svg>${tr('物流园（现有）')}</li>
        <li><svg width="16" height="16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="3" fill="var(--nw-dc)"/></svg>${tr('新建配送中心')}</li>
        <li><svg width="16" height="16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" transform="rotate(45 8 8)" fill="var(--nw-xd)"/></svg>${tr('中转仓')}</li>
        <li><svg width="16" height="16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="3" fill="none" stroke="var(--ink2)" stroke-dasharray="3 2"/></svg>${tr('候选，没选')}</li>
        <li><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="var(--ink)"/></svg>${tr('门店（越大规模越大）')}</li>
        <li><svg width="26" height="10" aria-hidden="true"><line x1="1" y1="5" x2="25" y2="5" stroke="var(--ink2)" stroke-width="2"/></svg>${tr('配送线路（颜色 = 送货的仓）')}</li>
        <li><svg width="26" height="10" aria-hidden="true"><line x1="1" y1="5" x2="25" y2="5" stroke="var(--nw-xd)" stroke-width="3" stroke-dasharray="6 4"/></svg>${tr('物流园 → 中转仓的干线')}</li>
      </ul>
      <h3>${tr('为什么这样选')}</h3>
      <ul class="nw-explain" id="nw-explain"></ul>
    </section>
    <section>
      <h2>${tr('每年的成本：今天的网络和建议的网络')}</h2>
      <p class="lead" id="nw-cost-lead"></p>
      <div class="table-wrap" id="nw-costs"></div>
    </section>
    <section>
      <h2>${tr('候选仓')}</h2>
      <p class="lead">${tr('每个候选单独加上（没选的）或去掉（选了的），其余照建议的网络，每年的总成本差多少。')}</p>
      <div class="table-wrap" id="nw-sites"></div>
    </section>
    <section>
      <h2>${tr('各店由谁送')}</h2>
      <div class="table-wrap" id="nw-stores"></div>
    </section>
    <section>
      <h2>${tr('开仓组合的排名')}</h2>
      <p class="lead">${tr('每种组合先用选址模型求最优分配（分支定界，精确），再按排出来的线路核算；这里列核算成本最低的几种。')}</p>
      <div class="table-wrap" id="nw-ranked"></div>
    </section>
    <section>
      <h2>${tr('货不够时怎么分（公平分配）')}</h2>
      <p class="lead">${tr('每家店的目标库存 =（到货提前期 + 补货周期）的预测销量 + 安全库存。货够就都补到目标；不够时让每家店都补到目标的同一个比例——库存本来就少的店先补，而不是按销量比例平分。门店手上的库存是合成的示例。')}</p>
      <div class="nw-alloc-head">
        <label>${tr('商品族')} <select id="nw-fam">${ALLOC_FAMILIES.map((f) => `<option value="${f.key}">${esc(tx(f.label))}</option>`).join('')}</select></label>
        <label>${tr('到货是需要的')} <select id="nw-supply"><option value="0.5">50%</option><option value="0.7">70%</option><option value="0.85">85%</option><option value="1">100%</option><option value="1.1">110%</option></select></label>
      </div>
      <div class="heroes" id="nw-alloc-heroes"></div>
      <div class="table-wrap" id="nw-alloc"></div>
    </section>
    <section>
      <p class="note">${tr('假设：配送车六成电动、四成柴油，多温区挂车每车 24 托、按九成装，每辆车一天跑 {n1} 小时；物流园现在每天能出 {park} 托，扩建多 {expand} 托（投资 {wan} 万美元）；新建配送中心每天 {dc} 托（投资 {wan2} 万美元），中转仓每天转 {xd} 托（投资 {wan3} 万美元）；投资按 7% 折成每年的年金；超出能力交第三方仓每托多付 {overflowPerPallet} 美元；安全库存在一个仓时约 {safetyDays} 天的货，分仓存按平方根定律变多。数字是合成的，按公开资料里的常见区间取。', { n1: n1(NET.shiftHours), park: NET.capacity.park, expand: NET.capacity.expand, wan: wan(NET.capex.expand.cost), dc: NET.capacity.dc, wan2: wan(NET.capex.dc.cost), xd: NET.capacity.xd, wan3: wan(NET.capex.xd.cost), overflowPerPallet: NET.overflowPerPallet, safetyDays: NET.safetyDays })}</p>
    </section>`;
  const q = <T extends HTMLElement>(id: string) => netEl.querySelector(`#${id}`) as T;
  q<HTMLSelectElement>('nw-growth').value = String(opts.params.growth);
  q<HTMLSelectElement>('nw-outer').value = String(opts.outerKm);
  q<HTMLSelectElement>('nw-freight').value = String(opts.params.freight);
  q<HTMLInputElement>('nw-expand').checked = opts.params.allowExpand;
  q<HTMLSelectElement>('nw-fam').value = allocFam;
  q<HTMLSelectElement>('nw-supply').value = String(allocSupply);
  const readNet = () => {
    opts.n = Number(q<HTMLInputElement>('nw-n').value);
    q('nw-n-out').textContent = String(opts.n);
    opts.outerKm = Number(q<HTMLSelectElement>('nw-outer').value);
    opts.params = { growth: Number(q<HTMLSelectElement>('nw-growth').value), freight: Number(q<HTMLSelectElement>('nw-freight').value), allowExpand: q<HTMLInputElement>('nw-expand').checked };
    renderNet();
  };
  // 拖动门店数时合并到下一帧再算（一次几十毫秒）
  let pending = 0;
  q<HTMLInputElement>('nw-n').oninput = () => {
    q('nw-n-out').textContent = q<HTMLInputElement>('nw-n').value;
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(readNet);
  };
  for (const id of ['nw-growth', 'nw-outer', 'nw-freight', 'nw-expand']) q(id).onchange = readNet;
  q<HTMLSelectElement>('nw-fam').onchange = () => {
    allocFam = q<HTMLSelectElement>('nw-fam').value;
    renderAlloc();
  };
  q<HTMLSelectElement>('nw-supply').onchange = () => {
    allocSupply = Number(q<HTMLSelectElement>('nw-supply').value);
    renderAlloc();
  };

  // 英文界面：方案名、门店和仓的名字先换成英文，「N 万美元」换成 $840k 这样的写法，再整句查字典（名字不用在句子里一层层查）
  let names: [string, string][] = [];
  const setNames = (p: NetPlan) => {
    if (!isEn()) return;
    const m = new Map<string, string>();
    // 「物流园…」「综合店」本身就在句子的固定部分里，不换（字典里整条有）
    for (const x of [...p.stores.map((st) => st.name), ...p.sites.flatMap((st) => [st.name, st.short])]) if (!x.startsWith('物流园') && x !== '综合店') m.set(x, tx(x));
    for (const r of [...p.ranked, p.best, p.modelBest, p.today]) {
      const n = planName(p, r);
      if (n.includes(' + ')) m.set(n, planEn(n));
    }
    names = [...m].filter(([zh, en]) => zh !== en && !HAN.test(en)).sort((a, b) => b[0].length - a[0].length);
  };
  const nx = (s: string) => {
    if (!isEn() || !HAN.test(s)) return s;
    let out = s;
    for (const [zh, en] of names) if (out.includes(zh)) out = out.split(zh).join(en);
    out = out.replace(/(\d[\d,]*(?:\.\d+)?) 万美元/g, (_m, v: string) => usdShort(Number(v.replace(/,/g, '')) * 1e4));
    return tx(out);
  };
  /** 地图（src 里画的 SVG）上的字、悬停说明和 aria-label：英文界面换成英文 */
  const mapEn = (host: HTMLElement) => {
    if (!isEn()) return;
    const tw = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) if (n.nodeValue && HAN.test(n.nodeValue)) n.nodeValue = nx(n.nodeValue);
    for (const e of host.querySelectorAll('[data-tip],[aria-label]'))
      for (const a of ['data-tip', 'aria-label']) {
        const v = e.getAttribute(a);
        if (v && HAN.test(v)) e.setAttribute(a, nx(v));
      }
  };

  function renderNet(): void {
    const p = planNetwork(opts);
    plan = p;
    setNames(p);
    const b = p.best;
    const t = p.today;
    const save = t.eval.costs.total - b.eval.costs.total;
    q('nw-ms').textContent = tr('规划用时 {ms} 毫秒', { ms: Math.round(p.ms) });
    q('nw-heroes').innerHTML = [
      `<div class="hero"><div class="k">${tr('建议的网络')}</div><div class="v nw-hero-name">${esc(nx(planName(p, b)))}</div><div class="from">${tr('{length} 家店 · 每天经仓 {n0} 托', { length: p.stores.length, n0: n0(p.pallets) })}</div></div>`,
      `<div class="hero"><div class="k">${tr('每年总成本')}</div><div class="v">${wan(b.eval.costs.total)}<small class="nw-unit">${tr('万美元')}</small></div><div class="from">${b.mask === 0 ? tr('就是今天的网络') : tr('今天的网络 {wan} 万 · 省 {wan2} 万', { wan: wan(t.eval.costs.total), wan2: wan(save) })}</div></div>`,
      `<div class="hero"><div class="k">${tr('配送车 · 每天里程')}</div><div class="v">${b.eval.vehicles}<small class="nw-unit">${tr('辆')}</small></div><div class="from">${tr('{n0} 公里 · {length} 趟', { n0: n0(b.eval.kmDay), length: b.eval.trips.length })}</div></div>`,
      `<div class="hero"><div class="k">${tr('最远的店的车程')}</div><div class="v">${n1(b.eval.maxHours.hours)}<small class="nw-unit">${tr('小时')}</small></div><div class="from">${tr('平均（按货量） {n1} 小时', { n1: n1(b.eval.avgHours) })}</div></div>`,
    ].join('');
    q('nw-map').innerHTML = networkMap(p, b, 'nw-map-svg');
    mapEn(q('nw-map'));
    q('nw-explain').innerHTML = p.explain.map((s) => `<li>${esc(nx(s))}</li>`).join('');
    // 成本表
    q('nw-cost-lead').textContent = b.mask === 0 ? tr('建议的网络就是今天的网络（只有物流园）。') : tr('今天的网络：只有物流园{v1}。单位：万美元 / 年。', { v1: t.eval.overflowPallets > 0.5 ? tr('，每天超出能力的 {n0} 托交第三方仓', { n0: n0(t.eval.overflowPallets) }) : '' });
    q('nw-costs').innerHTML = `<table><thead><tr><th>${tr('项目')}</th><th>${tr('今天的网络')}</th><th>${tr('建议的网络')}</th><th>${tr('差（建议 − 今天）')}</th></tr></thead><tbody>${PARTS.map(([k, label]) => {
      const d = b.eval.costs[k] - t.eval.costs[k];
      return `<tr><td>${label}</td><td>${wan(t.eval.costs[k])}</td><td>${wan(b.eval.costs[k])}</td><td class="${d > 5_000 ? 'pos' : d < -5_000 ? 'neg' : ''}">${signedWan(d)}</td></tr>`;
    }).join('')}<tr class="pick"><td>${tr('合计')}</td><td>${wan(t.eval.costs.total)}</td><td>${wan(b.eval.costs.total)}</td><td class="${save > 5_000 ? 'neg' : ''}">${signedWan(-save)}</td></tr><tr><td>${tr('配送车 / 每天里程')}</td><td>${tr('{vehicles} 辆 / {n0} 公里', { vehicles: t.eval.vehicles, n0: n0(t.eval.kmDay) })}</td><td>${tr('{vehicles} 辆 / {n0} 公里', { vehicles: b.eval.vehicles, n0: n0(b.eval.kmDay) })}</td><td></td></tr></tbody></table>`;
    // 候选仓
    const tg = new Map(p.toggles.map((x) => [x.key, x] as const));
    const siteRows = p.sites.map((s) => {
      const on = b.eval.open.includes(s.key);
      const use = b.eval.sites.find((u) => u.key === s.key);
      const x = tg.get(s.key);
      const tag = `<span class="nw-tag"><i class="${s.kind}" style="background:var(--nw-${s.kind})"></i>${esc(nx(s.name))}</span>`;
      const effect = s.kind === 'park' ? tr('一直开着') : x ? `${x.chosen ? tr('去掉') : tr('加上')}${tr('：每年 {v1}{wan} 万', { v1: x.delta >= 0 ? '+' : '−', wan: wan(Math.abs(x.delta)) })}${!x.chosen && x.used === 0 ? `${sp()}${tr('（没有店划给它）')}` : ''}` : '';
      return `<tr class="${on ? 'pick' : ''}"><td>${tag}</td><td>${tx(SITE_KIND_LABEL[s.kind])}</td><td>${tr('{n0} 托 / 天', { n0: n0(capacityOf(s, false)) })}</td><td>${wan(fixedCost(s))}</td><td>${on ? tr('开 · 出 {n0} 托、送 {length} 家店', { n0: n0(use?.load ?? 0), length: use?.stores.length ?? 0 }) : tr('没选')}</td><td>${effect}</td></tr>`;
    });
    const ex = tg.get('expand');
    if (opts.params.allowExpand) siteRows.push(`<tr class="${b.choice.expanded ? 'pick' : ''}"><td>${tr('物流园扩建')}</td><td>${tr('扩建')}</td><td>${tr('+{expand} 托 / 天', { expand: NET.capacity.expand })}</td><td>${wan(fixedCost('expand'))}</td><td>${b.choice.expanded ? tr('扩建') : tr('不扩建')}</td><td>${ex ? `${ex.chosen ? tr('不扩建') : tr('扩建')}${tr('：每年 {v1}{wan} 万', { v1: ex.delta >= 0 ? '+' : '−', wan: wan(Math.abs(ex.delta)) })}` : ''}</td></tr>`);
    q('nw-sites').innerHTML = `<table><thead><tr><th>${tr('候选')}</th><th>${tr('类型')}</th><th>${tr('能力')}</th><th>${tr('固定成本（万美元 / 年）')}</th><th>${tr('建议的网络里')}</th><th>${tr('单独改动的影响')}</th></tr></thead><tbody>${siteRows.join('')}</tbody></table>`;
    // 门店
    q('nw-stores').innerHTML = `<table><thead><tr><th>${tr('门店')}</th><th>${tr('类型')}</th><th>${tr('规模')}</th><th>${tr('每天经仓（托）')}</th><th>${tr('由谁送')}</th><th>${tr('车程')}</th><th>${tr('里程')}</th></tr></thead><tbody>${p.stores
      .map((s, i) => {
        const site = p.sites.find((x) => x.key === b.eval.assign[s.key]);
        const leg = site ? p.inst.d.leg(site.point, s.point) : undefined;
        return `<tr><td>${esc(nx(s.name))}${s.outer ? `${sp()}${tr('（出高速口 {km} 公里）', { km: Math.round(s.outer.km) })}` : ''}</td><td>${tx(STORE_KIND_LABEL[s.kind])}</td><td>${n1(s.size)}</td><td>${n1(p.inst.pallets[i] as number)}</td><td>${site ? `<span class="nw-tag"><i class="${site.kind}" style="background:var(--nw-${site.kind})"></i>${esc(nx(site.short))}</span>` : ''}</td><td>${leg ? hrs(leg.hours) : ''}</td><td>${leg ? tr('{n0} 公里', { n0: n0(leg.km) }) : ''}</td></tr>`;
      })
      .join('')}</tbody></table>`;
    // 排名
    q('nw-ranked').innerHTML = `<table><thead><tr><th>${tr('开仓组合')}</th><th>${tr('选址模型（万美元 / 年）')}</th><th>${tr('按线路核算（万美元 / 年）')}</th><th>${tr('配送车')}</th><th>${tr('超出能力（托 / 天）')}</th></tr></thead><tbody>${p.ranked
      .slice(0, 8)
      .map((r, i) => `<tr class="${i === 0 ? 'pick' : ''}"><td>${esc(nx(planName(p, r)))}${r.mask === 0 ? `${sp()}${tr('（今天）')}` : ''}</td><td>${wan(r.choice.objective)}</td><td>${wan(r.eval.costs.total)}</td><td>${r.eval.vehicles}</td><td>${r.eval.overflowPallets > 0.5 ? n0(r.eval.overflowPallets) : '—'}</td></tr>`)
      .join('')}</tbody></table><p class="note">${tr('一共 {combos} 种开仓组合；选址模型里比最优贵 {window} 以上的 {max} 种没有逐一按线路核算（按线路核算的第一名在选址模型里离最优从来不到 0.2%）。', { combos: p.combos, window: pct(p.window), max: Math.max(0, p.combos - p.ranked.length) })}${p.ranked.some((r) => !r.choice.exact) ? tr('有的组合在节点上限内没有算完（结果可能不是精确最优）。') : ''}</p>`;
    renderAlloc();
  }

  function renderAlloc(): void {
    if (!plan) return;
    const a = allocate(plan.stores, allocFam, allocSupply, opts.params.growth);
    const short = a.supply < a.need - 1e-9;
    q('nw-alloc-heroes').innerHTML = [
      `<div class="hero"><div class="k">${tr('到货 / 需要补')}</div><div class="v">${n0(a.supply)}<small class="nw-unit">${tr('件')}</small></div><div class="from">${tr('需要 {n0} 件（{allocSupply}）', { n0: n0(a.need), allocSupply: pct(allocSupply) })}</div></div>`,
      `<div class="hero"><div class="k">${tr('每家店补到目标的')}</div><div class="v">${short ? pct(a.ratio) : '100%'}</div><div class="from">${short ? tr('各店同一个比例') : tr('货够，都补到目标')}</div></div>`,
      `<div class="hero"><div class="k">${tr('最差那家店的满足率')}</div><div class="v">${pct(a.worstFill, 1)}</div><div class="from">${tr('按销量比例分：{worstPropFill}', { worstPropFill: pct(a.worstPropFill, 1) })}</div></div>`,
      `<div class="hero"><div class="k">${tr('商品族')}</div><div class="v nw-hero-name">${esc(tx(a.family.label))}</div><div class="from">${tr('{length} 家店 · 每天补一次', { length: plan.stores.length })}</div></div>`,
    ].join('');
    q('nw-alloc').innerHTML = `<table><thead><tr><th>${tr('门店')}</th><th>${tr('每天预测（件）')}</th><th>${tr('手上的库存')}</th><th>${tr('安全库存')}</th><th>${tr('目标')}</th><th>${tr('需要补')}</th><th>${tr('分到')}</th><th>${tr('分完够卖')}</th><th>${tr('满足率')}</th><th>${tr('按销量比例分的满足率')}</th></tr></thead><tbody>${a.rows
      .map((r) => `<tr><td>${esc(nx(r.name))}</td><td>${n0(r.demand)}</td><td>${n0(r.onHand)}</td><td>${n0(r.safety)}</td><td>${n0(r.target)}</td><td>${n0(r.need)}</td><td>${n0(r.alloc)}</td><td>${tr('{n1} 天', { n1: n1(r.cover) })}</td><td>${pct(r.fill, 1)}</td><td class="${r.propFill < r.fill - 0.005 ? 'pos' : ''}">${pct(r.propFill, 1)}</td></tr>`)
      .join('')}</tbody></table>`;
  }

  // —————————————————————— 跨境 ——————————————————————
  function renderBorder(): void {
    borderEl.innerHTML = `
      <section>
        <h2>${tr('跨境：清关步骤、单证、税费和汇率')}</h2>
        <p class="lead">${tr('四种跨境来货：东面跨境公路的整车、海运集装箱、洲际铁路班列、空运。清关时间拆成一步一步，加起来正好是仿真里用的数（跨境公路多 2 天、海运箱在堆场的停留、班列到站后进配送中心的时间、空运落地后出货站的时间）；不改仿真。税率、费用、查验概率和汇率（1 美元 = {baseRate} 本币）是合成的示例，不是任何国家的实际税则。', { baseRate: BASE_RATE.toFixed(2) })}</p>
        <div class="nw-controls"><span class="seg" id="cb-gen" role="group" aria-label="${tr('方案')}"><button data-g="g1" aria-pressed="false">${tr('上一代')}</button><button data-g="g3" aria-pressed="true">${tr('StoreX 全链路（预清关）')}</button></span></div>
        <div class="heroes" id="cb-heroes"></div>
      </section>
      <section>
        <h2>${tr('清关要多久')}</h2>
        <p class="lead">${tr('上一代到货以后才开始报关；全链路在货还在路上时就预申报，到了基本直接放行。跨境公路两代都按仿真里的「多 2 天」。')}</p>
        <div class="table-wrap" id="cb-times"></div>
      </section>
      <div class="nw-grid2" id="cb-flows"></div>
      <section>
        <h2>${tr('到岸成本（按综合店一年的量）')}</h2>
        <p class="lead">${tr('到岸成本 = 货值 + 国际运费 + 保险 + 关税（按到岸价算）+ 口岸费用（报关代理、码头 / 场站操作、查验的期望费用）；进口增值税可以抵扣，单列、不算进成本。单位：本币。')}</p>
        <div class="table-wrap" id="cb-landed"></div>
      </section>
      <section>
        <h2>${tr('汇率变了怎么样')}</h2>
        <p class="lead" id="cb-fx-lead"></p>
        <div class="nw-chart" id="cb-tornado"></div>
        <div class="table-wrap" id="cb-scen"></div>
      </section>`;
    const qb = <T extends HTMLElement>(id: string) => borderEl.querySelector(`#${id}`) as T;
    for (const b of borderEl.querySelectorAll<HTMLButtonElement>('[data-g]'))
      b.onclick = () => {
        gen = b.dataset.g as 'g1' | 'g3';
        for (const x of borderEl.querySelectorAll('[data-g]')) x.setAttribute('aria-pressed', String(x === b));
        fill();
      };
    const fill = () => {
      const cb = crossBorder(gen);
      const other = crossBorder(gen === 'g3' ? 'g1' : 'g3');
      const g1 = gen === 'g1' ? cb : other;
      const g3 = gen === 'g3' ? cb : other;
      const total = cb.scenarios.find((s) => s.change === 0)?.total ?? 0;
      const decl = cb.flows.reduce((a, f) => a + f.declarations, 0);
      const sea = (c: CrossBorder) => c.flows.find((f) => f.mode === 'sea') as BorderFlow;
      const tied = cb.flows.reduce((a, f) => a + f.tied.cost, 0);
      qb('cb-heroes').innerHTML = [
        `<div class="hero"><div class="k">${tr('每年到岸成本')}</div><div class="v">${wan(total)}<small class="nw-unit">${tr('万本币')}</small></div><div class="from">${tr('另有可抵扣的进口增值税 {wan} 万', { wan: wan(cb.flows.reduce((a, f) => a + f.annual.vat, 0)) })}</div></div>`,
        `<div class="hero"><div class="k">${tr('汇率每变 1%')}</div><div class="v">±${wan(cb.perPoint)}<small class="nw-unit">${tr('万本币')}</small></div><div class="from">${tr('每年到岸成本跟着变')}</div></div>`,
        `<div class="hero"><div class="k">${tr('每年报关')}</div><div class="v">${n0(decl)}<small class="nw-unit">${tr('票')}</small></div><div class="from">${tr('整车、整箱、空运各算一票')}</div></div>`,
        `<div class="hero"><div class="k">${tr('海运箱在港口停留')}</div><div class="v">${n1(sea(cb).totalHours / 24)}<small class="nw-unit">${tr('天')}</small></div><div class="from">${gen === 'g3' ? tr('上一代 {n1} 天', { n1: n1(sea(g1).totalHours / 24) }) : tr('全链路 {n1} 天', { n1: n1(sea(g3).totalHours / 24) })} ${tr('· 清关压货的资金成本 {wan} 万 / 年', { wan: wan(tied) })}</div></div>`,
      ].join('');
      qb('cb-times').innerHTML = `<table><thead><tr><th>${tr('来货')}</th><th>${tr('仿真里的数字')}</th><th>${tr('上一代')}</th><th>${tr('StoreX 全链路')}</th><th>${tr('其中海关手续（全链路）')}</th></tr></thead><tbody>${g3.flows
        .map((f, i) => {
          const a = g1.flows[i] as BorderFlow;
          const customs = f.steps.filter((s) => s.customs).reduce((x, s) => x + s.hours, 0);
          return `<tr><td>${tx(MODE_LABEL[f.mode])}</td><td>${esc(tx(f.sim.label.replace(/^仿真：/, '')))}</td><td>${hrs(a.totalHours)}</td><td>${hrs(f.totalHours)}</td><td>${hrs(customs)}</td></tr>`;
        })
        .join('')}</tbody></table>`;
      qb('cb-flows').innerHTML = cb.flows.map((f) => flowCard(f)).join('');
      qb('cb-landed').innerHTML = `<table><thead><tr><th>${tr('商品族')}</th><th>${tr('每年（箱）')}</th><th>${tr('货值 / 箱')}</th><th>${tr('运费')}</th><th>${tr('保险')}</th><th>${tr('关税（税率）')}</th><th>${tr('口岸费用')}</th><th>${tr('到岸 / 箱')}</th><th>${tr('每年到岸（万）')}</th><th>${tr('增值税（可抵扣）/ 箱')}</th></tr></thead><tbody>${cb.flows
        .flatMap((f) => [
          `<tr class="group"><td colspan="10">${tx(MODE_LABEL[f.mode])}</td></tr>`,
          ...f.families.map((x) => `<tr><td>${esc(tx(x.label))}</td><td>${n0(x.casesPerYear)}</td><td>${n1(x.goods * cb.rate)}</td><td>${n1(x.freight * cb.rate)}</td><td>${n1(x.insurance * cb.rate)}</td><td>${n1(x.duty * cb.rate)}${paren(pct(x.dutyRate, 1))}</td><td>${n1(x.feesLcu)}</td><td>${n1(x.landedLcu)}</td><td>${wan(x.landedLcu * x.casesPerYear)}</td><td>${n1(x.vatLcu)}</td></tr>`),
        ])
        .join('')}</tbody></table>`;
      qb('cb-fx-lead').textContent = tr('本币贬值（1 美元换更多本币）时，按美元计价的货值、运费、保险跟着变贵，关税按到岸价算也跟着涨；口岸费用是本币的不变。下图是汇率变 ±{shock} 时每种来货一年的到岸成本变多少（万本币）。', { shock: pct(cb.shock) });
      qb('cb-tornado').innerHTML = tornado(cb);
      const modes = cb.flows.map((f) => f.mode);
      qb('cb-scen').innerHTML = `<table><thead><tr><th>${tr('每年到岸成本（万本币）')}</th>${cb.scenarios.map((s) => `<th>${s.change === 0 ? tr('现在（{rate}）', { rate: s.rate.toFixed(2) }) : `${s.change > 0 ? '+' : '−'}${pct(Math.abs(s.change))}${paren(s.rate.toFixed(2))}`}</th>`).join('')}</tr></thead><tbody>${modes
        .map((m) => `<tr><td>${tx(MODE_LABEL[m])}</td>${cb.scenarios.map((s) => `<td>${wan(s.byMode[m])}</td>`).join('')}</tr>`)
        .join('')}<tr class="pick"><td>${tr('合计')}</td>${cb.scenarios.map((s) => `<td>${wan(s.total)}</td>`).join('')}</tr></tbody></table>`;
    };
    fill();
  }

  function flowCard(f: BorderFlow): string {
    const max = Math.max(...f.steps.map((s) => s.hours), 1e-9);
    const steps = f.steps
      .map((s) => `<tr data-tip="${esc(isEn() ? `${tx(s.label)}: ${tx(s.note)}` : `${s.label}：${s.note}`)}"><td>${esc(tx(s.label))}<small class="nw-kind">${s.customs ? tr('海关') : tr('装卸 / 等待')}</small></td><td>${hrs(s.hours)}${s.prob !== undefined ? `<small class="nw-prob">${pct(s.prob, 1)} × ${hrs(s.each ?? 0)}</small>` : ''}</td><td class="nw-barcell"><span class="nw-bar${s.customs ? '' : ' non'}" style="width:${Math.max(2, (s.hours / max) * 100).toFixed(0)}%"></span></td></tr>`)
      .join('');
    // 跨境来的生鲜（冷藏、冷冻）都走冷链：要检疫证书的货也要温度记录
    const fresh = f.families.some((x) => x.fresh);
    const reefer = fresh;
    const docs = f.docs
      .filter((d) => d.need === 'all' || d.need === 'origin' || (d.need === 'fresh' && fresh) || (d.need === 'reefer' && reefer))
      .map((d) => `<li><b>${esc(capEn(tx(d.label)))}</b><span>${esc(tx(d.detail))}</span><em>${d.need === 'all' ? tr('每票') : d.need === 'origin' ? tr('享受协定税率时') : d.need === 'fresh' ? tr('生鲜') : tr('冷链')}</em></li>`)
      .join('');
    return `<section class="nw-card">
      <h3>${tx(MODE_LABEL[f.mode])}</h3>
      <p class="note">${f.families.map((x) => esc(tx(x.label))).join(isEn() ? ', ' : '、')} ${tr('· 每年约 {n0} 票 · 查验概率：单证复核 {docs}、开箱 {physical}', { n0: n0(f.declarations), docs: pct(f.inspection.docs), physical: pct(f.inspection.physical) })}${fresh ? tr('、生鲜抽样 {lab}', { lab: pct(f.inspection.lab) }) : ''}</p>
      <div class="table-wrap"><table class="nw-steps"><thead><tr><th>${tr('步骤')}</th><th>${tr('期望时长')}</th><th><span class="nw-sr">${tr('占比')}</span></th></tr></thead><tbody>${steps}<tr class="pick"><td>${tr('合计')}</td><td>${hrs(f.totalHours)}</td><td></td></tr></tbody></table></div>
      <p class="note">${tr('{replace}。灰色条是装卸、排队和等车，不是海关的时间。', { replace: esc(simText(f.sim.label)) })}</p>
      <ul class="nw-docs" aria-label="${tr('单证')}">${docs}</ul>
    </section>`;
  }

  renderNet();
}

/** 汇率 ±shock 时每种来货一年的到岸成本变化：横条（左蓝 = 本币升值省下的，右红 = 本币贬值多花的），零线居中 */
function tornado(cb: CrossBorder): string {
  const rows = cb.tornado;
  const W = 720;
  const rowH = 40;
  const top = 40;
  const labelW = 150;
  const H = top + rows.length * rowH + 16;
  const max = Math.max(...rows.map((r) => Math.max(Math.abs(r.low), Math.abs(r.high))), 1);
  const half = (W - labelW - 90) / 2;
  const cx = labelW + 45 + half;
  const sx = (v: number) => (v / max) * half;
  const bar = (x0: number, w: number, y: number, h: number, right: boolean) => {
    // 4px 圆角只在数据那一头，零线那头是直角
    const r = Math.min(4, Math.abs(w) / 2, h / 2);
    if (right) return `M${x0},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r)}z`;
    return `M${x0},${y}h${-(w - r)}a${r},${r} 0 0 0 ${-r},${r}v${h - 2 * r}a${r},${r} 0 0 0 ${r},${r}h${w - r}z`;
  };
  const sh = pct(cb.shock);
  let body = `<line x1="${cx}" y1="${top - 8}" x2="${cx}" y2="${H - 10}" stroke="var(--nw-axis)" stroke-width="1"/>`;
  rows.forEach((r, i) => {
    const y = top + i * rowH + 11;
    const h = 18;
    const wl = sx(Math.abs(r.low));
    const wh = sx(Math.abs(r.high));
    const tip = tr('{mode}：本币升值 {sh} 每年省 {wan} 万本币，贬值 {sh2} 每年多花 {wan2} 万本币', { mode: tx(MODE_LABEL[r.mode]), sh, wan: wan(Math.abs(r.low)), sh2: sh, wan2: wan(Math.abs(r.high)) });
    body += `<text x="${labelW}" y="${y + 13}" text-anchor="end" class="lb">${tx(MODE_LABEL[r.mode])}</text>`;
    body += `<rect class="hit" x="${labelW + 8}" y="${y - 10}" width="${W - labelW - 16}" height="${rowH - 2}" fill="transparent" tabindex="0" role="img" aria-label="${esc(tip)}" data-tip="${esc(tip)}"/>`;
    body += `<path class="bar" d="${bar(cx - 1, wl, y, h, false)}" fill="var(--nw-down)" pointer-events="none"/>`;
    body += `<path class="bar" d="${bar(cx + 1, wh, y, h, true)}" fill="var(--nw-up)" pointer-events="none"/>`;
    body += `<text x="${cx - wl - 6}" y="${y + 13}" text-anchor="end" class="v">−${wan(Math.abs(r.low))}</text>`;
    body += `<text x="${cx + wh + 6}" y="${y + 13}" class="v">+${wan(Math.abs(r.high))}</text>`;
  });
  const legend = `<g transform="translate(${labelW + 8},14)"><rect width="12" height="12" rx="3" fill="var(--nw-down)"/><text x="18" y="10" class="lg">${tr('本币升值 {sh}（省）', { sh })}</text><rect x="150" width="12" height="12" rx="3" fill="var(--nw-up)"/><text x="168" y="10" class="lg">${tr('本币贬值 {sh}（多花）', { sh })}</text><text x="${W - labelW - 16}" y="10" text-anchor="end" class="lg">${tr('万本币 / 年')}</text></g>`;
  const style = `<style>.nw-chart .lb{fill:var(--ink);font-size:12px}.nw-chart .v{fill:var(--ink2);font-size:12px;font-variant-numeric:tabular-nums}.nw-chart .lg{fill:var(--ink2);font-size:12px}</style>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="${tr('汇率变 ±{sh} 时每种来货一年的到岸成本变化', { sh })}">${style}${legend}${body}</svg>`;
}
