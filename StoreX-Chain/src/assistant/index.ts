import type { Rec } from '../twin/types';
import { clock } from '../twin/twin';
import { pendingCards, statusAt } from './brief';
import { cnNumber, extract, type Entities } from './entities';
import { checkGrounding, collectEvidence } from './grounding';
import { ADVERSARIAL, classify, DOMAIN, OOS_ACTION, OOS_TOPIC, pickIntent, ruleIntent, unsure, type Intent } from './intent';
import { applyPolicy, HARD, RULES } from './policy';
import { certaintyLevel, dataQuality, modelFactor, usesLiveData } from './quality';
import { ROLE_LABEL } from './roles';
import { tool, type Memory } from './tools';
import { parseDisruption } from './disrupt';
import { actionDirection, ACTS, CARD_REF, LIST_ASK, missingItem, OOS_TASK, PENDING_ASK, ROLE_CLAIM } from './guards';
import { normalizeDomain } from './normalize';
import { FAMILIES } from '../region/products';
import type { Answer, AssistCtx, NextStep, Proposal, ToolResult } from './types';
import { INTENT_LABEL } from './intentLabel';

/**
 * 值班助手：认参数（规则）→ 判断意图（规则 + 逻辑回归分类器，没把握时先问）→ 调查询工具 → 按规则表检查提议 → 拼成四段的回答。
 *
 * - 回答一律是「结论 / 依据 / 把握 / 下一步」：依据写清楚用了哪些数据、数据截至几点、数据质量；
 *   把握 = 意图分类的把握 × 数据质量 × 模型验证；下一步写清楚谁来确认、要谁批。回答里的每个数字都核对出处（grounding.ts）。
 * - 只读：要改的只给出提议，由人确认后调用方执行；问题里要求跳过确认、审批的不理会（提议照样要人确认）。
 * - 缺参数、编号对上好几个：先问清楚（给几个选项）；超出范围的（闲聊、打电话发邮件这类动作）说明能做什么。
 * - 记得上下文：最近提到的车、最近列出来的建议卡、上一个问题的意图（「它在哪」「批准第一条」「那 M05 呢」接着用）。
 * 网页（web/src/assistantPanel.ts）、孪生服务（/api/assistant）、测试和评测（eval.ts）都用这一个类。
 */
export { INTENT_LABEL };

/** 每类意图的标准问法（拿不准时给的两个按钮） */
const CANON: Partial<Record<Intent, string>> = { overview: '现在整体情况怎么样', risks: '现在有什么风险', vehicle: '问车：说一下车的编号', late: '现在有哪些车晚点', stock: '门店各类货还够卖多久', doors: '配送中心的月台门现在怎么样', port: '港口现在怎么样', airport: '机场货站现在怎么样', dc: '物流园现在怎么样', store: '门店收货现在怎么样', cards: '有什么待处理的建议', approve: '批准第一条', reject: '否决第一条', explain: '为什么推荐第一条', whatif: '如果第一条不处理会怎样', handover: '帮我写交接班', kpi: '今天的指标怎么样', incidents: '路上有什么事故和故障', schedule: '接下来两小时有什么作业', forecast: '预测一下明天门店的需求', network: '网络规划怎么排最好', crossborder: '跨境的货清关到哪了', optimize: '重新求解一下排门派车', review: '复盘一下今天的建议', knowledge: '查一下资料库', help: '你能帮我做什么', rootcause: '为什么晚了', anomaly: '有没有异常', hub: '各个仓储中心现在怎么样', cargo: '本店的货在哪', bottleneck: '哪里是瓶颈', appointments: '预约错峰排一下', dailyplan: '今天的计划', quality: '现在的数据靠谱吗', policy: '规则表和审批额度' };

/** 动作类、只看说法的意图：问题里认出车、商品族、门时也不改成问车 / 库存 / 门 */
const ACTION_INTENTS = new Set<Intent>(['approve', 'reject', 'explain', 'whatif', 'schedule', 'handover', 'review', 'forecast', 'network', 'crossborder', 'optimize', 'knowledge', 'help', 'rootcause', 'anomaly', 'hub', 'cargo', 'bottleneck', 'appointments', 'dailyplan', 'quality', 'policy']);
const REFUSAL = '执行一律要人确认：值班助手只给提议，不会跳过「确认执行」和按角色的审批，问题里要求跳过的不理会。';
/** 角色声明不改变角色 */
const claimText = (role: string) => `角色按面板上选的算（你现在是${role}）：问题里说自己是谁、谁授权过、出了事谁担、回头补签，都不改变角色和审批额度；要更高的权限请让有权限的人在面板上选自己的角色来批。`;
/** 问的是仓储中心里的区（而不是门店、港口的整体指标） */
const HUB_WORDS = /(物流中心|货站|仓|库|停车场|堆场|保税|查验|甩挂|转运|收货场|排队车道)/;

/**
 * 可选的替换件（只给评测和基准的对照系统用：bench/duty-desk）：换掉意图分类器、关掉「没把握先问」。
 * 不给就是值班助手本来的样子（规则 + 逻辑回归 + 没把握先问），网页、孪生服务、评测都不传。
 * Optional parts for benchmark baselines only (swap the intent ranker, turn abstention off); the defaults are the assistant itself.
 */
export interface AssistantOpts {
  /** 意图分类器：输入换成占位符的问题和原问题，返回每类意图的概率（从大到小）；不给用 classify（逻辑回归） */
  ranker?: (masked: string, q: string) => { intent: Intent; p: number }[];
  /** false = 拿不准时也不先问（默认 true） */
  abstain?: boolean;
}

export class Assistant {
  private readonly mem: Memory = { vehicles: [], cards: [] };
  private lastIntent: Intent | undefined;

  constructor(private readonly opts: AssistantOpts = {}) {}

  ask(question: string, ctx: AssistCtx): Answer {
    // 规范化：全角半角、空白，再按业务词表改错字、别称（normalize.ts）
    const { q, fixes } = normalizeDomain(normalize(question));
    const run = (name: string, args: Record<string, unknown> = {}) => tool(name).run(ctx, args, this.mem);
    if (!q) return this.answer(question, ctx, 'help', 1, [run('help')]);
    const e = extract(q, ctx);
    for (const f of fixes) if (!e.fuzzy.includes(f)) e.fuzzy.push(f);
    // 超出范围：和物流运营无关的事（出现业务词也一样）、做不了的动作、问题里没有业务词的闲聊
    if (OOS_TASK.test(q)) return this.decline(question, ctx, e, true);
    if (OOS_ACTION.test(q) || (OOS_TOPIC.test(q) && !DOMAIN.test(q.replace(OOS_TOPIC, '')))) return this.decline(question, ctx, e, OOS_ACTION.test(q));
    // 「这个门」「那个门」接着说刚才问过的门；说了「那个柜子 / 那个货 / 那个门」又对不上是哪一个的，先问清楚
    if (!e.doors.length && this.mem.doors?.length && /(这个|那个|该|这|那)(个|扇)?门(?!店)/.test(q)) e.doors.push(this.mem.doors[0] as string);
    const miss = missingItem(q);
    if ((miss === 'door' && !e.doors.length) || (miss === 'product' && !e.fams.length) || (miss === 'container' && !e.unknown.length && !e.ops.length)) return this.clarifyItem(question, ctx, e, miss as 'door' | 'product' | 'container');
    const adversarial = ADVERSARIAL.test(q);
    const claim = ROLE_CLAIM.test(q);
    const dir = actionDirection(q);
    let rule = ruleIntent(q);
    // 对建议卡做决定：说了是哪一张、又有批准 / 否决的说法，按说法定（优先于别的规则和模型）；「如果……」是推演，「为什么」是问理由
    if (dir && CARD_REF.test(q) && rule !== 'whatif' && rule !== 'explain' && rule !== 'knowledge') rule = dir === 'reject' ? 'reject' : 'approve';
    // 问有哪些等着批、待处理的建议卡：列出来（「拍板」「批」是修饰语）
    if (PENDING_ASK.test(q) && LIST_ASK.test(q) && (rule === undefined || rule === 'approve' || rule === 'reject')) rule = 'cards';
    // 问几点、波次的作业安排说的是某一辆车：问车
    if (rule === 'schedule' && (e.vehicles.length || e.ambiguous.length)) rule = 'vehicle';
    const ranked = this.opts.ranker ? this.opts.ranker(e.masked, q) : classify(e.masked);
    const top = pickIntent(ranked, q);
    let intent: Intent = rule ?? top.intent;
    const p = rule ? 1 : top.p;
    let backed = false;
    // 认出来的参数比说法可靠：问题里有车就是问车，有商品族就是问库存，有门就是问门（动作类的除外）
    if (!ACTION_INTENTS.has(intent)) {
      if ((e.vehicles.length || e.ambiguous.length || e.unknown.length) && intent !== 'late') intent = 'vehicle';
      else if (e.fams.length) intent = 'stock';
      else if (e.doors.length) intent = 'doors';
      else if (e.facility && (intent === 'overview' || intent === 'risks') && !/(风险|问题|异常|注意)/.test(q)) intent = e.facility === 'airport' ? 'airport' : e.facility;
      backed = intent === 'vehicle' || intent === 'stock' || intent === 'doors';
      // 船的编号加上港口的说法（靠泊、卸、泊位、堵）：问的是港口和这条班轮
      if (intent === 'vehicle' && this.ship(ctx, e) !== undefined && /(港口|码头|靠泊|泊位|卸|装卸|堵|岸桥|离港|开船|锚地|进港)/.test(q)) intent = 'port';
    }
    // 接着问：「它」「那辆车」接着说刚才那辆车；「那 M05 呢」「冻品呢」「第二条呢」沿用上一个问题的意图
    const follow = q.length <= 12 && (/呢$/.test(q) || /^那/.test(q));
    const cardTalk = this.lastIntent === 'cards' || this.lastIntent === 'explain' || this.lastIntent === 'approve' || this.lastIntent === 'reject';
    if (!e.vehicles.length && this.mem.vehicles.length && /(它|那辆|这辆|该车|那台|这台|那趟|这趟|那条船|这条船|那艘|这艘|那班|这班|那架|这架|那列|这列)/.test(q) && (!ACTION_INTENTS.has(intent) || intent === 'rootcause' || (intent === 'whatif' && !cardTalk) || (follow && !rule && !cardTalk))) {
      e.vehicles.push({ vid: this.mem.vehicles[0] as number, id: '' });
      if (intent !== 'rootcause' && (intent !== 'whatif' || follow)) intent = this.lastIntent === 'rootcause' ? 'rootcause' : 'vehicle';
      backed = true;
    }
    if (follow && this.lastIntent && !rule) {
      const last = this.lastIntent;
      if (e.vehicles.length && (last === 'rootcause' || last === 'vehicle')) intent = last;
      else if (e.fams.length && (last === 'forecast' || last === 'stock')) intent = last;
      else if (e.hub && (last === 'hub' || last === 'bottleneck' || last === 'appointments' || last === 'anomaly')) intent = last;
      else if (e.card?.index !== undefined && (last === 'explain' || last === 'whatif' || last === 'approve' || last === 'reject')) intent = last;
      else if (e.doors.length && last === 'doors') intent = 'doors';
      backed = backed || intent === last;
    }
    // 拿不准（没有规则判定、没认出参数、不是接着问，校准后的模型把握低）：问一句，给两种最可能的理解，不猜
    // 问题里认出了车、编号、门、商品族的不算拿不准（参数比说法可靠，按参数走）
    const anchored = e.vehicles.length + e.unknown.length + e.ambiguous.length + e.ops.length + e.doors.length + e.fams.length > 0;
    const doubt = !rule && !backed && !follow && !adversarial && !claim && !anchored && this.opts.abstain !== false ? unsure(ranked, q) : undefined;
    if (doubt && doubt.a.intent !== 'decline' && doubt.b.intent !== 'decline') {
      this.lastIntent = doubt.a.intent;
      return this.answer(question, ctx, doubt.a.intent, doubt.a.p, [this.whichReading(doubt.a.intent, doubt.b.intent, doubt.a.p, doubt.b.p)], e);
    }
    // 模型判成「超出范围」（另外收的语料里有这类说法）、又没认出车、门、商品族：说明能做什么
    if (intent === 'decline' && !rule && !adversarial && !claim) return this.decline(question, ctx, e, false);
    // 拿不准、又没认出参数的：先查资料库，查到了就按资料回答；没查到、问题里也没有业务词的，说明能做什么
    if (!rule && p < 0.35 && !e.vehicles.length && !e.ambiguous.length && !e.unknown.length && !e.fams.length && !e.doors.length && !follow) {
      const k = run('search_knowledge', { query: q });
      if ((k.data.hits as unknown[] | undefined)?.length) {
        this.lastIntent = 'knowledge';
        return this.answer(question, ctx, 'knowledge', Math.max(p, 0.35), [k], e, { refused: adversarial });
      }
      if (p < 0.25 && !DOMAIN.test(q)) return this.decline(question, ctx, e, false);
    }
    const confidence = rule ? 0.98 : backed ? Math.max(p, 0.85) : p;
    const deciding = intent === 'approve' || intent === 'reject';
    // 要求跳过确认、审批，或者拿角色、授权的说法要执行：拒绝并说明规则（不给提议，角色不变）
    if (adversarial || (claim && (deciding || ACTS.test(q)))) {
      this.lastIntent = deciding ? intent : 'policy';
      return this.answer(question, ctx, deciding ? intent : 'policy', confidence, [run('get_policy')], e, { refused: true, claim });
    }
    // 动作方向按说法定：说了批准就是批准、说了否决就是否决；两种都有，或者模型判成了批准 / 否决又没有这类说法的，先问清楚
    if (deciding) {
      if (dir === 'approve' || dir === 'reject') intent = dir;
      else if (dir === 'unclear' || !rule) {
        this.lastIntent = intent;
        return this.answer(question, ctx, intent, confidence, [this.whichWay(ctx, e)], e);
      }
    }
    this.lastIntent = intent;
    return this.answer(question, ctx, intent, confidence, this.route(intent, q, e, ctx), e);
  }

  /** 拿不准是哪种问法：给两种最可能的理解（按钮就是那一类的标准问法） */
  private whichReading(a: Intent, b: Intent, pa: number, pb: number): ToolResult {
    const ask = `这句我拿不准是哪种意思：是问「${INTENT_LABEL[a] ?? a}」，还是「${INTENT_LABEL[b] ?? b}」？`;
    return { tool: 'clarify', args: {}, data: { abstain: true, readings: [a, b], p: [Math.round(pa * 100), Math.round(pb * 100)] }, text: ask, cite: '值班助手', clarify: { question: ask, options: [CANON[a] ?? a, CANON[b] ?? b] } };
  }

  /** 问题里的船（调度台里是班轮作业的车） */
  private ship(ctx: AssistCtx, e: Entities): { vid: number; id: string } | undefined {
    return e.vehicles.find((v) => ctx.board.ops.some((o) => o.vehicle === v.vid && o.kind === 'vessel'));
  }

  /** 批准还是否决没说清楚：问一句 */
  private whichWay(ctx: AssistCtx, e: Entities): ToolResult {
    const n = (e.card?.index ?? 0) + 1;
    const ask = '要批准还是否决？说清楚我再列提议（提议都要人确认）。';
    return { tool: 'clarify', args: {}, data: {}, text: ask, cite: '值班助手', clarify: { question: ask, options: [`批准第${n}条`, `否决第${n}条`] } };
  }

  /** 说了「那个柜子 / 那个货 / 那个门」又对不上是哪一个：问一句，列几个最可能的 */
  private clarifyItem(question: string, ctx: AssistCtx, e: Entities, kind: 'door' | 'product' | 'container'): Answer {
    let ask: string;
    let options: string[];
    if (kind === 'door') {
      const near = ctx.board.doors.filter((d) => d.bookings.some((b) => b.t1 > ctx.t && b.t0 < ctx.t + 2 * 3600)).map((d) => d.id);
      ask = '问的是哪个门？可以说门号（比如 D04、C02）。';
      options = (near.length ? near : ['D01', 'C01']).slice(0, 4).map((d) => `${d} 现在怎么样`);
    } else if (kind === 'product') {
      ask = '问的是哪类货？可以说商品族（比如冷藏、冻品）。';
      options = FAMILIES.slice(0, 4).map((f) => `${f.label.replace(/（.*）/, '')}还剩多少`);
    } else {
      const boxes = (ctx.containers?.() ?? []).map((b) => b.id);
      const own = (ctx.hubs?.() ?? []).flatMap((d) => d.flows.filter((f) => f.own && f.unit === '箱').map((f) => f.id));
      ask = '问的是哪个集装箱？可以说箱号；不知道箱号可以问「本店的箱在哪」。';
      options = [...new Set([...boxes, ...own])].slice(0, 3).map((id) => `${id} 到哪了`).concat('本店的箱在哪');
    }
    const r: ToolResult = { tool: 'clarify', args: {}, data: { options }, text: ask, cite: '值班助手', clarify: { question: ask, options } };
    this.lastIntent = kind === 'door' ? 'doors' : kind === 'product' ? 'stock' : /(清关|报关|海关|关税)/.test(question) ? 'crossborder' : 'cargo';
    return this.answer(question, ctx, this.lastIntent, 0.9, [r], e);
  }

  /** 推演没说是什么：问一句（车、门、路、建议卡） */
  private whichTarget(ctx: AssistCtx): ToolResult {
    const cands = ctx.rows.filter((r) => r.status === 'moving' || r.status === 'working').sort((a, b) => (b.delayMin ?? 0) - (a.delayMin ?? 0) || a.id.localeCompare(b.id)).slice(0, 3).map((r) => `如果 ${r.id} 晚 30 分钟会怎样`);
    const ask = '想推演什么？说一下是哪趟车（或哪个门、哪段路、哪张建议卡），比如「M05 晚 1 小时」「C05 停用 2 小时」「港口晚 3 小时放柜」。';
    return { tool: 'clarify', args: {}, data: {}, text: ask, cite: '值班助手', clarify: { question: ask, options: [...cands, '如果第一条不处理会怎样'] } };
  }

  /** 按意图调工具 */
  private route(intent: Intent, q: string, e: Entities, ctx: AssistCtx): ToolResult[] {
    const run = (name: string, args: Record<string, unknown> = {}) => tool(name).run(ctx, args, this.mem);
    switch (intent) {
      case 'overview':
        return [run('get_overview')];
      case 'risks':
        return [run('list_risks')];
      case 'vehicle': {
        if (e.ambiguous.length) return [this.whichVehicle(ctx, e, '在哪')];
        if (!e.vehicles.length) {
          // 像编号、但不是车：可能是仓储中心里的箱、板（OWN-ULD-1 在哪）
          const u = e.unknown[0];
          if (u && ctx.hubs?.().some((d) => d.flows.some((f) => f.id.toUpperCase() === u.toUpperCase()))) return [run('trace_own_cargo', { id: u })];
          if (u) return [run('get_vehicle', { vid: -1, id: u })];
          if (/(这辆|那辆|它|该车|^车|这车|那车|这台|那台)/.test(q) && !/(哪些|几辆|哪几|哪辆)/.test(q)) return [this.whichVehicle(ctx, e, '在哪')];
          return [run('list_late')];
        }
        return e.vehicles.slice(0, 3).map((v) => run('get_vehicle', { vid: v.vid, id: v.id }));
      }
      case 'late':
        return [run('list_late')];
      case 'stock':
        return [run('get_stock', { fams: e.fams })];
      case 'doors':
        if (e.doors[0]) this.mem.doors = [e.doors[0]];
        return [run('get_doors', e.doors[0] ? { door: e.doors[0] } : {})];
      case 'port': {
        const ship = this.ship(ctx, e);
        return [run('get_facility', { facility: 'port' }), ...(ship ? [run('get_vehicle', { vid: ship.vid, id: ship.id })] : [])];
      }
      case 'airport':
        return [run('get_facility', { facility: 'airport' })];
      case 'dc':
        return [run('get_facility', { facility: 'dc' })];
      case 'store':
        return [run('get_facility', { facility: 'store' })];
      case 'cards': {
        const list = run('list_cards');
        // 「第二张是啥内容」：列完再讲那一张（之后「这个」「它」就是它）
        const r = e.card?.index !== undefined ? this.card(ctx, e, true) : undefined;
        return r ? [list, run('explain_card', { key: r.key })] : [list];
      }
      case 'kpi':
        return [run('get_kpi')];
      case 'incidents':
        return [run('list_incidents')];
      case 'schedule':
        return [run('get_schedule', e.time?.from !== undefined ? { from: e.time.from, to: e.time.to } : e.time?.at !== undefined ? { from: e.time.at, to: e.time.at + 2 * 3600 } : {})];
      case 'handover':
        return [run('shift_handover', { ...(/凌晨/.test(q) ? { shift: 'dawn' } : /早班/.test(q) ? { shift: 'day' } : /中班/.test(q) ? { shift: 'mid' } : /夜班/.test(q) ? { shift: 'night' } : {}) })];
      case 'review':
        return [run('review_recommendations')];
      case 'network': {
        const m = /(\d+|[一二两三四五六七八九十]+)\s*家店/.exec(q);
        return [run('plan_network', m ? { stores: cnNumber(m[1] as string) } : {})];
      }
      case 'crossborder':
        return [run('get_crossborder')];
      case 'optimize':
        return [run('optimize_dispatch', { what: /(门)/.test(q) && !/(车)/.test(q) ? 'doors' : /(车)/.test(q) && !/(门)/.test(q) ? 'fleet' : 'both' })];
      case 'forecast':
        return [run('get_forecast', { fams: e.fams, tomorrow: !/今天/.test(q), delays: !e.fams.length })];
      case 'knowledge':
        return [run('search_knowledge', { query: q })];
      case 'help':
        return [run('help')];
      case 'rootcause': {
        if (e.ambiguous.length || (!e.vehicles.length && /(它|那辆|这辆|该车)/.test(q))) return [this.whichVehicle(ctx, e, '为什么晚')];
        if (e.vehicles.length) return e.vehicles.slice(0, 2).map((v) => run('explain_delay', { vid: v.vid, id: v.id }));
        if (e.unknown.length) return [run('get_vehicle', { vid: -1, id: e.unknown[0] })];
        return [run('explain_delay', {})];
      }
      case 'anomaly':
        return [run('detect_anomalies', e.hub && HUB_WORDS.test(q) ? { hub: e.hub } : {})];
      case 'hub':
        return [run('get_hub', e.hub ? { hub: e.hub } : {})];
      case 'cargo': {
        const id = e.ops[0] ?? e.unknown[0];
        return [run('trace_own_cargo', id ? { id } : {})];
      }
      case 'bottleneck':
        return [run('hub_bottlenecks', e.hub && HUB_WORDS.test(q) ? { hub: e.hub } : e.hub && /(港口|机场|物流园|门店)/.test(q) ? { hub: e.hub } : {})];
      case 'appointments':
        return [run('plan_appointments', e.hub ? { hub: e.hub } : {})];
      case 'dailyplan':
        return [run('daily_plan')];
      case 'quality':
        return [run('get_data_quality')];
      case 'policy':
        return [run('get_policy')];
      case 'decline':
        return [run('help')];
      case 'approve':
      case 'reject': {
        const pend = pendingCards(ctx);
        if (e.all || e.lowRisk) {
          const pick = e.lowRisk ? pend.filter((r) => r.options[r.best]?.auto) : pend;
          // 没有能批的：不顺带给出别的卡的提议（问的是低风险的，就不把要花钱的塞进来）
          if (!pick.length) return [{ ...run('list_cards'), text: e.lowRisk && pend.length ? `现在没有低风险的待处理建议；还有 ${pend.length} 张要花钱或改计划的，要逐条看推演结果再确认（问「有什么待处理的建议」）。` : e.lowRisk ? '现在没有低风险的待处理建议。' : '现在没有待处理的建议。', proposals: [] }];
          // 数据较差时不批量：逐条列出，核实一条确认一条
          if (dataQuality(ctx).level === 'poor' && pick.length > 1) {
            const each = pick.slice(0, HARD.maxBatch).map((r) => run('propose_decision', { keys: [r.key], action: intent }));
            const first = each[0] as ToolResult;
            return [{ ...first, args: { keys: pick.map((r) => r.key), action: intent }, text: `数据通道较差，不批量${intent === 'approve' ? '执行' : '否决'}：下面逐条列出，核实一条确认一条。\n${each.map((x) => x.text).join('\n')}`, proposals: each.flatMap((x) => x.proposals ?? []) }];
          }
          return [run('propose_decision', { keys: pick.map((r) => r.key), action: intent })];
        }
        const r = this.card(ctx, e);
        if (!r) return [this.which(ctx, intent === 'approve' ? '要批准哪一张？' : '要否决哪一张？', intent === 'approve' ? (n) => `批准第${n}条` : (n) => `否决第${n}条`)];
        return [run('propose_decision', { keys: [r.key], action: intent, ...(e.option && intent === 'approve' ? { option: e.option } : {}) })];
      }
      case 'explain': {
        const r = this.card(ctx, e, true);
        if (!r) return [this.which(ctx, '想问哪一张建议的理由？', (n) => `为什么推荐第${n}条`)];
        return [run('explain_card', { key: r.key })];
      }
      case 'whatif': {
        if (/(没有孪生|不用孪生|没孪生)/.test(q)) return [run('what_if', {})];
        // 临时扰动（某趟车晚、某个门停用、封路、班轮晚）：现场模型推演，和照常比
        const d = parseDisruption(q, e, ctx);
        if (d) return [run('what_if', { disruption: d })];
        const named = e.card !== undefined || /(建议|推荐|做法)/.test(q);
        const r = this.card(ctx, e, true);
        if (!r && !named && /(晚|延误|推迟|停用|关|封|坏|堵|误点)/.test(q)) return [this.whichTarget(ctx)];
        if (!r) return [this.which(ctx, '想推演哪一张建议？', (n) => `如果第${n}条不处理会怎样`)];
        const option = e.option ?? (/(否决|不处理|什么都不做|不管)/.test(q) ? 'accept' : undefined);
        return [run('what_if', { key: r.key, ...(option ? { option } : {}) })];
      }
    }
  }

  /** 问题说的是哪张建议卡：第几条、这条、问题里的车或商品族、只有一张待处理的时候就是它 */
  private card(ctx: AssistCtx, e: Entities, includeHandled = false): Rec | undefined {
    const r = this.findCard(ctx, e, includeHandled);
    if (r) this.mem.focusCard = r.key;
    return r;
  }

  private findCard(ctx: AssistCtx, e: Entities, includeHandled: boolean): Rec | undefined {
    const all = (ctx.twin?.recs ?? []).filter((r) => r.t <= ctx.t);
    const pend = pendingCards(ctx);
    const pool = includeHandled ? all : pend;
    const byKey = (k: string | undefined) => (k ? pool.find((r) => r.key === k) : undefined);
    // 「第几条」按最近列出来的顺序；那一条已经处理过了就不能拿别的卡顶上（返回空，让人重新选）
    if (e.card?.index !== undefined) return this.mem.cards[e.card.index] !== undefined ? byKey(this.mem.cards[e.card.index]) : pend[e.card.index];
    // 「这条 / 那张 / 它」：最近单独说到的那张；刚列过、还没单独说哪张的，是列表里排第一的那张
    if (e.card?.ref === 'this') return byKey(this.mem.focusCard) ?? byKey(this.mem.cards[0]) ?? (pend.length === 1 ? pend[0] : undefined);
    if (e.card?.ref === 'prev') {
      const i = this.mem.focusCard ? this.mem.cards.indexOf(this.mem.focusCard) : -1;
      return i > 0 ? byKey(this.mem.cards[i - 1]) : undefined;
    }
    const vids = new Set(e.vehicles.map((v) => v.vid));
    const hit = pool.filter((r) => (r.vid !== undefined && vids.has(r.vid)) || (r.kind === 'stockout' && e.fams.includes(r.key.split(':')[1] as string)));
    if (hit.length) return hit.find((r) => statusAt(r, ctx.t) === 'proposed') ?? hit[hit.length - 1];
    if (this.mem.cards.length === 1) return byKey(this.mem.cards[0]);
    if (pend.length === 1) return pend[0];
    return undefined;
  }

  /** 不知道是哪张卡：列出待处理的，问是第几条（选项是按钮） */
  private which(ctx: AssistCtx, ask: string, phrase: (n: number) => string): ToolResult {
    const list = tool('list_cards').run(ctx, {}, this.mem);
    const pend = pendingCards(ctx);
    if (!pend.length) return list;
    return { ...list, text: `${ask}\n${list.text}`, clarify: { question: ask, options: pend.slice(0, 4).map((_, i) => phrase(i + 1)) }, followups: [phrase(1)] };
  }

  /** 不知道是哪辆车（编号对上好几辆，或者说「那辆车」又没提过）：问一句，列几辆最可能的 */
  private whichVehicle(ctx: AssistCtx, e: Entities, what: string): ToolResult {
    const cands = e.ambiguous.length
      ? e.ambiguous.slice(0, 4)
      : ctx.rows
          .filter((r) => r.status === 'moving' || r.status === 'working')
          .sort((a, b) => (b.delayMin ?? 0) - (a.delayMin ?? 0))
          .slice(0, 4)
          .map((r) => r.id);
    const ask = e.ambiguous.length ? `「${e.ambiguous.join('」「')}」对得上好几辆，问的是哪一辆？` : '问的是哪辆车？可以说作业编号或车名。';
    return { tool: 'clarify', args: {}, data: { candidates: e.ambiguous.length ? e.ambiguous : cands }, text: ask, cite: '值班助手', clarify: { question: ask, options: cands.map((id) => `${id} ${what}`) } };
  }

  /** 超出范围：说明能做什么 */
  private decline(q: string, ctx: AssistCtx, e: Entities, action: boolean): Answer {
    const head = action ? '这个我做不了：值班助手只读调度台、闭环孪生、仓储中心和资料库的数据，回答问题、给出提议；打电话、发消息、订票、付款这类动作要在对应的系统里做（确认执行的提议会记进操作记录，可以照着通知）。' : '这个超出了值班助手的范围：我只回答供应链运营的问题（车、货、门、库存、仓储中心、建议卡、计划和预测），数字都来自系统的数据。';
    const h = tool('help').run(ctx, {}, this.mem);
    return this.answer(q, ctx, 'decline', 1, [{ ...h, tool: 'help', text: `${head}\n${h.text}`, conclusion: action ? '这个动作值班助手做不了。' : '这个问题超出了值班助手的范围。' }], e, { declined: true });
  }

  private answer(q: string, ctx: AssistCtx, intent: string, confidence: number, results: ToolResult[], e?: Entities, flags: { refused?: boolean; declined?: boolean; claim?: boolean } = {}): Answer {
    const seen = new Set<string>();
    // 提议先按规则表检查：违反硬性规定的拿掉，说明为什么
    const raw = results.flatMap((r) => r.proposals ?? []);
    const { kept, blocked } = applyPolicy(raw, ctx);
    let text = results.map((r) => r.text).join('\n\n');
    if (e?.fuzzy.length) text = `（按 ${e.fuzzy.join('、')} 理解）\n${text}`;
    if (flags.refused) text = `${REFUSAL}${flags.claim ? `\n${claimText(ROLE_LABEL[ctx.role ?? 'dispatcher'])}` : ''}\n\n${text}`;
    if (blocked.length) text += `\n\n下面${blocked.length > 1 ? '几条' : '这条'}做法按规则表不提议：\n${blocked.map((b) => `- ${b.title}：${b.why}`).join('\n')}`;
    const role = ctx.role ?? 'dispatcher';
    if (role === 'viewer' && kept.length) text += `\n\n你现在是只读角色：可以看提议和推演结果，不能执行；要${ROLE_LABEL[kept[0]?.need ?? 'dispatcher']}确认。`;

    const dq = dataQuality(ctx);
    const tools = results.map((r) => r.tool);
    const live = tools.some(usesLiveData);
    const data = live ? dq.factor : 1;
    const mf = modelFactor(ctx, tools);
    const value = confidence * data * mf.factor;
    const notes: string[] = [];
    if (confidence < 0.6 && !flags.declined) notes.push(`这个问法我拿得不太准（按「${INTENT_LABEL[intent] ?? intent}」回答，把握 ${Math.round(confidence * 100)}%），不对可以换个说法`);
    if (live && dq.level !== 'good') notes.push(dq.text);
    if (mf.note) notes.push(mf.note);

    const clarify = results.find((r) => r.clarify)?.clarify;
    const followups = [...new Set(results.flatMap((r) => r.followups ?? []))].slice(0, 4);
    const next: NextStep[] = [];
    if (clarify) next.push({ text: clarify.question });
    for (const p of kept) next.push({ text: `${p.manualOnly ? '核实后' : ''}确认「${p.title}」`, who: needText(p, role), proposal: p.id });
    if (!kept.length && !clarify && followups[0]) next.push({ text: `可以接着问：「${followups[0]}」` });

    // 数字核对：工具的结构化结果、参数、提议、链接，加上问题本身、此刻的时刻，用到规则表时加上规则表
    const evidence = collectEvidence(
      [...results.map((r) => r.data), ...results.map((r) => r.args), ...raw.map((p) => ({ title: p.title, effect: p.effect, cost: p.cost })), ...results.flatMap((r) => r.links ?? []), ...(e?.vehicles ?? []).map((v) => v.id)],
      [q, clock(ctx.t), ...(flags.refused || blocked.length || kept.some((p) => p.checks?.length) ? RULES.map((r) => r.text) : []), ...blocked.map((b) => b.why), ...(e?.fuzzy ?? [])],
    );
    const grounding = checkGrounding(text, evidence);
    const firstLine = text.split('\n').map((l) => l.replace(/^-\s*/, '').trim()).find((l) => l && !l.startsWith('（按 ')) ?? '';
    const conclusion = flags.refused ? '执行一律要人确认：不能跳过确认和审批。' : (results.find((r) => r.conclusion)?.conclusion ?? firstLine);
    return {
      q,
      intent,
      confidence,
      text,
      cites: [...new Set(results.map((r) => r.cite))],
      links: results.flatMap((r) => r.links ?? []).filter((l) => {
        const k = JSON.stringify(l);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }),
      proposals: kept,
      followups,
      tools: results.map((r) => ({ name: r.tool, args: r.args })),
      conclusion,
      basis: { tools: results.map((r) => ({ name: r.tool, cite: r.cite })), asOf: ctx.t, quality: { level: dq.level, label: dq.label, text: dq.text } },
      certainty: { value, level: certaintyLevel(value), intent: confidence, data, model: mf.factor, notes },
      next,
      ...(clarify ? { clarify } : {}),
      ...(flags.declined ? { declined: true } : {}),
      ...(flags.refused ? { refused: true } : {}),
      entities: { vehicles: (e?.vehicles ?? []).map((v) => v.id || ctx.rows.find((r) => r.vid === v.vid)?.id || String(v.vid)), fams: e?.fams ?? [], doors: e?.doors ?? [], ...(e?.hub ? { hub: e.hub } : {}), ...(e?.card?.index !== undefined ? { card: e.card.index } : {}), ...(e?.fuzzy.length ? { fuzzy: e.fuzzy } : {}) },
      grounding,
      data: results.map((r) => r.data),
    };
  }
}

/** 下一步写清楚谁来确认 */
function needText(p: Proposal, role: string): string {
  const need = p.need ?? 'dispatcher';
  if (role === 'viewer') return `要${ROLE_LABEL[need]}确认（只读角色不能执行）`;
  if (need === role) return `${ROLE_LABEL[need]}可以直接确认${p.manualOnly ? '（数据较差，逐条核实）' : ''}`;
  return `确认后提交${ROLE_LABEL[need]}审批`;
}

/** 全角字母数字转半角、去掉多余的空白和句末的标点 */
export function normalize(s: string): string {
  return s
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, ' ')
    .replace(/[?？!！。.]+$/, '')
    .trim();
}

export { watchList, pendingCards, statusAt } from './brief';
export { handover, reportShift, SHIFTS, shiftAt } from './handover';
export { review } from './review';
export { TOOLS } from './tools';
export { dailyPlan } from './dailyPlan';
export { RULES, HARD, policySummary } from './policy';
export type { Answer, AssistCtx } from './types';
