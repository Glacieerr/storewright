import { LiveClient } from '@storewright/ops/client';
import type { OpsState } from '@storewright/ops';
import { getLang, setLang, t } from '../i18n';
import { link, servePortRequests } from './transport';
import './showcase.css';

/**
 * 展示页：同一个浏览器里，运营模拟器（门店实况）、演示控制台和两部员工手机，
 * 全部连到浏览器里的同一个门店中枢（SharedWorker），任何一边的操作都会实时出现在其他画面里。
 * 上方的引导按门店的实时状态自动打勾：下单 → 拣货 → 暂存 → 到店 → 交付 → AI。
 * 窄屏（手机）上一次只显示一个画面，用标签切换。
 * 地址参数：?store=hardware 换成家居建材店；?sim=模拟器地址（默认 ../sim/）。
 */

const q = new URLSearchParams(location.search);
const store = q.get('store') === 'hardware' ? 'hardware' : 'demo';
const simBase = q.get('sim') ?? '../sim/';
// 不支持 SharedWorker 的浏览器：iframe 向本页要端口
servePortRequests();

const PHONES: Array<{ id: string; label: string }> = [
  { id: 'A01', label: '拣货员 Avery' },
  { id: 'A04', label: '暂存员 Riley' },
  { id: 'A05', label: '交付员 Morgan' },
  { id: 'A08', label: '带班负责人 Taylor' },
  { id: 'A09', label: '后仓 Drew' },
];

interface Step {
  title: string;
  hint: string;
  done: (s: OpsState) => boolean;
}

const STEPS: Step[] = [
  { title: '下单', hint: '在控制台点「创建」，下一张自取订单（默认立即锁单并生成拣货批次）。', done: (s) => Object.keys(s.orders).length > 0 },
  { title: '拣货', hint: '第一部手机（拣货员）：领取批次，点框绑定标签，逐行点「已拣到」，最后「完成拣货，去暂存」。', done: (s) => Object.values(s.totes).some((x) => x.status === 'PICKED' || x.status === 'STAGED' || x.status === 'PULLED' || x.status === 'HANDED_OFF') },
  { title: '暂存', hint: '把第一部手机切换成「暂存员 Riley」，逐框点选，放进建议的格位。', done: (s) => Object.values(s.orders).some((o) => o.stagedAt !== undefined) },
  { title: '到店', hint: '在控制台点这张订单的「我在路上」和「到店」——交付看板变色，模拟器里出现顾客的车。', done: (s) => Object.values(s.orders).some((o) => o.arrivedAt !== undefined) },
  { title: '交付', hint: '第二部手机（交付员）：打开这张订单，开始准备、逐框核对，输入控制台显示的验证码，完成交付。', done: (s) => Object.values(s.orders).some((o) => o.status === 'COMPLETED') },
  { title: 'AI', hint: '把一部手机切换成「带班负责人 Taylor」，打开 AI 页：每条建议都有理由和置信度，可以采纳或否决。', done: (s) => Object.values(s.recs).some((r) => r.status === 'ACCEPTED' || r.status === 'OVERRIDDEN' || r.status === 'DISMISSED') },
];

const GUIDE_KEY = 'storewright.showcase.guide';

function appUrl(as: string): string {
  return `./?demo&store=${store}&as=${as}${as === 'console' ? '&embed' : ''}`;
}

function simUrl(): string {
  const bridge = new URL('./bridge.html', location.href).href;
  return `${simBase}${simBase.includes('?') ? '&' : '?'}live=demo&store=${store}&bridge=${encodeURIComponent(bridge)}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function phone(initial: string): { box: HTMLElement; select: HTMLSelectElement } {
  const box = el('section', 'phone');
  const head = el('div', 'phone-head');
  const select = el('select');
  select.setAttribute('aria-label', t('员工手机'));
  for (const p of PHONES) {
    const o = el('option', undefined, t(p.label));
    o.value = p.id;
    if (p.id === initial) o.selected = true;
    select.appendChild(o);
  }
  const frame = el('iframe');
  frame.title = t('员工手机');
  frame.src = appUrl(initial);
  select.onchange = () => (frame.src = appUrl(select.value));
  head.append(select);
  box.append(head, frame);
  return { box, select };
}

/** 以查看者身份连到中枢，用实时状态给引导打勾 */
async function watch(onState: (s: OpsState) => void): Promise<LiveClient> {
  const res = await link.fetch(`/api/stores/${store}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'viewer' }) });
  const { token } = (await res.json()) as { token: string };
  const c = new LiveClient({ baseUrl: '', storeId: store, token, WebSocketImpl: link.WebSocket as unknown as typeof WebSocket, fetchImpl: link.fetch as unknown as typeof fetch, onChange: () => onState(c.state) });
  c.connect();
  return c;
}

async function resetStore(): Promise<void> {
  const res = await link.fetch(`/api/stores/${store}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'console' }) });
  const { token } = (await res.json()) as { token: string };
  await link.fetch(`/api/stores/${store}/demo/reset`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' });
}

function guide(): { box: HTMLElement; update: (s: OpsState) => void } {
  const box = el('section', 'sc-guide');
  const head = el('div', 'sc-guide-head');
  const title = el('b', undefined, t('跟着做一遍（约 3 分钟）'));
  const toggle = el('button', 'link');
  let open = true;
  try {
    open = localStorage.getItem(GUIDE_KEY) !== 'closed';
  } catch {
    // 本机存储不可用时默认展开
  }
  const list = el('ol', 'sc-steps');
  const hint = el('p', 'sc-hint');
  const items = STEPS.map((s, i) => {
    const li = el('li');
    li.append(el('span', 'n', String(i + 1)), el('span', 'label', t(s.title)));
    list.append(li);
    return li;
  });
  const apply = () => {
    list.hidden = !open;
    hint.hidden = !open;
    toggle.textContent = open ? t('收起') : t('展开引导');
  };
  toggle.onclick = () => {
    open = !open;
    try {
      localStorage.setItem(GUIDE_KEY, open ? 'open' : 'closed');
    } catch {
      // 忽略
    }
    apply();
  };
  head.append(title, toggle);
  box.append(head, list, hint);
  apply();
  const update = (s: OpsState) => {
    const done = STEPS.map((x) => x.done(s));
    const current = done.findIndex((d) => !d);
    items.forEach((li, i) => {
      li.className = done[i] ? 'done' : i === current ? 'current' : '';
    });
    hint.textContent = current < 0 ? t('全部完成！可以换成家居建材店再试一次，或者在模拟器里切换 3D 视角看门店。') : `${current + 1}. ${t(STEPS[current]?.hint ?? '')}`;
  };
  update({ orders: {}, totes: {}, recs: {} } as unknown as OpsState);
  return { box, update };
}

function render(): void {
  document.documentElement.lang = getLang() === 'zh' ? 'zh-CN' : 'en';
  const root = document.getElementById('root') as HTMLElement;
  root.innerHTML = '';
  const header = el('header', 'sc-head');
  const intro = el('div');
  intro.append(el('h1', undefined, 'Storewright'), el('p', undefined, t('整个系统都在你的浏览器里运行：左边是门店模拟器和演示控制台，右边是两部员工手机。在控制台创建订单，看它在手机上被拣货、暂存、交付，同时出现在模拟器里。')));
  const actions = el('div', 'sc-actions');
  const switchStore = el('a', undefined, store === 'demo' ? t('换成家居建材店') : t('换成中型超市'));
  switchStore.href = `?store=${store === 'demo' ? 'hardware' : 'demo'}${q.get('sim') ? `&sim=${encodeURIComponent(simBase)}` : ''}`;
  const reset = el('button', undefined, t('重置演示门店'));
  reset.onclick = () => {
    if (!confirm(t('清空这家演示门店的订单和作业记录？AI 模型保留。'))) return;
    reset.disabled = true;
    void resetStore().finally(() => (reset.disabled = false));
  };
  const lang = el('button', undefined, getLang() === 'zh' ? 'EN' : '中文');
  lang.onclick = () => {
    setLang(getLang() === 'zh' ? 'en' : 'zh');
    location.reload();
  };
  actions.append(switchStore, reset, lang);
  header.append(intro, actions);
  const g = guide();

  // 窄屏：一次显示一个画面
  const tabs = el('nav', 'sc-tabs');
  tabs.setAttribute('role', 'tablist');
  const main = el('main', 'sc-main');
  const left = el('div', 'sc-left');
  const sim = el('iframe', 'sc-sim pane');
  sim.title = t('运营模拟器');
  sim.src = simUrl();
  const consoleFrame = el('iframe', 'sc-console pane');
  consoleFrame.title = t('演示控制台');
  consoleFrame.src = appUrl('console');
  left.append(sim, consoleFrame);
  const right = el('div', 'sc-phones');
  const p1 = phone('A01');
  const p2 = phone('A05');
  p1.box.classList.add('pane');
  p2.box.classList.add('pane');
  right.append(p1.box, p2.box);
  main.append(left, right);
  const panes: Array<[HTMLElement, string]> = [
    [consoleFrame, '控制台'],
    [p1.box, '手机 1'],
    [p2.box, '手机 2'],
    [sim, '模拟器'],
  ];
  const buttons = panes.map(([pane, label]) => {
    const b = el('button', undefined, t(label));
    b.setAttribute('role', 'tab');
    b.onclick = () => show(pane);
    tabs.append(b);
    return b;
  });
  const show = (target: HTMLElement) => {
    panes.forEach(([pane], i) => {
      pane.classList.toggle('on', pane === target);
      buttons[i]?.setAttribute('aria-selected', String(pane === target));
    });
  };
  show(consoleFrame);

  const foot = el('footer', 'sc-foot', t('全部为合成数据，保存在本机浏览器里（12 小时没有操作后自动清空）。本项目与任何零售商、企业无隶属关系。'));
  root.append(header, g.box, tabs, main, foot);
  void watch(g.update).catch((err: unknown) => console.warn(err));
}

render();
