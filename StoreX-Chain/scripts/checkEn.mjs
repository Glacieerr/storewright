// 英文界面检查：开发服务器开着时（npm run dev）运行  node scripts/checkEn.mjs [地址] [--quick]
//
// 用无界面的浏览器打开英文界面（?lang=en），默认区域的平常和极限负荷、一个随机区域，在一天里几个时刻把面板、页签和抽屉都走一遍：
// 调度台（甘特图、作业清单、问题、常规计划、当天曲线、求解）、设施监控各页签和设施管理台、分层看板、实时跟踪和车辆卡、闭环面板、
// 对比与报告 / 网络规划 / 说明页签、练习抽屉、分享和场景库对话框、区域对话框、欢迎卡和「?」界面导览、集装箱导览的每一张卡、
// 值班助手（此刻要关注、今日计划、交接班报告的每一班、建议复盘、操作记录、审批单、每个快捷问题和回答下面的追问按钮、
// 几句随手打的英文问题）。收集屏幕上看得到的（含 title、placeholder 和画在画布上的字）带汉字的文字，去掉白名单，按位置分组列出来；
// 有剩下的退出码 1。--quick 只跑默认区域的平常负荷。浏览器用本机装的 Chrome（Playwright 的 channel: 'chrome'）。
//
// English UI check: opens the English interface and walks every panel, tab and drawer at several clock times; lists the visible text
// that still contains Chinese characters (minus a short whitelist), grouped by where it was found; exit code 1 if any remain.
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
// --json 文件：把剩下的写成 JSON（全文，方便查字典）
const JSON_OUT = args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined;
const BASE = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--json') ?? 'http://localhost:5182/';
// 欢迎卡要 ?onboard=1 才弹（自动化测试默认不弹），只在第一种情况里看
const CASES = [
  { name: 'default · normal', q: '&onboard=1', load: 'normal', times: ['05:30', '09:30', '14:00', '20:30'], deep: true, once: ['toolbar', 'kpi', 'admin', 'tabs', 'report', 'network', 'about', 'dialogs', 'region', 'teach', 'guide', 'tour'] },
  // 极限负荷用网址参数 load=extreme（第一次仿真就按它跑，省一次重新仿真）
  { name: 'default · extreme', q: '&onboard=0&load=extreme', load: 'normal', times: ['07:00', '11:30', '17:00'], deep: false, once: ['toolbar', 'admin'] },
  { name: 'random-3 · normal', q: '&onboard=0&region=random-3', load: 'normal', times: ['06:30', '12:00', '18:30'], deep: false, once: ['toolbar', 'tabs', 'network', 'region'] },
];
// 随手打的英文问题：要么换成内置助手懂的中文问句，要么用英文说明它懂什么
const TYPED = ['which trucks are late today?', 'where is truck m02', 'how is the airport doing', 'what should I do about the cold-chain doors', 'tell me a joke'];

// 白名单：语言切换的「中文」、值班助手开场白里特意留的中文示例问法（内置助手懂的问法）；标了 lang="zh…" 的元素、用户自己打的字不算
const ALLOW = [/^中文$/, /^Ask me directly, e\.g\. "M02 在哪" \(where is M02\), "为什么推荐第一条" \(why the first recommendation\), "写交接班报告" \(write the handover report\)\.$/];

/** 走过了多少（导览的卡、问过的问题），确认检查真的走到了 */
const walked = [];
const found = new Map();
const notes = [];
let step = '';

/** 页面里：sel 里面看得到的、带汉字的文字（文字节点、title、placeholder）；whole = 整页时再加画布上画的字和网页标题 */
function collect([sel, whole]) {
  const HAN = /\p{Script=Han}/u;
  const out = [];
  const visible = (el) => {
    const box = el.closest('select') ?? el;
    if (box.checkVisibility) return box.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
    return !!(box.offsetWidth || box.offsetHeight || box.getClientRects().length);
  };
  const where = (el) => {
    for (let e = el; e; e = e.parentElement) {
      if (e.classList?.contains('as-msg')) return `#assistant .as-msg.${[...e.classList].filter((c) => c !== 'as-msg').join('.')}`;
      if (e.classList?.contains('ux-welcome') || e.classList?.contains('ux-step')) return `.${e.className.split(' ')[0]}`;
      if (e.classList?.contains('tour-card')) return '.tour-card';
      if (e.id && !['as-msgs'].includes(e.id)) return `#${e.id}`;
    }
    return el.tagName.toLowerCase();
  };
  const skip = (el) => !!el.closest('script,style,noscript,template,[lang^="zh"],.as-msg.me');
  const tidy = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 1200);
  const root = document.querySelector(sel);
  if (!root) return out;
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const s = n.nodeValue;
    if (!s || !HAN.test(s)) continue;
    const el = n.parentElement;
    if (!el || skip(el) || !visible(el)) continue;
    // 报整块的文字（一行、一格、一个按钮），读起来知道是哪一句
    const block = el.closest('li,p,td,th,button,label,h1,h2,h3,h4,h5,option,summary,dt,dd,figcaption,small,b') ?? el;
    if (seen.has(block)) continue;
    seen.add(block);
    out.push({ where: where(el), text: tidy(block.textContent ?? s) });
  }
  for (const el of root.querySelectorAll('[title],[placeholder]')) {
    for (const a of ['title', 'placeholder']) {
      const v = el.getAttribute(a);
      if (v && HAN.test(v) && !skip(el) && visible(el)) out.push({ where: where(el), text: `[${a}] ${tidy(v)}` });
    }
  }
  if (whole) {
    for (const s of window.__hanDrawn ?? []) out.push({ where: 'canvas (3D labels, charts)', text: tidy(s) });
    if (HAN.test(document.title)) out.push({ where: 'document.title', text: document.title });
  }
  return out;
}

async function grab(page, label, sel = 'body') {
  step = label;
  let items = [];
  try {
    items = await page.evaluate(collect, [sel, sel === 'body']);
  } catch (e) {
    notes.push(`${label}: collect failed (${String(e).slice(0, 120)})`);
  }
  for (const it of items) {
    if (ALLOW.some((re) => re.test(it.text))) continue;
    const key = `${it.where}\u0001${it.text}`;
    const f = found.get(key) ?? { ...it, steps: new Set() };
    f.steps.add(label);
    found.set(key, f);
  }
}

const wait = (page, ms) => page.waitForTimeout(ms);
async function ready(page) {
  await page.waitForFunction(() => document.getElementById('busy')?.hidden === true, null, { timeout: 300000 });
  await page.waitForFunction(() => !window.__twin?.view?.plansPending, null, { timeout: 300000 });
}
/** 在页面里点 sel 选中的第 i 个元素（DOM click，不等动画）；没有就返回 false */
const click = (page, sel, i = 0) =>
  page.evaluate(
    ([s, k]) => {
      const el = document.querySelectorAll(s)[k];
      if (!el) return false;
      el.click();
      return true;
    },
    [sel, i],
  );
const count = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
/** 点 sel 的每一个，每点一个收集一次 */
async function eachClick(page, sel, label, ms = 250, scope = 'body') {
  const n = await count(page, sel);
  for (let i = 0; i < n; i++) {
    if (!(await click(page, sel, i))) continue;
    await wait(page, ms);
    await grab(page, `${label} ${i + 1}/${n}`, scope);
  }
  return n;
}
/** 各段用了多久（调快用） */
const phases = new Map();
async function timed(name, fn) {
  const t = Date.now();
  await fn();
  phases.set(name, (phases.get(name) ?? 0) + (Date.now() - t) / 1000);
}
async function tryStep(name, fn) {
  try {
    await fn();
  } catch (e) {
    notes.push(`${step || name}: ${String(e).split('\n')[0].slice(0, 160)}`);
  }
}
const secOf = (hm) => {
  const [h, m] = hm.split(':').map(Number);
  return h * 3600 + m * 60;
};
async function setTime(page, hm) {
  await page.evaluate((sec) => {
    const b = document.getElementById('play');
    if (b && b.textContent !== '▶') b.click();
    const ti = document.getElementById('time');
    ti.value = String(sec);
    ti.dispatchEvent(new Event('input'));
  }, secOf(hm));
  await wait(page, 700);
}

/** 值班助手：等最新的一条回答出来（带「结论」的那一块） */
async function lastAnswer(page, before) {
  await page.waitForFunction((n) => {
    const bots = document.querySelectorAll('#as-msgs .as-msg.bot');
    return bots.length > n && bots[bots.length - 1].querySelector('.as-concl, p');
  }, before, { timeout: 60000 });
  await wait(page, 120);
}
const botCount = (page) => count(page, '#as-msgs .as-msg.bot');
async function ask(page, sel, i, label) {
  const n = await botCount(page);
  if (!(await click(page, sel, i))) return false;
  await lastAnswer(page, n);
  await grab(page, label);
  return true;
}

/** 某个时刻：整页、调度台各页签、设施监控各页签、跟踪面板、闭环面板、值班助手的抽屉 */
async function walkTime(page, c, hm) {
  const at = `${c.name} @${hm}`;
  const first = hm === c.times[0];
  const early = c.times.indexOf(hm) < 2;
  await setTime(page, hm);
  await timed('page', () => grab(page, `${at} page`));
  await timed('dispatch', () =>
    tryStep('dispatch', async () => {
      if (first) await eachClick(page, '#dispatch [data-dp]', `${at} dispatch tab`, 300, '#dispatch');
      await click(page, '#dispatch [data-dp="gantt"]');
      await wait(page, 200);
      await page.evaluate(() => document.querySelectorAll('#dispatch .gt-toggle[aria-expanded="false"]').forEach((b) => b.click()));
      await wait(page, 300);
      await grab(page, `${at} dispatch gantt expanded`, '#dispatch');
      await click(page, '#dispatch [data-dp="list"]');
      await wait(page, 200);
      if (await click(page, '#dispatch [data-op]')) {
        await wait(page, 250);
        await grab(page, `${at} op card`, '#opcard');
      }
      await click(page, '#dispatch [data-dp="issues"]');
      await wait(page, 200);
      await grab(page, `${at} dispatch issues`, '#dispatch');
    }),
  );
  if (c.deep || early) await timed('facility', () => tryStep('facility', () => eachClick(page, '#facility [data-tab]', `${at} facility tab`, 300, '#facility')));
  await timed('track', () =>
    tryStep('track', async () => {
      await eachClick(page, '#track [data-g]', `${at} track group`, 150, '#track');
      if (await click(page, '#track [data-i]')) {
        await wait(page, 250);
        await grab(page, `${at} vehicle card`, '#vcard');
      }
    }),
  );
  await timed('loop', () =>
    tryStep('loop', async () => {
      if (early) await eachClick(page, '#loop [data-v]', `${at} loop view`, 400, 'body');
      await click(page, '#loop [data-v="plan"]');
      await wait(page, 200);
    }),
  );
  await timed('drawers', () =>
    tryStep('assistant drawers', async () => {
      for (const d of ['dailyplan', 'review', 'audit', 'approvals']) {
        await click(page, `#assistant [data-drawer="${d}"]`);
        await wait(page, 200);
        await grab(page, `${at} assistant ${d}`, '#assistant');
      }
      await click(page, '#assistant [data-drawer="handover"]');
      await wait(page, 200);
      if (first) await eachClick(page, '#as-drawer [data-shift]', `${at} handover shift`, 200, '#assistant');
      else await grab(page, `${at} handover`, '#assistant');
      await click(page, '#as-drawer [data-close]');
    }),
  );
}

/** 值班助手：快捷问题和追问（deep 时）、此刻要关注里的「处理」、随手打的英文问题、换角色 */
async function walkAssistant(page, c) {
  const at = `${c.name} assistant`;
  const asked = new Set();
  const quick = await count(page, '#assistant .as-chips [data-ask]');
  for (let i = 0; i < quick; i++) {
    const q = await page.evaluate((k) => document.querySelectorAll('#assistant .as-chips [data-ask]')[k]?.dataset.ask, i);
    asked.add(q);
    await tryStep('quick', () => ask(page, '#assistant .as-chips [data-ask]', i, `${at} quick ${i + 1}`));
    if (!c.deep) continue;
    // 这条回答下面的追问按钮（每个问句只问一次）
    const follow = await page.evaluate(() => {
      const bots = document.querySelectorAll('#as-msgs .as-msg.bot');
      return [...(bots[bots.length - 1]?.querySelectorAll('[data-ask]') ?? [])].map((b) => b.dataset.ask);
    });
    for (const f of follow) {
      if (asked.has(f)) continue;
      asked.add(f);
      await tryStep('followup', async () => {
        const n = await botCount(page);
        await page.evaluate((a) => [...document.querySelectorAll('#as-msgs [data-ask]')].reverse().find((x) => x.dataset.ask === a)?.click(), f);
        await lastAnswer(page, n);
        await grab(page, `${at} follow-up "${f}"`, '#as-msgs');
      });
    }
  }
  walked.push(`${at}: ${asked.size} questions and follow-ups`);
  await tryStep('typed', async () => {
    for (const text of c.deep ? TYPED : TYPED.slice(0, 2)) {
      const n = await botCount(page);
      await page.fill('#as-q', text);
      await page.press('#as-q', 'Enter');
      await lastAnswer(page, n);
      await grab(page, `${at} typed "${text}"`, '#as-msgs');
    }
  });
  await tryStep('watch actions', async () => {
    if (await click(page, '#as-watch [data-show]')) {
      await wait(page, 200);
      await grab(page, `${at} watch proposal`, '#assistant');
    }
    if (!c.deep) return;
    for (const role of ['manager', 'viewer', 'dispatcher']) {
      await page.selectOption('#as-role', role);
      await wait(page, 150);
      await grab(page, `${at} role ${role}`, '#assistant');
    }
    if (await click(page, '#as-msgs [data-exec]')) {
      await wait(page, 1200);
      await grab(page, `${at} executed proposal`, '#assistant');
    }
    for (const d of ['audit', 'approvals', 'review']) {
      await click(page, `#assistant [data-drawer="${d}"]`);
      await wait(page, 200);
      await grab(page, `${at} after execute ${d}`, '#assistant');
    }
    if (await click(page, '#as-drawer [data-cf]')) {
      await page.waitForFunction(() => !document.querySelector('#as-drawer [data-cf][disabled]'), null, { timeout: 60000 });
      await wait(page, 200);
      await grab(page, `${at} counterfactual`, '#assistant');
    }
    await click(page, '#as-drawer [data-close]');
  });
}

/** 别的页签、对话框、抽屉、导览：what = 这种情况要看哪些 */
async function walkOnce(page, c, what) {
  const at = c.name;
  if (what.has('toolbar'))
    await timed('toolbar', () =>
      tryStep('toolbar', async () => {
        for (const id of ['planmap', 'monitors', 'split']) {
          await click(page, `#${id}`);
          await wait(page, 900);
          await grab(page, `${at} toolbar ${id}`, '.world-wrap');
          await click(page, `#${id}`);
          await wait(page, 200);
        }
        if (await click(page, '#track [data-i]')) {
          await wait(page, 200);
          if (await click(page, '#vcard [data-act="follow"]')) {
            await wait(page, 500);
            await grab(page, `${at} follow`, '#follow');
            await click(page, '#follow-stop');
          }
        }
      }),
    );
  if (what.has('kpi'))
    await timed('kpi', () =>
      tryStep('kpi', async () => {
        if (await click(page, '#kb-edit-btn')) {
          await wait(page, 200);
          await grab(page, `${at} kpi thresholds`, '#kpiboard');
          await click(page, '#kb-edit-btn');
        }
      }),
    );
  if (what.has('admin'))
    await timed('admin', () =>
      tryStep('facility admin', async () => {
        await click(page, '#facility [data-tab="port"]');
        await wait(page, 200);
        if (await click(page, '#facility [data-manage]')) {
          await page.waitForFunction(() => !document.getElementById('admin')?.hidden, null, { timeout: 30000 });
          await wait(page, 400);
          await eachClick(page, '#admin [data-ftab]', `${at} admin tab`, 400, '#admin');
          await page.evaluate(() => {
            const a = document.getElementById('admin');
            a?.querySelector('[data-act="close"]')?.click();
            if (a) a.hidden = true;
          });
        }
      }),
    );
  if (what.has('tabs'))
    await timed('tabs', () =>
      tryStep('tabs', async () => {
        for (const tab of ['report', 'network', 'about']) {
          if (!what.has(tab)) continue;
          await click(page, `.tabs button[data-tab="${tab}"]`);
          await wait(page, 1500);
          await grab(page, `${at} tab ${tab}`, `#tab-${tab}`);
          if (tab === 'network') {
            await eachClick(page, '#tab-network [data-page]', `${at} network page`, 1200, '#tab-network');
            await eachClick(page, '#tab-network [data-g]', `${at} network gen`, 1000, '#tab-network');
          }
        }
        await click(page, '.tabs button[data-tab="twin"]');
        await wait(page, 500);
      }),
    );
  if (what.has('dialogs'))
    await timed('dialogs', () =>
      tryStep('dialogs', async () => {
        for (const id of ['share-btn', 'library-btn']) {
          await click(page, `#${id}`);
          await wait(page, 500);
          await grab(page, `${at} dialog ${id}`);
          await page.keyboard.press('Escape');
          await wait(page, 200);
        }
      }),
    );
  if (what.has('region'))
    await timed('region', () =>
      tryStep('region', async () => {
        await click(page, '#region-edit');
        await wait(page, 400);
        await grab(page, `${at} region dialog`, '#region-dlg');
        await click(page, '#region-dlg [data-act="close"]');
      }),
    );
  if (what.has('teach'))
    await timed('teach', () =>
      tryStep('teach', async () => {
        await click(page, '#teach-btn');
        await wait(page, 500);
        await grab(page, `${at} teach list`, '#teach');
        if (await click(page, '#teach [data-ex]')) {
          await wait(page, 500);
          await grab(page, `${at} teach exercise`, '#teach');
          await click(page, '#teach .tp-back');
        }
        await click(page, '#teach-close');
      }),
    );
  if (what.has('guide'))
    await timed('guide', () =>
      tryStep('guide', async () => {
        await click(page, '#help-btn');
        for (let i = 0; i < 12; i++) {
          await wait(page, 250);
          if (!(await count(page, '.ux-step'))) break;
          await grab(page, `${at} UI guide step ${i + 1}`, '.ux-step');
          await click(page, '.ux-step [data-act="next"]');
        }
      }),
    );
  if (what.has('tour'))
    await timed('tour', () =>
      tryStep('container tour', async () => {
        await click(page, '#tour-btn');
        await page.waitForSelector('.tour-card', { timeout: 60000 });
        await click(page, '.tour-card [data-act="pause"]');
        let cards = 0;
        for (let i = 0; i < 20; i++) {
          await wait(page, 300);
          await grab(page, `${at} tour card ${i + 1}`, '.tour-card');
          cards++;
          if (!(await click(page, '.tour-card [data-act="next"]'))) break;
        }
        walked.push(`${at}: ${cards} tour cards`);
        await grab(page, `${at} tour end`, '.world-wrap');
        await click(page, '.tour-card [data-act="exit"]');
        await page.keyboard.press('Escape');
        await wait(page, 300);
      }),
    );
}

const t0 = Date.now();
const browser = await chromium.launch({ channel: 'chrome' });
for (const c of QUICK ? CASES.slice(0, 1) : CASES) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  // 画在画布上的字（三维的地名、车牌、图表）：记下带汉字的
  await ctx.addInitScript(() => {
    const HAN = /\p{Script=Han}/u;
    const seen = new Set();
    window.__hanDrawn = seen;
    for (const C of [window.CanvasRenderingContext2D, window.OffscreenCanvasRenderingContext2D]) {
      if (!C) continue;
      for (const fn of ['fillText', 'strokeText']) {
        const orig = C.prototype[fn];
        C.prototype[fn] = function (text, ...rest) {
          if (HAN.test(String(text))) seen.add(String(text));
          return orig.call(this, text, ...rest);
        };
      }
    }
  });
  const page = await ctx.newPage();
  // 挡住开发服务器的热更新：检查中途有文件改动时页面不会整页刷新
  await page.routeWebSocket(/localhost:5182/, () => {});
  page.on('pageerror', (e) => notes.push(`${c.name}: page error ${String(e).slice(0, 200)}`));
  page.on('dialog', (d) => {
    if (/\p{Script=Han}/u.test(d.message())) found.set(`dialog\u0001${d.message()}`, { where: 'dialog', text: d.message(), steps: new Set([step]) });
    void d.dismiss();
  });
  const t1 = Date.now();
  await timed('load', async () => {
    await page.goto(`${BASE}?lang=en${c.q}`);
    await tryStep('welcome', async () => {
      if (c.q.includes('onboard=1')) {
        await page.waitForSelector('.ux-welcome', { timeout: 60000 });
        await grab(page, `${c.name} welcome card`, '.ux-welcome');
      }
    });
    await ready(page);
    await wait(page, 1000);
    if (c.load !== 'normal') {
      await page.selectOption('#load', c.load);
      await wait(page, 1500);
      await ready(page);
      await wait(page, 1000);
    }
  });
  if (c.q.includes('onboard=1')) await page.evaluate(() => document.querySelector('.ux-welcome [data-act="close"]')?.click());
  for (const hm of c.times) await walkTime(page, c, hm);
  await setTime(page, c.times[1]);
  await timed('assistant', () => walkAssistant(page, c));
  await walkOnce(page, c, new Set(c.once));
  await grab(page, `${c.name} final page`);
  console.log(`${c.name}: ${((Date.now() - t1) / 1000).toFixed(0)} s`);
  await ctx.close();
}
await browser.close();

// —— 报告：按位置分组 ——
const groups = new Map();
for (const f of found.values()) {
  const g = groups.get(f.where) ?? [];
  g.push(f);
  groups.set(f.where, g);
}
const total = found.size;
for (const [where, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n${where} (${list.length})`);
  for (const f of list.sort((a, b) => a.text.localeCompare(b.text))) console.log(`  - ${f.text}   [${[...f.steps][0]}${f.steps.size > 1 ? ` +${f.steps.size - 1}` : ''}]`);
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify([...found.values()].map((f) => ({ where: f.where, text: f.text, step: [...f.steps][0] })), null, 1));
if (notes.length) console.log(`\nnotes (${notes.length}):\n${notes.map((n) => `  ${n}`).join('\n')}`);
if (walked.length) console.log(`\nwalked: ${walked.join('; ')}`);
console.log(`\ntime per part: ${[...phases].map(([k, v]) => `${k} ${v.toFixed(0)} s`).join(', ')}`);
console.log(`[checkEn] ${total} visible strings with Chinese characters in ${groups.size} places, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(total ? 1 : 0);
