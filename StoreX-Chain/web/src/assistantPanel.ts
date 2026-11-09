import './assistant.css';
// 值班助手的引擎（意图分类器和约 3,400 句训练语料）第一次提问前才加载；面板上的风险清单、计划、交接班这些不用它
import type { Assistant } from '../../src/assistant';
import { watchList } from '../../src/assistant/brief';
import { dailyPlan } from '../../src/assistant/dailyPlan';
import { handover, reportShift, SHIFTS } from '../../src/assistant/handover';
import { INTENT_LABEL } from '../../src/assistant/intentLabel';
import { policySummary } from '../../src/assistant/policy';
import { review } from '../../src/assistant/review';
import type { Shift } from '../../src/assistant/handover';
import { ACT_LABEL, Approvals, approverOf, canApprove, canExecute, ROLE_LABEL, ROLES, type Role } from '../../src/assistant/roles';
import type { Answer, AssistCtx, Link, Proposal } from '../../src/assistant/types';
import { clock } from '../../src/twin/twin';
import { answerView, fromEnglish, linkLabel, proposalView, ROUTE_EXAMPLES, routeEnglish, txLine, txMarkdown } from './assistantText';
import { isEn, t, t as tr, tx } from './i18n';

/**
 * 值班助手面板：左边对话（问问题、看回答里的依据、确认提议），右边「此刻要关注」（跟着时间自动更新）。
 *
 * - 提议一律先给人看推演结果，点「确认执行」才执行；按角色走审批（调度员能直接执行低风险和便宜的，更贵的交站长）；
 * - 交接班报告、建议复盘、操作记录、审批单在面板上方的按钮里；
 * - 按 / 键随时把光标放到提问框。
 */
export interface AssistantHost {
  /** 此刻的数据（还没有就是 undefined） */
  ctx(): AssistCtx | undefined;
  /** 执行提议里的动作；做不了（比如建议卡已经处理过了）返回原因 */
  execute(p: Proposal): string | undefined;
  link(l: Link): void;
  /** 复盘：把某张卡当时的决定反过来（执行的改成不执行，没执行的改成执行推荐的），整天再推演一遍，返回比较的结果 */
  counterfactual?(key: string): Promise<string>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
/** 回答的排版：一行一段，「- 」开头的连成列表，**粗体** */
function md(text: string): string {
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => {
    // 「1. 」「2. 」开头的列成有序列表（编号接着上一段，比如「最近处理过的」从 3 开始）
    const num = list.length && list.every((x) => /^\d+\. /.test(x));
    if (num) out.push(`<ol start="${parseInt(list[0] as string, 10)}">${list.map((x) => `<li>${x.replace(/^\d+\. /, '')}</li>`).join('')}</ol>`);
    else if (list.length) out.push(`<ul>${list.map((x) => `<li>${x}</li>`).join('')}</ul>`);
    list = [];
  };
  for (const raw of text.split('\n')) {
    const line = esc(raw).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith('- ')) list.push(line.slice(2));
    else {
      flush();
      out.push(`<p>${line}</p>`);
    }
  }
  flush();
  return out.join('');
}

/** 英文界面不给内置助手的设计文档（同一个数组，资料库的索引不用每次重建） */
const NO_DOCS: NonNullable<AssistCtx['docs']> = [];
const QUICK = ['现在有什么风险', '有什么待处理的建议', '哪些车会晚', '门店今天为什么晚', '有没有异常的指标', '本店的货在哪', '今日计划', '冷链门不够用怎么办'];
const ROLE_KEY = 'storex-chain-role';
type Drawer = 'handover' | 'dailyplan' | 'review' | 'audit' | 'approvals';
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** 引擎：内置（网页里的规则 + 逻辑回归，默认）或本机孪生服务（服务那边可以接大模型，见 docs/06-llm-option.md） */
type Engine = 'builtin' | 'server';
const ENGINE_KEY = 'storex-chain-assistant-engine';
/** 本机孪生服务的地址（本机存储里的 storex-chain-twin-server 可以改） */
const twinServer = (): string => {
  try {
    return localStorage.getItem('storex-chain-twin-server') || 'http://127.0.0.1:8787';
  } catch {
    return 'http://127.0.0.1:8787';
  }
};

export class AssistantPanel {
  readonly approvals = new Approvals();
  private bot: Assistant | undefined;
  private botP: Promise<Assistant> | undefined;
  /** 加载值班助手的引擎（只加载一次）：面板第一次出现在屏幕上、输入框拿到焦点或第一次提问时 */
  private loadBot(): Promise<Assistant> {
    this.botP ??= import('../../src/assistant')
      .then((m) => (this.bot = new m.Assistant()))
      .catch((err: unknown) => {
        this.botP = undefined;
        throw err;
      });
    return this.botP;
  }
  private role: Role = 'dispatcher';
  private engine: Engine = 'builtin';
  private readonly props = new Map<string, { p: Proposal; state: 'open' | 'done' | 'requested' | 'dismissed'; via: string; note?: string }>();
  private seen = new Set<string>();
  private lastT = -1;
  private lastReal = 0;
  private drawer: Drawer | undefined;
  private shift: Shift['key'] | undefined;
  private greeted: string | undefined;
  private readonly els: { msgs: HTMLElement; q: HTMLInputElement; watch: HTMLElement; watchSub: HTMLElement; drawer: HTMLElement; role: HTMLSelectElement; engine: HTMLSelectElement; auditBadge: HTMLElement; apprBadge: HTMLElement };

  constructor(
    root: HTMLElement,
    private readonly host: AssistantHost,
  ) {
    try {
      const r = localStorage.getItem(ROLE_KEY) as Role | null;
      if (r && ROLES.includes(r)) this.role = r;
      if (localStorage.getItem(ENGINE_KEY) === 'server') this.engine = 'server';
    } catch {
      /* 隐私模式读不了也没关系 */
    }
    root.innerHTML = `
      <header class="as-head">
        <div class="as-title"><h2>${tr('值班助手')}</h2><span class="as-sub">${tr('问问题、看风险、一键处理：要改的先给你看推演结果，确认后才执行，按角色审批，全部记进操作记录')}</span></div>
        <div class="as-tools">
          <label>${tr('角色')} <select id="as-role">${ROLES.map((r) => `<option value="${r}">${tx(ROLE_LABEL[r])}</option>`).join('')}</select></label>
          <label>${esc(t('引擎'))} <select id="as-engine" title="${esc(t('本机孪生服务要先启动，并允许这个页面的来源（--allow-origin），见 docs/06-llm-option.md'))}"><option value="builtin">${esc(t('内置'))}</option><option value="server">${esc(t('本机孪生服务（可接大模型）'))}</option></select></label>
          <button class="ghost" data-drawer="approvals">${tr('审批单')}<span class="as-badge" id="as-appr"></span></button>
          <button class="ghost" data-drawer="dailyplan">${tr('今日计划')}</button>
          <button class="ghost" data-drawer="handover">${tr('交接班报告')}</button>
          <button class="ghost" data-drawer="review">${tr('建议复盘')}</button>
          <button class="ghost" data-drawer="audit">${tr('操作记录')}<span class="as-badge" id="as-audit" style="background: var(--muted)"></span></button>
        </div>
      </header>
      <div class="as-grid">
        <div class="as-chat">
          <ol class="as-msgs" id="as-msgs" aria-live="polite"></ol>
          <form class="as-ask" id="as-form"><input id="as-q" placeholder="${tr('问点什么，比如「现在有什么风险」「M02 在哪」（按 / 键快速提问）')}" autocomplete="off" aria-label="${tr('向值班助手提问')}"><button class="primary">${tr('发送')}</button></form>
          <div class="as-chips">${QUICK.map((q) => `<button class="chip" data-ask="${esc(q)}">${esc(tx(q))}</button>`).join('')}</div>
        </div>
        <aside class="as-watch"><h3>${tr('此刻要关注')} <small id="as-watch-sub"></small></h3><ol id="as-watch"></ol></aside>
      </div>
      <div class="as-drawer" id="as-drawer" role="dialog" aria-modal="false" hidden></div>`;
    const q = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;
    this.els = { msgs: q('as-msgs'), q: q('as-q'), watch: q('as-watch'), watchSub: q('as-watch-sub'), drawer: q('as-drawer'), role: q('as-role'), engine: q('as-engine'), auditBadge: q('as-audit'), apprBadge: q('as-appr') };
    q('as-q').addEventListener('focus', () => void this.loadBot().catch(() => undefined), { once: true });
    if (typeof IntersectionObserver !== 'undefined') {
      const io = new IntersectionObserver((es) => {
        if (es.some((e) => e.isIntersecting)) {
          io.disconnect();
          void this.loadBot().catch(() => undefined);
        }
      });
      io.observe(root);
    }
    this.els.role.value = this.role;
    this.els.engine.value = this.engine;
    this.els.engine.onchange = () => {
      this.engine = this.els.engine.value === 'server' ? 'server' : 'builtin';
      try {
        localStorage.setItem(ENGINE_KEY, this.engine);
      } catch {
        /* 存不了就只在这次有效 */
      }
    };
    this.els.role.onchange = () => {
      this.role = this.els.role.value as Role;
      try {
        localStorage.setItem(ROLE_KEY, this.role);
      } catch {
        /* 存不了就只在这次有效 */
      }
      this.updateProposals();
      this.renderWatch(true);
      if (this.drawer) this.openDrawer(this.drawer);
      this.note(`${tr('现在的角色：{role}。', { role: tx(ROLE_LABEL[this.role]) })}${this.role === 'viewer' ? tr('只能看和问，不能执行。') : this.role === 'dispatcher' ? tr('低风险的和多花不超过 $100 的可以直接执行，更贵的提交站长审批。') : this.role === 'manager' ? tr('$1,000 以内直接执行，并审批调度员提交的。') : tr('都能执行和审批。')}`);
    };
    q<HTMLFormElement>('as-form').onsubmit = (e) => {
      e.preventDefault();
      const text = this.els.q.value.trim();
      if (!text) return;
      this.els.q.value = '';
      this.ask(text);
    };
    root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-ask],[data-link],[data-exec],[data-dismiss],[data-drawer],[data-close],[data-shift],[data-copy],[data-save],[data-decide],[data-show],[data-cf]');
      if (!el) return;
      const d = el.dataset;
      if (d.ask) this.ask(d.ask);
      else if (d.link) {
        const l = JSON.parse(d.link) as Link;
        if (l.kind === 'panel') this.openDrawer(l.panel);
        else this.host.link(l);
      } else if (d.exec) this.exec(d.exec);
      else if (d.dismiss) this.dismiss(d.dismiss);
      else if (d.drawer) this.openDrawer(d.drawer as Drawer);
      else if (d.close !== undefined) this.closeDrawer();
      else if (d.shift) {
        this.shift = d.shift as Shift['key'];
        this.openDrawer('handover');
      } else if (d.copy !== undefined) void this.copy(d.copy);
      else if (d.save) this.save(d.save);
      else if (d.decide) this.decide(d.decide, el.dataset.ok === '1');
      else if (d.show) this.showProposal(d.show);
      else if (d.cf) void this.counterfactual(d.cf, el);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement | null)?.isContentEditable) return;
      e.preventDefault();
      this.els.q.focus();
      this.els.q.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  get currentRole(): Role {
    return this.role;
  }

  /** 数据准备好时打个招呼（换了方案、日子、演练或负荷再说一次），列出此刻要关注的 */
  greet(key = ''): void {
    if (this.greeted === key) return;
    const ctx = this.host.ctx();
    if (!ctx) return;
    const first = this.greeted === undefined;
    this.greeted = key;
    const list = watchList(ctx, 3);
    for (const w of watchList(ctx, 20)) this.seen.add(w.key);
    const head = first ? tr('我是值班助手。现在 {t}', { t: clock(ctx.t) }) : tr('换了一天的情况（现在 {t}）', { t: clock(ctx.t) });
    const drill = ctx.drill ? tr('今天在演练「{label}」：{detail}。', { label: tx(ctx.drill.label), detail: txLine(ctx.drill.detail) }) : '';
    const text = [`${head}。${drill}${list.length ? tr('有 {length} 件事要关注：', { length: list.length }) : tr('眼下没有要特别关注的事。')}`, ...list.map((w) => `- ${txLine(w.text)}`), ...(first ? [tr('可以直接问我，比如「M02 在哪」「为什么推荐第一条」「写交接班报告」。')] : [])].join('\n');
    this.post('bot', md(text));
  }

  /** 时间走到 t：更新「此刻要关注」，放太久的审批单往上报，新出现的紧急情况提醒一句 */
  setTime(t: number, force = false): void {
    const now = performance.now();
    const minute = Math.floor(t / 60);
    if (!force && (minute === this.lastT || now - this.lastReal < 300)) return;
    const jumped = this.lastT < 0 || Math.abs(minute - this.lastT) > 10;
    this.lastT = minute;
    this.lastReal = now;
    for (const a of this.approvals.escalate(t)) this.note(tr('审批单 {id}「{title}」放了 20 分钟没人批，已经报区域经理。', { id: a.id, title: txLine(a.proposal.title) }));
    const ctx = this.host.ctx();
    if (!ctx) return;
    const list = watchList(ctx, 20);
    if (!jumped)
      for (const w of list) {
        if (this.seen.has(w.key) || w.level < 2) continue;
        this.note(tr('新情况 {t}：{text}', { t: clock(t), text: txLine(w.text) }), w.proposal);
      }
    for (const w of list) this.seen.add(w.key);
    this.renderWatch();
  }

  /** 数据变了（重新仿真、闭环重跑）：刷新右边的清单和打开的抽屉 */
  refresh(): void {
    this.renderWatch(true);
    if (this.drawer && this.drawer !== 'audit') this.openDrawer(this.drawer);
  }

  ask(text: string): void {
    // 英文界面：问句按钮发的是中文原句，显示成英文；照着示例打的英文问句换回中文（内置助手只懂中文）
    this.post('me', `<p>${esc(txLine(text))}</p>`);
    if (this.engine === 'server') {
      void this.askServer(fromEnglish(text));
      return;
    }
    // 英文界面上随手打的英文：换成最像的示例问句（编号放回去），对不上就用英文说明内置助手懂什么
    const routed = this.route(text);
    if (!routed) return;
    text = routed.zh;
    const via = routed.via;
    const ctx = this.host.ctx();
    if (!ctx) {
      this.post('bot', `<p>${tr('数据还在准备（仿真跑完就好），稍等一下再问。')}</p>`);
      return;
    }
    if (this.bot) {
      this.answerWith(this.bot, text, ctx, via);
      return;
    }
    const wait = this.post('bot', `<p>${tr('正在载入值班助手…')}</p>`);
    this.loadBot().then(
      (bot) => {
        wait.remove();
        this.answerWith(bot, text, this.host.ctx() ?? ctx, via);
      },
      (err: unknown) => {
        wait.innerHTML = `<p>${tr('值班助手没能载入：{err}', { err: esc(String(err)) })}</p>`;
      },
    );
  }

  /**
   * 英文界面上打的英文问题：返回交给内置助手的中文问句（via = 按哪句示例理解的）；对不上就贴出英文说明和示例按钮，返回 undefined。
   * 中文界面、中文问题原样返回。
   */
  private route(text: string): { zh: string; via?: string } | undefined {
    const r = isEn() ? routeEnglish(text) : undefined;
    if (!r) return { zh: text };
    if (r.zh) return { zh: r.zh, ...(r.via ? { via: r.via } : {}) };
    this.post('bot', `<p>${esc(t('内置的值班助手只懂中文问题和跟下面示例差不多的英文问题，这一句没对上。可以点一个示例，或者换个说法；想用英文随便问，把引擎换成「本机孪生服务（可接大模型）」，由大模型回答。'))}</p><div class="as-links">${ROUTE_EXAMPLES.map((q) => `<button class="chip" data-ask="${esc(q)}">${esc(txLine(q))}</button>`).join('')}</div>`);
    return undefined;
  }

  private answerWith(bot: Assistant, text: string, ctx: AssistCtx, via?: string): void {
    let a: Answer;
    try {
      // 提议按面板上选的角色检查权限；英文界面不检索只有中文的设计文档（摘录没法显示成英文），处理办法和预案照常
      a = bot.ask(text, { ...ctx, role: this.role, ...(isEn() ? { docs: NO_DOCS } : {}) });
    } catch (err) {
      this.post('bot', `<p>${tr('没答上来：{err}', { err: esc(String(err)) })}</p>`);
      return;
    }
    this.post('bot', `${via ? `<p class="as-sub">${esc(t('按「{q}」回答：', { q: via }))}</p>` : ''}${this.answerHtml(a)}`);
  }

  /**
   * 问本机孪生服务（/api/assistant；服务那边设了 STOREX_LLM 就由大模型组织语言）。服务的数据是它自己那一份：
   * 回答里的提议、链接在网页里不执行、不跳转，只列出来；连不上就说明怎么启动，并改用网页里的内置助手回答。
   */
  private async askServer(text: string): Promise<void> {
    const url = twinServer();
    const wait = this.post('bot', `<p>${esc(t('正在问本机孪生服务…'))}</p>`);
    try {
      const res = await fetch(`${url}/api/assistant`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: text, role: this.role }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const a = (await res.json()) as Answer;
      const props = a.proposals?.length ? `\n\n${t('孪生服务给的提议（在孪生服务那边确认，网页里不执行）')}：\n${a.proposals.map((p) => `- ${p.title}`).join('\n')}` : '';
      const shown: Answer = { ...a, proposals: [], links: [], text: `${a.text}${props}` };
      wait.innerHTML = `<p class="as-sub">${esc(t('引擎'))}：${esc(a.engine ?? 'builtin')}${a.engineNote ? ` · ${esc(a.engineNote)}` : ''}</p>${this.answerHtml(shown)}`;
    } catch (err) {
      wait.innerHTML = `<p>${esc(t('连不上本机孪生服务（{url}）：{err}。先在本机启动 npm run twin-server -- --allow-origin {origin}，或者把引擎切回「内置」。这次先用内置助手回答。', { url, err: String(err), origin: location.origin }))}</p>`;
      const ctx = this.host.ctx();
      const routed = ctx ? this.route(text) : undefined;
      if (ctx && routed) this.answerWith(await this.loadBot(), routed.zh, ctx, routed.via);
    }
  }

  /** 别的面板（分层看板的告警、往上报）发来的提醒 */
  notify(text: string): void {
    this.note(text);
  }

  /**
   * 闭环面板上直接点建议卡的按钮时也按角色走：能执行就记一笔、返回 true；不能执行就提交审批（或者只读不让做），返回 false。
   */
  gate(p: Proposal, via: string): boolean {
    const t = this.host.ctx()?.t ?? 0;
    if (this.role === 'viewer') {
      this.note(tr('只读角色不能执行「{title}」。', { title: txLine(p.title) }));
      return false;
    }
    if (canExecute(this.role, p)) {
      this.approvals.record({ t, who: this.role, act: 'execute', what: p.title, via, effect: p.effect, ...(p.checks ? { policy: policySummary(p) } : {}) });
      this.updateBadges();
      return true;
    }
    const a = this.approvals.request(p, this.role, t, via, p.checks ? policySummary(p) : undefined);
    this.note(tr('「{title}」要多花 ${cost}，超过{role}能直接执行的范围，已经提交{role2}审批（{id}）。', { title: txLine(p.title), cost: Math.round(p.cost), role: tx(ROLE_LABEL[this.role]), role2: tx(ROLE_LABEL[a.need]), id: a.id }));
    this.updateBadges();
    this.renderWatch(true);
    return false;
  }

  // —— 对话 ——

  private post(cls: 'me' | 'bot' | 'note', html: string): HTMLElement {
    const li = document.createElement('li');
    li.className = `as-msg ${cls}`;
    li.innerHTML = html;
    this.els.msgs.append(li);
    while (this.els.msgs.children.length > 120) this.els.msgs.firstElementChild?.remove();
    this.els.msgs.scrollTop = this.els.msgs.scrollHeight;
    return li;
  }

  private note(text: string, p?: Proposal): void {
    this.post('note', `${md(text)}${p ? this.propHtml(p, tr('此刻要关注')) : ''}`);
  }

  /**
   * 回答的四段：结论（醒目）、正文、提议；下面是依据（数据来自哪里、截至几点、数据质量）、把握（三项相乘）、下一步（谁来确认）。
   * 要问清楚的给几个按钮；超出范围、拒绝跳过规则的单独标出来。「怎么得出的」里是意图、调用的工具、认出来的参数和数字核对。
   */
  private answerHtml(a: Answer): string {
    // 显示的文字按当前语言逐行翻（中文界面原样）；问句按钮显示翻好的文字，发给助手的还是中文原句
    const v = answerView(a, tx, this.cardTitle);
    const links = v.links.length ? `<div class="as-links">${v.links.map((l) => `<button class="chip" data-link="${esc(JSON.stringify(l.link))}">${esc(l.label)}</button>`).join('')}</div>` : '';
    const props = a.proposals.map((p) => this.propHtml(p, tr('值班助手的提议'))).join('');
    const clarify = v.clarify ? `<div class="as-clarify"><span>${esc(v.clarify.question)}</span>${v.clarify.options.map((o) => `<button class="chip" data-ask="${esc(o.ask)}">${esc(o.label)}</button>`).join('')}</div>` : '';
    const follow = v.followups.length ? `<div class="as-links">${v.followups.map((f) => `<button class="chip" data-ask="${esc(f.ask)}">${esc(f.label)}</button>`).join('')}</div>` : '';
    const flag = a.refused ? `<span class="as-flag refuse">${tr('拒绝跳过规则')}</span>` : a.declined ? `<span class="as-flag decline">${tr('超出范围')}</span>` : a.clarify ? `<span class="as-flag ask">${tr('要问清楚')}</span>` : '';
    const c = a.certainty;
    const q = a.basis.quality;
    const basis = `<div><b>${tr('依据')}</b>${tr('{cites}；数据截至 {asOf}；数据质量：', { cites: esc(v.cites.join(isEn() ? '; ' : '；')), asOf: clock(a.basis.asOf) })}<span class="q-${q.level}">${esc(v.quality)}</span></div>`;
    const sure = `<div><b>${tr('把握')}</b><span class="lv-${c.level === '高' ? 'hi' : c.level === '中' ? 'mid' : 'lo'}">${esc(v.level)} ${pct(c.value)}</span> ${tr('= 意图 {intent} × 数据 {data} × 模型 {model}', { intent: pct(c.intent), data: pct(c.data), model: pct(c.model) })}${v.notes.length ? `<ul>${v.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</div>`;
    const next = v.next.length ? `<div><b>${tr('下一步')}</b><ul>${v.next.map((n) => `<li>${esc(n.text)}${n.who ? `<span class="who">${esc(n.who)}</span>` : ''}</li>`).join('')}</ul></div>` : '';
    const g = a.grounding;
    const ents = [...a.entities.vehicles, ...a.entities.fams, ...a.entities.doors, ...(a.entities.hub ? [a.entities.hub] : [])];
    const how = [tr('意图「{intent}」（把握 {confidence}）', { intent: tx(INTENT_LABEL[a.intent] ?? a.intent), confidence: pct(a.confidence) }), `${tr('调用了')} ${a.tools.map((x) => x.name).join(isEn() ? ', ' : '、')}`, ents.length ? tr('认出的参数：{ents}', { ents: ents.join(isEn() ? ', ' : '、') }) : '', a.entities.fuzzy?.length ? tr('按写法对上：{fuzzy}', { fuzzy: a.entities.fuzzy.join(isEn() ? ', ' : '、') }) : '', g.total ? (g.missing.length ? tr('数字核对：{grounded} / {total} 个找得到出处，没找到的：{missing}', { grounded: g.grounded, total: g.total, missing: g.missing.join(isEn() ? ', ' : '、') }) : tr('数字核对：{total} 个数字、时刻、编号都能在数据里找到', { total: g.total })) : ''].filter(Boolean);
    return `<div class="as-concl">${flag}<b>${tr('结论')}</b>${esc(v.conclusion)}</div>${md(v.body)}${clarify}${props}${links}${follow}<div class="as-meta">${basis}${sure}${next}<details><summary>${tr('怎么得出的')}</summary>${how.map((x) => esc(x)).join('<br>')}</details></div>`;
  }

  /** 建议卡的完整标题（回答里的链接文字是截短的中文，英文界面按完整标题翻） */
  private readonly cardTitle = (key: string): string | undefined => this.host.ctx()?.twin?.recs.find((r) => r.key === key)?.title;

  private propHtml(p: Proposal, via: string): string {
    if (!this.props.has(p.id)) this.props.set(p.id, { p, state: 'open', via });
    const x = this.props.get(p.id) as { p: Proposal; state: string; via: string };
    const warn = (p.checks ?? []).filter((c) => c.level === 'warn' && !c.ok);
    const pv = proposalView(p);
    const checks = warn.length ? `<ul class="as-checks">${pv.checks.map((c) => `<li><b>${esc(c.label)}</b>${esc(c.text)}</li>`).join('')}</ul>` : '';
    return `<div class="as-prop risk-${p.risk} st-${x.state}" data-prop="${p.id}"><header>${esc(pv.title)}<span class="tag">${p.risk === 'low' ? tr('低风险') : tr('要花钱或改计划')}</span>${p.cost >= 1 ? `<span class="tag">${tr('多花 ${cost}', { cost: Math.round(p.cost) })}</span>` : ''}${p.manualOnly ? `<span class="tag warn">${tr('先核实，逐条确认')}</span>` : ''}${p.actions.some((a) => a.kind === 'notify') ? `<span class="tag">${tr('通知')}</span>` : ''}</header><p>${esc(pv.effect)}</p>${checks}<footer>${this.propFooter(p.id)}</footer></div>`;
  }

  private propFooter(id: string): string {
    const x = this.props.get(id);
    if (!x) return '';
    if (x.state === 'done') return `<span>${esc(x.note ?? tr('已执行'))}</span>`;
    if (x.state === 'requested') return `<span>${esc(x.note ?? tr('已提交审批'))}</span>`;
    if (x.state === 'dismissed') return `<span>${tr('不用了')}</span>`;
    if (this.role === 'viewer') return `<button class="chip" disabled>${tr('只读角色不能执行')}</button>`;
    const can = canExecute(this.role, x.p);
    return `<button class="primary" data-exec="${id}">${can ? tr('确认执行') : tr('提交{role}审批', { role: tx(ROLE_LABEL[approverOf(x.p)]) })}</button><button class="ghost" data-dismiss="${id}">${tr('不用了')}</button>${can ? '' : `<span>${tr('{role}能直接执行的上限是 $', { role: tx(ROLE_LABEL[this.role]) })}${this.role === 'dispatcher' ? 100 : 1000}</span>`}`;
  }

  private updateProposals(): void {
    for (const el of this.els.msgs.querySelectorAll<HTMLElement>('[data-prop]')) {
      const id = el.dataset.prop as string;
      const x = this.props.get(id);
      if (!x) continue;
      el.className = `as-prop risk-${x.p.risk} st-${x.state}`;
      const f = el.querySelector('footer');
      if (f) f.innerHTML = this.propFooter(id);
    }
  }

  private exec(id: string): void {
    const x = this.props.get(id);
    if (!x || x.state !== 'open' || this.role === 'viewer') return;
    const t = this.host.ctx()?.t ?? 0;
    if (canExecute(this.role, x.p)) {
      const err = this.host.execute(x.p);
      if (err) {
        x.state = 'dismissed';
        this.note(tr('没有执行「{title}」：{err}', { title: txLine(x.p.title), err: txLine(err) }));
      } else {
        this.approvals.record({ t, who: this.role, act: 'execute', what: x.p.title, via: x.via, effect: x.p.effect, ...(x.p.checks ? { policy: policySummary(x.p) } : {}) });
        // 通知类（新的预约时段）：孪生里不改数据，记进操作记录，由人或预约系统下发
        for (const a of x.p.actions) if (a.kind === 'notify') this.note(tr('已记进操作记录，请通知{to}：{text}', { to: txLine(a.to), text: txLine(a.text) }));
        x.state = 'done';
        x.note = tr('已执行 {t}（{role}）', { t: clock(t), role: tx(ROLE_LABEL[this.role]) });
      }
    } else {
      const a = this.approvals.request(x.p, this.role, t, x.via, x.p.checks ? policySummary(x.p) : undefined);
      x.state = 'requested';
      x.note = tr('已提交{role}审批（{id}，{t}）', { role: tx(ROLE_LABEL[a.need]), id: a.id, t: clock(t) });
    }
    this.updateProposals();
    this.updateBadges();
    this.renderWatch(true);
  }

  private dismiss(id: string): void {
    const x = this.props.get(id);
    if (!x || x.state !== 'open') return;
    x.state = 'dismissed';
    this.updateProposals();
  }

  /** 「此刻要关注」里点「处理」：把那条提议放到对话里，确认后才执行 */
  private showProposal(key: string): void {
    const ctx = this.host.ctx();
    if (!ctx) return;
    const w = watchList(ctx, 20).find((x) => x.key === key);
    if (!w?.proposal) return;
    this.post('bot', `${md(txLine(w.text))}${this.propHtml(w.proposal, tr('此刻要关注'))}`);
  }

  // —— 此刻要关注 ——

  private renderWatch(force = false): void {
    void force;
    const ctx = this.host.ctx();
    if (!ctx) {
      this.els.watch.innerHTML = `<li class="empty">${tr('数据准备好以后，这里列出此刻要关注的事。')}</li>`;
      return;
    }
    const pend = this.approvals.pending();
    const items = watchList(ctx, 8);
    this.els.watchSub.textContent = tr('{t} · {length} 件', { t: clock(ctx.t), length: items.length + pend.length });
    const appr = pend.map((a) => `<li class="lv-2"><span class="dot"></span><div>${tr('待审批 {id}：{title}（{role}提交，交{role2}{v5}）', { id: a.id, title: esc(txLine(a.proposal.title)), role: tx(ROLE_LABEL[a.by]), role2: tx(ROLE_LABEL[a.need]), v5: a.escalatedAt ? tr('，已往上报') : '' })}<div class="acts"><button class="chip" data-drawer="approvals">${tr('去审批')}</button></div></div></li>`);
    const rows = items.map((w) => {
      const links = w.links.slice(0, 2).map((l) => `<button class="chip" data-link="${esc(JSON.stringify(l))}">${esc(linkLabel(l, tx, this.cardTitle))}</button>`);
      const act = w.proposal ? `<button class="chip" data-show="${esc(w.key)}">${tr('处理')}</button>` : '';
      return `<li class="lv-${w.level}"><span class="dot"></span><div>${esc(txLine(w.text))}${links.length || act ? `<div class="acts">${act}${links.join('')}</div>` : ''}</div></li>`;
    });
    this.els.watch.innerHTML = [...appr, ...rows].join('') || `<li class="empty">${tr('眼下没有要特别关注的事。')}</li>`;
    this.updateBadges();
  }

  private updateBadges(): void {
    const n = this.approvals.pending(this.role).length;
    this.els.apprBadge.textContent = n ? String(n) : '';
    this.els.auditBadge.textContent = this.approvals.log.length ? String(this.approvals.log.length) : '';
  }

  // —— 抽屉：交接班报告、建议复盘、操作记录、审批单 ——

  private openDrawer(kind: Drawer): void {
    this.drawer = kind;
    const ctx = this.host.ctx();
    const el = this.els.drawer;
    const close = `<button class="ghost" data-close>${tr('关闭')}</button>`;
    let head = '';
    let body = '';
    if (kind === 'dailyplan') {
      if (!ctx) body = `<p>${tr('数据还在准备。')}</p>`;
      else {
        const p = dailyPlan(ctx);
        head = `<h3>${esc(txLine(p.title))}</h3><button class="ghost" data-copy="dailyplan">${tr('复制')}</button><button class="ghost" data-save="dailyplan">${tr('下载 .md')}</button>${close}`;
        body = `<p class="note">${tr('早会用：今天会怎样（计划、预测和此刻以前的现场数据）；交接班报告看「发生了什么」。')}</p>${p.sections.map((x) => `<h4>${esc(txLine(x.title))}</h4><ul>${x.lines.map((l) => `<li>${esc(txLine(l))}</li>`).join('')}</ul>`).join('')}`;
      }
    } else if (kind === 'handover') {
      if (!ctx) body = `<p>${tr('数据还在准备。')}</p>`;
      else {
        const s = SHIFTS.find((x) => x.key === this.shift) ?? reportShift(ctx.t);
        const h = handover(ctx, s);
        head = `<h3>${esc(txLine(h.title))}</h3><div class="seg">${SHIFTS.map((x) => `<button data-shift="${x.key}" aria-pressed="${x.key === s.key}">${tx(x.name)}</button>`).join('')}</div><button class="ghost" data-copy>${tr('复制')}</button><button class="ghost" data-save="handover">${tr('下载 .md')}</button>${close}`;
        body = `<p class="note">${tr('{asOf} · {v2}；「下一班要注意」按计划和孪生的估计。', { asOf: esc(clock(h.asOf)), v2: ctx.t < s.to ? tr('本班还没结束，按到此刻为止的数据写') : tr('班次已经结束') })}</p>${h.sections.map((x) => `<h4>${esc(txLine(x.title))}</h4><ul>${x.lines.map((l) => `<li>${esc(txLine(l))}</li>`).join('')}</ul>`).join('')}`;
      }
    } else if (kind === 'review') {
      head = `<h3>${tr('建议复盘')}</h3>${close}`;
      const res = ctx?.twin?.result;
      if (!res || !ctx) body = `<p>${tr('闭环孪生跑完以后才能复盘。')}</p>`;
      else {
        const rv = review(res, ctx.t);
        const pct = (x: number) => `${Math.round(x * 100)}%`;
        body = `<p class="note">${tr('到 {t} 为止有了结论的建议卡：孪生出卡时预测的结果，和事后现场实际发生的比（预测用实际做了的那个做法；差 10 分钟以内或 30% 以内算命中）。', { t: clock(ctx.t) })}</p>${rv.notes.map((x) => `<p>${esc(txLine(x))}</p>`).join('')}`;
        if (rv.rows.length) {
          body += `<h4>${tr('按类别')}</h4><div class="tbl"><table><thead><tr><th>${tr('类别')}</th><th class="num">${tr('张数')}</th><th class="num">${tr('执行（自动 / 人工）')}</th><th class="num">${tr('否决')}</th><th class="num">${tr('发生了')}</th><th class="num">${tr('自己没了')}</th><th class="num">${tr('平均差（分钟）')}</th><th class="num">${tr('命中')}</th></tr></thead><tbody>${[...rv.byKind, rv.total].map((k) => `<tr><td>${esc(tx(k.label))}</td><td class="num">${k.n}</td><td class="num">${k.done}（${k.auto} / ${k.user}）</td><td class="num">${k.rejected}</td><td class="num">${k.expired}</td><td class="num">${k.resolved}</td><td class="num">${k.mae.toFixed(1)}</td><td class="num">${pct(k.hitRate)}</td></tr>`).join('')}</tbody></table></div>`;
          body += `<h4>${tr('逐张')}</h4><div class="tbl"><table><thead><tr><th>${tr('出卡')}</th><th>${tr('建议卡')}</th><th>${tr('实际做了')}</th><th>${tr('看什么')}</th><th class="num">${tr('预测')}</th><th class="num">${tr('实际')}</th><th></th></tr></thead><tbody>${rv.rows.map((r) => `<tr><td>${clock(r.t)}</td><td>${esc(txLine(r.title))}</td><td>${esc(txLine(r.did))}${r.by ? `（${r.by === 'auto' ? tr('自动') : tr('人工')}）` : ''}</td><td>${esc(tx(r.metric))}</td><td class="num">${Math.round(r.predicted)}</td><td class="num">${Math.round(r.actual)}</td><td class="${r.hit ? 'hit' : 'miss'}">${r.hit ? tr('命中') : tr('偏差大')}</td><td>${this.host.counterfactual && r.flippable ? `<button class="chip" data-cf="${esc(r.key)}" title="${tr('把当时的决定反过来，整天再推演一遍')}">${r.status === 'done' ? tr('如果当时不执行') : tr('如果当时执行')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div><p class="note">${tr('「如果当时……」：把那张卡的决定反过来，同样的现场整天再推演一遍（约零点几秒），看这个决定实际值多少。现实里做不到，孪生里可以。')}</p>`;
        }
      }
    } else if (kind === 'audit') {
      head = `<h3>${tr('操作记录')}</h3><button class="ghost" data-save="audit">${tr('导出 .csv')}</button>${close}`;
      const log = this.approvals.log;
      body = log.length
        ? `<div class="tbl"><table><thead><tr><th>${tr('仿真时刻')}</th><th>${tr('角色')}</th><th>${tr('动作')}</th><th>${tr('内容')}</th><th>${tr('来源')}</th><th>${tr('预计效果')}</th><th>${tr('规则检查')}</th></tr></thead><tbody>${[...log]
            .reverse()
            .map((e) => `<tr><td>${clock(e.t)}</td><td>${tx(ROLE_LABEL[e.who])}</td><td>${tx(ACT_LABEL[e.act])}</td><td>${esc(txLine(e.what))}</td><td>${esc(txLine(e.via))}</td><td>${esc(txLine(e.effect))}</td><td>${esc(txLine(e.policy ?? ''))}</td></tr>`)
            .join('')}</tbody></table></div>`
        : `<p class="note">${tr('还没有操作。值班助手的提议、闭环面板上的建议卡，执行、提交审批、批准、驳回都会记在这里（真实时间和仿真时刻都记）。')}</p>`;
    } else {
      head = `<h3>${tr('审批单')}</h3>${close}`;
      const pend = this.approvals.pending();
      const done = this.approvals.list.filter((a) => a.status !== 'pending');
      body = `<p class="note">${tr('调度员能直接执行低风险的和多花不超过 $100 的；更贵的交站长（$1,000 以内）或区域经理；放了 20 分钟（仿真时间）没人批的往上报。现在的角色：{role}。', { role: tx(ROLE_LABEL[this.role]) })}</p>`;
      body += pend.length
        ? `<h4>${tr('待审批')}</h4><ul>${pend.map((a) => `<li><b>${a.id}</b> ${tr('{title}：{effect}（{role} {t} 提交，交{role2}）', { title: esc(txLine(a.proposal.title)), effect: esc(txLine(a.proposal.effect)), role: tx(ROLE_LABEL[a.by]), t: clock(a.t), role2: tx(ROLE_LABEL[a.need]) })}${canApprove(this.role, a.need) ? ` <button class="chip" data-decide="${a.id}" data-ok="1">${tr('批准并执行')}</button> <button class="chip" data-decide="${a.id}" data-ok="0">${tr('驳回')}</button>` : ` <span class="note">${tr('要{role}批', { role: tx(ROLE_LABEL[a.need]) })}</span>`}</li>`).join('')}</ul>`
        : `<p>${tr('没有待审批的。')}</p>`;
      if (done.length) body += `<h4>${tr('已处理')}</h4><ul>${done.map((a) => `<li>${a.id} ${esc(txLine(a.proposal.title))} → ${a.status === 'approved' ? tr('批准并执行') : tr('驳回')}（${a.decidedBy ? tx(ROLE_LABEL[a.decidedBy]) : ''} ${a.decidedAt !== undefined ? clock(a.decidedAt) : ''}）</li>`).join('')}</ul>`;
    }
    el.innerHTML = `<header>${head || close}</header><div class="body">${body}</div>`;
    el.hidden = false;
  }

  private async counterfactual(key: string, el: HTMLElement): Promise<void> {
    if (!this.host.counterfactual) return;
    const btn = el as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = tr('推演中…');
    try {
      const text = await this.host.counterfactual(key);
      btn.replaceWith(Object.assign(document.createElement('span'), { className: 'note', textContent: text }));
      this.note(tr('复盘推演：{text}', { text }));
    } catch (err) {
      btn.textContent = tr('出错：{err}', { err: String(err) });
    }
  }

  private closeDrawer(): void {
    this.drawer = undefined;
    this.els.drawer.hidden = true;
  }

  private decide(id: string, ok: boolean): void {
    const t = this.host.ctx()?.t ?? 0;
    const a = this.approvals.decide(id, ok, this.role, t);
    if (!a) return;
    if (ok) {
      const err = this.host.execute(a.proposal);
      this.note(err ? tr('批准了 {id}，但没有执行：{err}', { id: a.id, err }) : tr('{role}批准了 {id}「{title}」，已执行。', { role: tx(ROLE_LABEL[this.role]), id: a.id, title: txLine(a.proposal.title) }));
    } else this.note(tr('{role}驳回了 {id}「{title}」。', { role: tx(ROLE_LABEL[this.role]), id: a.id, title: txLine(a.proposal.title) }));
    for (const x of this.props.values())
      if (x.p.id === a.proposal.id) {
        x.state = ok ? 'done' : 'dismissed';
        x.note = ok ? tr('{role}批准后执行（{t}）', { role: tx(ROLE_LABEL[this.role]), t: clock(t) }) : tr('被驳回');
      }
    this.updateProposals();
    this.openDrawer('approvals');
    this.renderWatch(true);
  }

  private async copy(what = ''): Promise<void> {
    const ctx = this.host.ctx();
    if (!ctx) return;
    const plan = what === 'dailyplan';
    // 导出跟界面语言走：英文界面逐行翻成英文（和面板上显示的一样），中文界面原样
    const text = txMarkdown(plan ? dailyPlan(ctx).markdown : handover(ctx, SHIFTS.find((x) => x.key === this.shift) ?? reportShift(ctx.t)).markdown);
    try {
      await navigator.clipboard.writeText(text);
      this.note(`${plan ? tr('今日计划') : tr('交接班报告')}${tr('已复制（Markdown）。')}`);
    } catch {
      this.note(tr('浏览器不让复制，可以用「下载 .md」。'));
    }
  }

  private save(kind: string): void {
    const ctx = this.host.ctx();
    let name = 'audit.csv';
    let text = this.approvals.csv(clock);
    let type = 'text/csv';
    if (kind === 'handover' && ctx) {
      const s = SHIFTS.find((x) => x.key === this.shift) ?? reportShift(ctx.t);
      text = txMarkdown(handover(ctx, s).markdown);
      name = `handover-${s.key}.md`;
      type = 'text/markdown';
    } else if (kind === 'dailyplan' && ctx) {
      text = txMarkdown(dailyPlan(ctx).markdown);
      name = 'daily-plan.md';
      type = 'text/markdown';
    }
    const url = URL.createObjectURL(new Blob([kind === 'audit' ? `﻿${text}` : text], { type: `${type};charset=utf-8` }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
