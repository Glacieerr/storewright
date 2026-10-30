import { LiveClient } from '@storewright/ops/client';
import type { OpsState } from '@storewright/ops';
import { getLang, setLang, t } from '../i18n';
import { link, servePortRequests } from './transport';
import './showcase.css';

/**
 * 展示页：同一个浏览器里，门店的数字孪生（三维）、演示控制台和两部员工手机，
 * 全部连到浏览器里的同一个门店中枢（SharedWorker），任何一边的操作都会实时出现在其他画面里。
 * 上方的引导按门店的实时状态自动打勾：下单 → 拣货 → 暂存 → 到店 → 交付 → AI → 孪生（决策记录 0016）。
 * 电脑上左栏可以切换：演示控制台、数字孪生（你的操作、自动运营和设备读数都会出现在这里，可以回放和推演）、
 * 全天仿真（规划孪生：模拟器自己按策略跑完一整天，和运营孪生同时运行），高度足够时默认上下并排
 * （全流程走查发现：笔记本屏幕上控制台只剩一百多像素高，几乎无法操作）。
 * 窄屏（手机）上一次只显示一个画面，用标签切换。
 * 地址参数：?store=hardware 换成家居建材店；?sim=模拟器地址（默认 ../sim/）；?layout=console|live|auto|split 指定左栏。
 */

const q = new URLSearchParams(location.search);
// 「你的商店」的实时沙盒：?project=<编号>，门店按访客自己搭的配置在浏览器里的中枢建出来（决策记录 0013）
const projectId = q.get('project') ?? undefined;
let store = q.get('store') === 'hardware' ? 'hardware' : 'demo';
let projectName: string | undefined;
const simBase = q.get('sim') ?? '../sim/';
/** 本项目的公开仓库：展示页右上角的「源代码」链接 */
const SOURCE_URL = 'https://github.com/Glacieerr/storewright';
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

/** 引导只看你自己的订单（自动运营的订单由虚拟员工处理，不算） */
const mine = (s: OpsState) => Object.values(s.orders).filter((o) => o.track !== 'AUTO');
const mineIds = (s: OpsState) => new Set(mine(s).map((o) => o.id));

const STEPS: Step[] = [
  { title: '下单', hint: '在控制台点「创建」，下一张自取订单（默认立即锁单并生成拣货批次）。', done: (s) => mine(s).length > 0 },
  { title: '拣货', hint: '第一部手机（拣货员）：领取批次，点框绑定标签，逐行点「已拣到」，最后「完成拣货，去暂存」。', done: (s) => { const ids = mineIds(s); return Object.values(s.totes).some((x) => ids.has(x.orderId) && (x.status === 'PICKED' || x.status === 'STAGED' || x.status === 'PULLED' || x.status === 'HANDED_OFF')); } },
  { title: '暂存', hint: '把第一部手机切换成「暂存员 Riley」，逐框点选，放进建议的格位。', done: (s) => mine(s).some((o) => o.stagedAt !== undefined) },
  { title: '到店', hint: '在控制台点这张订单的「我在路上」和「到店」——交付看板变色，左栏切到「数字孪生」可以看到顾客的车。', done: (s) => mine(s).some((o) => o.arrivedAt !== undefined) },
  { title: '交付', hint: '第二部手机（交付员）：打开这张订单，开始准备、逐框核对，输入控制台显示的验证码，完成交付。', done: (s) => mine(s).some((o) => o.status === 'COMPLETED') },
  { title: 'AI', hint: '把一部手机切换成「带班负责人 Taylor」，打开 AI 页：每条建议都有理由和置信度，可以采纳或否决。', done: (s) => Object.values(s.recs).some((r) => r.status === 'ACCEPTED' || r.status === 'OVERRIDDEN' || r.status === 'DISMISSED') },
  // 数字孪生（决策记录 0016）：设备故障 → 告警推到带班负责人的手机 → 确认；再在孪生时间轴上回放和推演
  { title: '孪生', hint: '在控制台的「设备与告警」点「暂存冷藏柜故障」：三维孪生里温度升高变红，告警推到带班负责人 Taylor 的手机上，点「确认，我来处理」。再拖动孪生底部的时间轴：往左回放故障之前，往右看未来 3 小时的推演。', done: (s) => Object.values(s.alerts ?? {}).some((a) => a.ackAt !== undefined) },
];

const GUIDE_KEY = 'storewright.showcase.guide';
const LAYOUT_KEY = 'storewright.showcase.layout';
type Layout = 'console' | 'live' | 'auto' | 'split';
const LAYOUTS: Array<[Layout, string]> = [
  ['console', '控制台'],
  ['live', '数字孪生'],
  ['auto', '全天仿真'],
  ['split', '上下并排'],
];

function initialLayout(): Layout {
  const asked = q.get('layout');
  if (asked && LAYOUTS.some(([k]) => k === asked)) return asked as Layout;
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    if (saved && LAYOUTS.some(([k]) => k === saved)) return saved as Layout;
  } catch {
    // 本机存储不可用
  }
  // 屏幕够高才上下并排，否则控制台单独占满左栏
  return window.innerHeight >= 980 ? 'split' : 'console';
}

function appUrl(as: string): string {
  return `./?demo&store=${store}&as=${as}${as === 'console' ? '&embed' : ''}`;
}

function simUrl(): string {
  const bridge = new URL('./bridge.html', location.href).href;
  return `${simBase}${simBase.includes('?') ? '&' : '?'}live=demo&store=${store}&bridge=${encodeURIComponent(bridge)}${projectId ? `&project=${encodeURIComponent(projectId)}` : ''}`;
}

/** 全天仿真（规划孪生）：模拟器自己的离散事件仿真（虚拟顾客、员工、车辆按策略跑完一整天），和运营孪生互不影响 */
function autoSimUrl(): string {
  if (projectId) return `${simBase}${simBase.includes('?') ? '&' : '?'}project=${encodeURIComponent(projectId)}&autoplay=1`;
  const tpl = store === 'hardware' ? 'hardware' : 'medium';
  return `${simBase}${simBase.includes('?') ? '&' : '?'}template=${tpl}&autoplay=1`;
}

/** 从本机浏览器读出「你的商店」的门店项目（模拟器保存的） */
function readProject(id: string): Promise<{ name: string; config: unknown } | undefined> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('storewright-projects', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('projects', { keyPath: 'id' });
      req.onerror = () => resolve(undefined);
      req.onsuccess = () => {
        const get = req.result.transaction('projects', 'readonly').objectStore('projects').get(id);
        get.onsuccess = () => resolve(get.result as { name: string; config: unknown } | undefined);
        get.onerror = () => resolve(undefined);
      };
    } catch {
      resolve(undefined);
    }
  });
}

/** 让浏览器里的门店中枢按项目的配置建店，返回门店编号 */
async function setupProjectStore(id: string): Promise<string> {
  const p = await readProject(id);
  if (!p) throw new Error(t('找不到这家门店（可能是在别的浏览器里搭的）'));
  projectName = p.name;
  const res = await link.fetch('/api/custom-stores', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: p.config }) });
  const body = (await res.json()) as { ok: boolean; storeId?: string; issues?: Array<{ message: string }> };
  if (!body.ok || !body.storeId) throw new Error(t('这家门店还不能开业：{0}', body.issues?.map((i) => i.message).join('；') ?? ''));
  return body.storeId;
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
  // 手机里可以用摄像头扫码（浏览器仍会询问权限）
  frame.allow = 'camera';
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
  intro.append(
    el('h1', undefined, projectName ? `${t('你的商店')} · ${projectName}` : 'Storewright'),
    el('p', undefined, projectName ? t('这是你自己搭的门店的实时沙盒：控制台下单、两部员工手机作业，也可以在控制台打开「自动运营」，两条线同时跑在你的门店上。') : t('门店的数字孪生，整个系统都在你的浏览器里运行。左栏是演示控制台、三维数字孪生和全天仿真，右边是两部员工手机：在控制台创建订单，看它在手机上被拣货、暂存、交付，同时出现在孪生里；孪生还能回放过去、推演未来 3 小时，设备故障会变成告警推到手机上。')),
  );
  const actions = el('div', 'sc-actions');
  const switchStore = el('a', undefined, projectName ? t('返回你的商店') : store === 'demo' ? t('换成家居建材店') : t('换成中型超市'));
  switchStore.href = projectName ? `${simBase}${simBase.includes('?') ? '&' : '?'}yours` : `?store=${store === 'demo' ? 'hardware' : 'demo'}${q.get('sim') ? `&sim=${encodeURIComponent(simBase)}` : ''}`;
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
  const source = el('a', undefined, t('源代码 ↗'));
  source.href = SOURCE_URL;
  source.target = '_blank';
  source.rel = 'noopener';
  source.title = t('在 GitHub 上查看本项目的源代码（新标签页）');
  actions.append(switchStore, reset, source, lang);
  header.append(intro, actions);
  const g = guide();

  // 窄屏：一次显示一个画面
  const tabs = el('nav', 'sc-tabs');
  tabs.setAttribute('role', 'tablist');
  const main = el('main', 'sc-main');
  const left = el('div', 'sc-left');
  const sim = el('iframe', 'sc-sim pane');
  sim.title = t('数字孪生');
  sim.src = simUrl();
  const consoleFrame = el('iframe', 'sc-console pane');
  consoleFrame.title = t('演示控制台');
  consoleFrame.src = appUrl('console');
  const autoSim = el('iframe', 'sc-auto');
  autoSim.title = t('全天仿真');
  // 第一次切到「全天仿真」时才加载，之后一直在后台运行
  const loadAuto = () => {
    if (!autoSim.src) autoSim.src = autoSimUrl();
  };
  const stage = el('div', 'sc-stage');
  stage.append(sim, consoleFrame, autoSim);
  // 左栏切换 + 在新标签页打开当前画面
  const bar = el('div', 'sc-switch');
  bar.setAttribute('role', 'tablist');
  bar.setAttribute('aria-label', t('左栏显示'));
  const openNew = el('a', 'sc-open', t('在新标签页打开 ↗'));
  openNew.target = '_blank';
  openNew.rel = 'noopener';
  const switchButtons = LAYOUTS.map(([key, label]) => {
    const b = el('button', undefined, t(label));
    b.setAttribute('role', 'tab');
    b.dataset.layout = key;
    b.onclick = () => setLayout(key);
    bar.append(b);
    return b;
  });
  bar.append(openNew);
  const setLayout = (layout: Layout) => {
    left.dataset.layout = layout;
    if (layout === 'auto') loadAuto();
    switchButtons.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.layout === layout)));
    const target = layout === 'live' ? simUrl() : layout === 'auto' ? autoSimUrl() : appUrl('console').replace('&embed', '');
    openNew.href = target;
    openNew.hidden = layout === 'split';
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      // 忽略
    }
  };
  left.append(bar, stage);
  setLayout(initialLayout());
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
    [sim, '数字孪生'],
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

// 「你的商店」先建店，再渲染各个画面（iframe 打开时门店已经存在）
if (projectId) {
  setupProjectStore(projectId)
    .then((id) => {
      store = id;
      render();
    })
    .catch((err: unknown) => {
      const root = document.getElementById('root') as HTMLElement;
      root.innerHTML = '';
      const box = el('section', 'sc-guide');
      box.append(el('h1', undefined, t('你的商店')), el('p', 'sc-hint', err instanceof Error ? err.message : String(err)));
      root.append(box);
    });
} else render();
