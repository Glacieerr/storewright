import './ux.css';
import { t as tr } from './i18n';

/**
 * 第一次接触：欢迎卡（三条路：看集装箱导览、做一道练习、自己看看）和界面导览（7 步高亮讲解 + 最后一页键盘操作，可跳过，记住看过，顶栏「?」随时再看）。
 * 网址带场景参数、?onboard=0、或自动化测试（navigator.webdriver）时不自动弹出；?onboard=1 强制弹出（截图、检查用）。
 * Welcome card and a 7-step guided tour of the UI. Not shown automatically for scenario links, ?onboard=0 or automation.
 */
const WELCOME_KEY = 'storex-chain-welcome';
const GUIDE_KEY = 'storex-chain-guide';

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* 存不了（隐私模式）就只在这次有效 */
  }
};

interface Step {
  /** 要高亮的元素（找不到就跳过这一步） */
  sel: string;
  title: string;
  text: string;
  /** 元素很高时只高亮上面这么多像素 */
  maxH?: number;
  /** 快捷键列表：[按键, 说明] */
  keys?: [string, string][];
}

/** 键盘操作（界面导览的最后一页） */
const KEYS = (): [string, string][] => [
  ['Tab', tr('在按钮、输入框之间移动（Shift+Tab 往回）；有焦点的地方有明显的框')],
  ['Enter', tr('按下有焦点的按钮（空格也可以）')],
  ['Esc', tr('关掉打开的对话框、抽屉、导览和这个讲解，焦点回到原来的按钮')],
  ['/', tr('把光标放到值班助手的提问框')],
  ['← →', tr('演示导览和这个讲解里翻页；图表里换数据点；时间轴滑块上拖动时刻')],
  [tr('空格'), tr('演示导览里暂停 / 继续')],
  [tr('减少动态'), tr('系统设置里打开「减少动态」：镜头直接切过去不飞，演示导览不自动翻页，界面动画关掉')],
];

const steps = (): Step[] => [
  { sel: '.controls', title: tr('1 / 选方案、区域、负荷和演练'), text: tr('上一代 / StoreX / 全链路三种方案；区域可以随机生成或自定义；负荷做压力测试；演练放进港口拥堵、机场关闭这些扰动。改完点「运行」，后台几秒钟仿真 18 周。') },
  { sel: '.world-wrap', title: tr('2 / 区域三维孪生'), text: tr('港口、机场、物流园、门店和路上的每一辆车、船、飞机都按仿真在走。拖动旋转、滚轮缩放；点一辆车看它的整趟路线；下面一排是镜头预设和图层（地名、规划图、车辆标签、监控画面、对比回放、天气、画质）。'), maxH: 560 },
  { sel: '.player', title: tr('3 / 时间轴'), text: tr('播放、暂停、拖到任一时刻；速度从 10 秒 / 秒到 30 分钟 / 秒。整个页面（三维、调度台、看板、助手）都跟着这个时钟走。') },
  { sel: '#assistant', title: tr('4 / 值班助手'), text: tr('用自然语言问：「现在哪些车晚了」「港口那边怎么样」「要是高速封两个钟头会怎样」。每个回答都标出数据来源；要改计划的建议只会提交给你确认，不会自己执行。'), maxH: 420 },
  { sel: '#kpiboard', title: tr('5 / 分层看板'), text: tr('集团、区域、设施、作业四层指标；超过阈值就告警，没人确认会往上报。'), maxH: 420 },
  { sel: '#dispatch', title: tr('6 / 调度台'), text: tr('当天的全部作业：船、火车、飞机、拖车、配送车和月台门。可以改出发时刻、换门、换车，或者让求解器排一遍，再看迟到和成本怎么变。'), maxH: 420 },
  { sel: '.top', title: tr('7 / 更多入口'), text: tr('「分享」复制此刻的链接或导出场景文件；「场景库」一键切到精选场景；「练习」是教学沙盘的 10 道题；「?」随时再看这个导览。上面的页签是对比报告、网络规划和说明，右边切换中文 / English。') },
  { sel: '.top', title: tr('8 / 键盘操作'), text: tr('不用鼠标也能操作：'), keys: KEYS() },
];

export interface Onboarding {
  startGuide(): void;
  showWelcome(): void;
}

export function mountOnboarding(opts: { auto: boolean }): Onboarding {
  let spot: HTMLElement | undefined;
  let card: HTMLElement | undefined;
  let idx = 0;
  let list: Step[] = [];
  let lastFocus: HTMLElement | null = null;
  let welcome: HTMLElement | undefined;

  const place = () => {
    const st = list[idx];
    const el = st ? document.querySelector<HTMLElement>(st.sel) : null;
    if (!spot || !card || !st || !el) return;
    const r = el.getBoundingClientRect();
    const pad = 6;
    const h = Math.min(r.height, st.maxH ?? r.height);
    const top = Math.max(4, r.top - pad);
    const left = Math.max(4, r.left - pad);
    const width = Math.min(innerWidth - left - 4, r.width + pad * 2);
    const height = Math.min(innerHeight - top - 4, h + pad * 2);
    Object.assign(spot.style, { top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${height}px` });
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const gap = 12;
    let y: number;
    if (top + height + gap + ch < innerHeight) y = top + height + gap;
    else if (top - gap - ch > 0) y = top - gap - ch;
    else y = Math.max(12, innerHeight - ch - 16);
    const x = Math.max(12, Math.min(innerWidth - cw - 12, left + Math.min(24, width / 4)));
    Object.assign(card.style, { top: `${Math.round(y)}px`, left: `${Math.round(x)}px` });
  };

  const end = (done: boolean) => {
    spot?.remove();
    card?.remove();
    spot = card = undefined;
    removeEventListener('resize', place);
    removeEventListener('scroll', place, true);
    document.removeEventListener('keydown', onKey, true);
    if (done) write(GUIDE_KEY, 'done');
    lastFocus?.focus();
  };

  const show = (i: number) => {
    idx = i;
    const st = list[idx];
    const el = st ? document.querySelector<HTMLElement>(st.sel) : null;
    if (!st || !el || !card) return;
    el.scrollIntoView({ block: (el.getBoundingClientRect().height > innerHeight * 0.7 ? 'start' : 'center') as ScrollLogicalPosition, behavior: 'instant' as ScrollBehavior });
    const last = idx === list.length - 1;
    card.innerHTML = `<h4 id="ux-step-title">${st.title}</h4><p>${st.text}</p>${st.keys ? `<ul class="ux-keys">${st.keys.map(([k, d]) => `<li><kbd>${k}</kbd>${d}</li>`).join('')}</ul>` : ''}
      <div class="ux-step-foot"><span class="ux-dots" aria-hidden="true">${list.map((_, k) => `<i class="${k === idx ? 'on' : ''}"></i>`).join('')}</span>
      <span class="ux-row"><button type="button" class="ux-linkish" data-act="skip">${tr('跳过')}</button>${idx > 0 ? `<button type="button" class="ux-btn" data-act="prev">${tr('上一步')}</button>` : ''}<button type="button" class="ux-btn primary" data-act="next">${last ? tr('完成') : tr('下一步')}</button></span></div>`;
    card.querySelector<HTMLButtonElement>('[data-act="skip"]')?.addEventListener('click', () => end(true));
    card.querySelector<HTMLButtonElement>('[data-act="prev"]')?.addEventListener('click', () => show(idx - 1));
    card.querySelector<HTMLButtonElement>('[data-act="next"]')?.addEventListener('click', () => (last ? end(true) : show(idx + 1)));
    requestAnimationFrame(place);
    card.querySelector<HTMLButtonElement>('[data-act="next"]')?.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    if (!card) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      end(true);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (idx < list.length - 1) show(idx + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (idx > 0) show(idx - 1);
    }
  };

  const startGuide = () => {
    closeWelcome();
    if (card) return;
    list = steps().filter((s) => document.querySelector(s.sel));
    if (!list.length) return;
    lastFocus = document.activeElement as HTMLElement | null;
    spot = document.createElement('div');
    spot.className = 'ux-spot';
    card = document.createElement('div');
    card.className = 'ux-step';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-labelledby', 'ux-step-title');
    document.body.append(spot, card);
    addEventListener('resize', place);
    addEventListener('scroll', place, true);
    document.addEventListener('keydown', onKey, true);
    show(0);
  };

  const closeWelcome = () => {
    // 焦点在欢迎卡里时（Esc、关闭）放到顶栏的「?」上，不丢到页面开头
    const inside = !!welcome?.contains(document.activeElement);
    welcome?.remove();
    welcome = undefined;
    if (inside) document.getElementById('help-btn')?.focus({ preventScroll: true });
  };

  const showWelcome = () => {
    if (welcome) return;
    const host = document.querySelector<HTMLElement>('.world-wrap');
    if (!host) return;
    welcome = document.createElement('div');
    welcome.className = 'ux-welcome';
    welcome.innerHTML = `<div class="ux-welcome-card" role="dialog" aria-labelledby="ux-welcome-title">
      <h2 id="ux-welcome-title">${tr('欢迎来到 StoreX 全链路')}</h2>
      <p>${tr('一家综合店整条供应链的数字孪生：远洋班轮、货机、洲际班列和长途货车，经过港口、机场货站、物流园和配送中心，一直到门店的货架。全部在浏览器里运行，数据都是合成的。')}</p>
      <div class="ux-bigs">
        <button type="button" class="ux-big primary" data-act="tour"><span class="ico" aria-hidden="true">▶</span><span><b>${tr('看一个集装箱从船到货架')}</b><small>${tr('一分钟的自动导览，镜头跟着货走')}</small></span></button>
        <button type="button" class="ux-big" data-act="teach"><span class="ico" aria-hidden="true">✎</span><span><b>${tr('做一道练习')}</b><small>${tr('教学沙盘：改门、调车、做演练，自动批改')}</small></span></button>
        <button type="button" class="ux-big" data-act="explore"><span class="ico" aria-hidden="true">◎</span><span><b>${tr('自己看看')}</b><small>${tr('先花 30 秒认识一下界面')}</small></span></button>
      </div>
      <div class="ux-welcome-foot"><label><input type="checkbox" data-act="off" /> ${tr('不再显示')}</label><button type="button" class="ux-linkish" data-act="close">${tr('关闭')}</button></div>
    </div>`;
    host.append(welcome);
    const off = welcome.querySelector<HTMLInputElement>('[data-act="off"]');
    const leave = () => {
      if (off?.checked) write(WELCOME_KEY, 'off');
      closeWelcome();
    };
    welcome.querySelector('[data-act="tour"]')?.addEventListener('click', () => {
      leave();
      document.dispatchEvent(new CustomEvent('storex:start-tour', { detail: { tour: 'container' } }));
    });
    welcome.querySelector('[data-act="teach"]')?.addEventListener('click', () => {
      leave();
      document.dispatchEvent(new CustomEvent('storex:open-teach', { detail: {} }));
    });
    welcome.querySelector('[data-act="explore"]')?.addEventListener('click', () => {
      leave();
      startGuide();
    });
    welcome.querySelector('[data-act="close"]')?.addEventListener('click', leave);
    welcome.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') leave();
    });
    welcome.querySelector<HTMLButtonElement>('[data-act="tour"]')?.focus({ preventScroll: true });
  };

  document.getElementById('help-btn')?.addEventListener('click', startGuide);

  if (opts.auto) {
    if (read(WELCOME_KEY) !== 'off') showWelcome();
    else if (read(GUIDE_KEY) !== 'done') {
      // 欢迎卡关掉了、导览还没看过：等第一次仿真跑完（面板都有内容了）再自动开始
      document.addEventListener('storex:ready', () => startGuide(), { once: true });
    }
  }
  return { startGuide, showWelcome };
}

/** 要不要自动弹出欢迎卡和导览：带场景参数、?onboard=0、自动化测试时不弹；?onboard=1 强制弹 */
export function onboardAuto(hasScenario: boolean): boolean {
  const q = new URLSearchParams(location.search).get('onboard');
  if (q === '1') return true;
  if (q === '0' || hasScenario) return false;
  return !(navigator as Navigator & { webdriver?: boolean }).webdriver;
}
