/// <reference lib="webworker" />
import { buildPlanogram } from '@storewright/algorithms';
import { formatCustomerName, keyedUniform, type AnyDomainEvent, type DomainEvent } from '@storewright/domain';
import { StoreModel } from '@storewright/store-config';
import { generateCatalog, generateOrders } from '@storewright/synth';
import { BASELINE, DEFAULT_AUTO_SERVICE, DEFAULT_INBOUND, defaultInboundVolume, DEFAULT_SMALL_INCIDENTS, DEFAULT_TRAFFIC, DISRUPTION_LABEL, EFFICIENCY, OPTIMIZED, ROLES, defaultScenario, estimateRestockCases, printerJam, randomDisruptions, ShelfStock, simulateAutoService, simulateDay, simulateInbound, simulatePharmacy, WEEKDAY_FACTORS, type Disruption, type Policy, type Role } from '@storewright/sim-engine';
import { simWeather, weatherPlan } from './weatherPlan';
import { applyLang, ensureLang, t, translate, trRecord } from '../i18n';
import type { AutoServiceTimeline, CarInfo, DayDigest, Notification, OrderInfo, PolicyDigest, Series, ShelfEventInfo, ShelfTimeline, SimRequest, SimResponse, Timeline, WorkerRequest } from './protocol';

const POLICIES: Record<SimRequest['policy'], Policy> = { baseline: BASELINE, optimized: OPTIMIZED, efficiency: EFFICIENCY };
const ZONES_CN: Record<string, string> = trRecord({ AMBIENT: '常温', CHILLED: '冷藏', FROZEN: '冷冻' });

function of<K extends AnyDomainEvent['type']>(events: AnyDomainEvent[], type: K): Array<DomainEvent<K>> {
  return events.filter((e) => e.type === type) as Array<DomainEvent<K>>;
}

function buildTimeline(req: SimRequest): Timeline {
  applyLang(req.lang ?? 'zh', false);
  const t0 = performance.now();
  const model = new StoreModel(req.config);
  const catalog = generateCatalog(model, { seed: 7 });
  const scenario = defaultScenario(req.demandTemplate);
  if (req.staffing) scenario.staffing = req.staffing;
  // 货架存量模型开启时，后仓补取岗位在营业时间内每小时多 1 人（白天补货员），补货任务才不会一直积压
  if (req.shelfStock) {
    const openH = Math.floor(req.config.hours.openMin / 60);
    const closeH = Math.ceil(req.config.hours.closeMin / 60);
    scenario.staffing = { ...scenario.staffing, exception: scenario.staffing.exception.map((n, h) => (h >= openH && h < closeH ? n + 1 : n)) };
  }
  // 天气（假设）：雨雪天线上订单增加、路上更慢；雾天只影响路况。「多变」时按一天的天气计划逐时段计算
  const W = { clear: [1, 1], cloudy: [1, 1], rain: [1.08, 1.3], snow: [1.15, 1.8], fog: [1, 1.2], dynamic: [1, 1] } as const;
  const dyn = req.weather === 'dynamic' ? simWeather(weatherPlan(req.weatherSeed ?? 1, req.season ?? 'autumn'), req.config.hours.openMin * 60, req.config.hours.closeMin * 60) : undefined;
  const [demandK, trafficK] = dyn ? [dyn.demandK, 1] : W[req.weather ?? 'clear'];
  scenario.demand = { ...scenario.demand, ordersPerDay: Math.round((req.ordersPerDay ?? scenario.demand.ordersPerDay) * req.demandFactor * demandK) };
  scenario.traffic = { ...DEFAULT_TRAFFIC, level: req.traffic * trafficK, profile: DEFAULT_TRAFFIC.profile.map((p, h) => p * (dyn?.trafficByHour[h] ?? 1)) };
  // 突发状况：手动触发的 + 随机大事件 + 打印机卡纸（随小状况一起开启）
  const inc = req.incidents;
  const weatherSlow: Disruption[] = dyn
    ? dyn.windows.map((w, i) => ({ id: `WEATHER-${i + 1}`, kind: w.kind === 'rain' ? ('WEATHER_RAIN' as const) : ('WEATHER_SNOW' as const), start: w.start, end: w.end }))
    : req.weather === 'rain' || req.weather === 'snow'
      ? [{ id: 'WEATHER', kind: req.weather === 'rain' ? 'WEATHER_RAIN' : 'WEATHER_SNOW', start: 0, end: 48 * 3600 }]
      : [];
  if ((inc && (inc.small || inc.randomLarge || inc.manual.length)) || weatherSlow.length) {
    const open = req.config.hours.openMin * 60;
    const close = req.config.hours.closeMin * 60;
    const disruptions: Disruption[] = [...(inc?.manual ?? []), ...(inc?.randomLarge ? randomDisruptions(req.seed, open, close) : []), ...(inc?.small ? printerJam(req.seed, open, close) : [])].sort((a, b) => a.start - b.start);
    scenario.incidents = { small: inc?.small ? DEFAULT_SMALL_INCIDENTS : null, disruptions: [...disruptions, ...weatherSlow] };
  }
  const orders = generateOrders(model, catalog, scenario.demand, { seed: req.seed });
  // 货架存量模型（Phase 4）：后仓按「后仓有货概率」放 1–2 箱；夜班补货关闭时开门填充率偏低
  // 货架容量按「店内销售 + 线上订单」的总需求配置；店内销售只占其中一部分
  const onlineUnits = orders.reduce((n, o) => n + o.lines.reduce((m, l) => m + l.qty, 0), 0);
  const inStoreUnits = catalog.byId.size * 3;
  const planogram = req.shelfStock ? buildPlanogram(model, catalog.byId, { dailyUnits: inStoreUnits + onlineUnits }) : [];
  const shelf = req.shelfStock
    ? new ShelfStock({
        planogram,
        open: req.config.hours.openMin * 60,
        close: req.config.hours.closeMin * 60,
        seed: req.seed * 17 + 3,
        backroom: new Map(
          planogram.map((p) => {
            const u = keyedUniform(req.seed, 'backroom-cases', p.itemId);
            const it = catalog.byId.get(p.itemId);
            return [p.itemId, it && u < it.backroomAvailability * 0.7 ? p.packQty * (u < it.backroomAvailability * 0.35 ? 2 : 1) : 0];
          }),
        ),
        openFill: req.nightCrew?.enabled === false ? 0.7 : 0.85,
        demandScale: inStoreUnits / Math.max(1, inStoreUnits + onlineUnits),
        requests: req.restockRequests ?? [],
      })
    : undefined;
  const base = POLICIES[req.policy];
  const policy = req.ai ? { ...base, ai: { staffing: true, eta: true, substitution: true } } : base;
  const res = simulateDay({ model, items: catalog.byId, orders, scenario, policy, seed: req.seed * 31, retainEvents: true, trace: true, ...(shelf ? { shelf } : {}) });
  const trace = res.trace;
  if (!trace) throw new Error('仿真没有返回轨迹');
  const events = res.events;
  const nameMax = req.config.rules.labels.nameMaxLength;

  // 订单信息
  const totesByOrder = new Map<string, number>();
  for (const e of of(events, 'ToteAssignmentsCreated')) totesByOrder.set(e.payload.orderId, e.payload.toteIds.length + e.payload.oversizedPieces);
  const stagedAt = new Map<string, DomainEvent<'OrderStaged'>>();
  for (const e of of(events, 'OrderStaged')) stagedAt.set(e.payload.orderId, e);
  const orderInfo: Record<string, OrderInfo> = {};
  for (const o of orders) {
    const st = stagedAt.get(o.id);
    const info: OrderInfo = {
      id: o.id,
      shortCode: o.shortCode,
      name: formatCustomerName(o.customer.firstName, o.customer.lastName, nameMax),
      type: o.type,
      fulfillment: o.fulfillmentType,
      lines: o.lines.length,
      units: o.lines.reduce((n, l) => n + l.qty, 0),
      totes: totesByOrder.get(o.id) ?? 0,
      slotStart: o.slotStart,
    };
    if (st) {
      info.stagedAt = st.t;
      if (st.payload.lateBySec > 0) info.lateMin = Math.round(st.payload.lateBySec / 60);
    }
    orderInfo[o.id] = info;
  }

  // 车辆与停车位：按到达顺序分配最小的空闲车位
  const sessions = trace.sessions.filter((s) => s.arrivedAt !== undefined).sort((a, b) => (a.arrivedAt as number) - (b.arrivedAt as number) || a.id.localeCompare(b.id));
  const busyUntil: number[] = [];
  const cars: CarInfo[] = sessions.map((s) => {
    const arriveAt = s.arrivedAt as number;
    const doneAt = s.doneAt ?? trace.end;
    let spot = busyUntil.findIndex((u) => u + 30 <= arriveAt);
    if (spot < 0) {
      spot = busyUntil.length;
      busyUntil.push(0);
    }
    busyUntil[spot] = doneAt;
    const first = orderInfo[s.orderIds[0] as string];
    const label = s.kind === 'TRIP' ? t('行程 · {0} 单', s.orderIds.length) : `${first?.name ?? ''} #${first?.shortCode ?? ''}`;
    const car: CarInfo = { id: s.id, kind: s.kind, orderIds: s.orderIds, label, arriveAt, doneAt, spot };
    if (s.approachAt !== undefined) car.approachAt = s.approachAt;
    if (s.trafficDelaySec) car.delaySec = s.trafficDelaySec;
    return car;
  });

  // 夜班补货：按当天各通道的拣货量估算销售分布，关门后开工、次日开门前收工
  const runWeights: Record<string, number> = {};
  for (const e of of(events, 'ItemPicked')) {
    const item = catalog.byId.get(e.payload.itemId);
    const loc = item ? model.locations.get(item.locationIds[0] as string) : undefined;
    if (loc) runWeights[loc.runId] = (runWeights[loc.runId] ?? 0) + e.payload.qty;
  }
  const hours = req.config.hours;
  // 到货、收货、上架与夜班补货（后仓库存仓库）
  const scaleK = Math.max(0.3, (req.ordersPerDay ?? scenario.demand.ordersPerDay / Math.max(0.01, req.demandFactor)) / 260);
  const nightCrewN = req.nightCrew?.enabled ? req.nightCrew.crew : 0;
  const inbound = simulateInbound(
    model,
    runWeights,
    {
      ...DEFAULT_INBOUND,
      ...defaultInboundVolume(scaleK),
      open: hours.openMin * 60,
      close: hours.closeMin * 60,
      nextOpen: (hours.openMin + 24 * 60) * 60,
      nightCrew: nightCrewN,
      totalCases: estimateRestockCases(res.metrics.units),
    },
    req.seed,
  );
  const timelineEnd = Math.max(trace.end, (hours.openMin + 24 * 60) * 60);

  // 按分钟采样的时间序列
  const step = 60;
  const start = trace.start;
  const n = Math.ceil((timelineEnd - start) / step) + 1;
  const idx = (t: number) => Math.min(n - 1, Math.max(0, Math.floor((t - start) / step)));
  const zeros = () => new Array<number>(n).fill(0);
  const cumulate = (a: number[]) => {
    for (let i = 1; i < a.length; i++) a[i] = (a[i] as number) + (a[i - 1] as number);
    return a;
  };
  const diffToLevel = (a: number[]) => cumulate(a);

  const handedOff = zeros();
  const waitSum = zeros();
  for (const e of of(events, 'OrderHandedOff')) {
    const i = idx(e.t);
    handedOff[i] = (handedOff[i] as number) + 1;
    waitSum[i] = (waitSum[i] as number) + e.payload.waitSec;
  }
  cumulate(handedOff);
  cumulate(waitSum);
  const avgWaitMin = handedOff.map((c, i) => (c > 0 ? (waitSum[i] as number) / c / 60 : 0));

  const waiting = zeros();
  for (const c of cars) {
    waiting[idx(c.arriveAt)] = (waiting[idx(c.arriveAt)] as number) + 1;
    waiting[idx(c.doneAt)] = (waiting[idx(c.doneAt)] as number) - 1;
  }
  diffToLevel(waiting);

  const late = zeros();
  for (const e of stagedAt.values()) if (e.payload.lateBySec > 0) late[idx(e.t)] = (late[idx(e.t)] as number) + 1;
  cumulate(late);

  const picked = zeros();
  for (const e of of(events, 'ItemPicked')) picked[idx(e.t)] = (picked[idx(e.t)] as number) + e.payload.qty;
  for (const e of of(events, 'OversizedPicked')) picked[idx(e.t)] = (picked[idx(e.t)] as number) + 1;
  cumulate(picked);

  const busy = {} as Record<Role, number[]>;
  const onShift = {} as Record<Role, number[]>;
  for (const r of ROLES) {
    busy[r] = zeros();
    onShift[r] = zeros();
  }
  for (const a of trace.associates) {
    for (const [on, off] of a.shifts) {
      onShift[a.role][idx(on)] = (onShift[a.role][idx(on)] as number) + 1;
      onShift[a.role][idx(off)] = (onShift[a.role][idx(off)] as number) - 1;
    }
    // 合并首尾相接的片段为忙碌区间
    let curStart: number | undefined;
    let curEnd = 0;
    const flush = () => {
      if (curStart === undefined) return;
      busy[a.role][idx(curStart)] = (busy[a.role][idx(curStart)] as number) + 1;
      busy[a.role][idx(curEnd)] = (busy[a.role][idx(curEnd)] as number) - 1;
    };
    for (const s of a.segments) {
      if (curStart !== undefined && s.t0 <= curEnd + 1) curEnd = Math.max(curEnd, s.t1);
      else {
        flush();
        curStart = s.t0;
        curEnd = s.t1;
      }
    }
    flush();
  }
  for (const r of ROLES) {
    diffToLevel(busy[r]);
    diffToLevel(onShift[r]);
  }

  const slotZone = new Map(model.stagingSlots.map((s) => [s.code, s.tempZone]));
  const capacity: Record<'AMBIENT' | 'CHILLED' | 'FROZEN', number> = { AMBIENT: 0, CHILLED: 0, FROZEN: 0 };
  for (const s of model.stagingSlots) if (s.purpose !== 'RECOVERY' && s.tempZone in capacity) capacity[s.tempZone as keyof typeof capacity] += s.capacityTotes;
  const occCount: Record<'AMBIENT' | 'CHILLED' | 'FROZEN', number[]> = { AMBIENT: zeros(), CHILLED: zeros(), FROZEN: zeros() };
  for (const c of trace.staging) {
    const z = slotZone.get(c.slotCode) ?? 'AMBIENT';
    if (!(z in occCount)) continue;
    const arr = occCount[z as keyof typeof occCount];
    arr[idx(c.t)] = (arr[idx(c.t)] as number) + c.delta;
  }
  const stagingOcc = {} as Series['stagingOcc'];
  for (const z of ['AMBIENT', 'CHILLED', 'FROZEN'] as const) stagingOcc[z] = diffToLevel(occCount[z]).map((v) => (capacity[z] ? v / capacity[z] : 0));

  // 事件提醒（模拟经营式通知）
  const notifications: Notification[] = [];
  const longWait = req.config.rules.handoff.longWaitMin * 60;
  for (const c of cars) {
    if (c.doneAt - c.arriveAt >= longWait) notifications.push({ t: c.arriveAt + longWait, level: 'warn', text: t('{0} 等待已超过 {1} 分钟', c.label, req.config.rules.handoff.longWaitMin), target: { type: 'car', id: c.id } });
  }
  for (const e of stagedAt.values()) {
    if (e.payload.lateBySec >= 60) {
      const o = orderInfo[e.payload.orderId];
      notifications.push({ t: e.t, level: 'warn', text: t('订单 #{0} 晚 {1} 分钟就绪', o?.shortCode ?? '', Math.round(e.payload.lateBySec / 60)), target: { type: 'staging', id: 'AMBIENT' } });
    }
  }
  for (const e of of(events, 'ColdChainAlert')) {
    notifications.push({ t: e.t, level: 'alert', text: t('冷链批次用时 {0} 分钟，超过时限 {1} 分钟', Math.round(e.payload.elapsedSec / 60), Math.round(e.payload.limitSec / 60)) });
  }
  const itemName = (id: string) => catalog.byId.get(id)?.name ?? id;
  const exceptionItem = new Map(of(events, 'ExceptionCreated').map((e) => [e.payload.exceptionId, e.payload.itemId]));
  for (const e of of(events, 'ExceptionResolved')) {
    const item = itemName(exceptionItem.get(e.payload.exceptionId) ?? '');
    notifications.push(
      e.payload.found
        ? { t: e.t, level: 'info', text: t('后仓补取成功：{0}（已生成补货任务）', item) }
        : { t: e.t, level: 'info', text: t('后仓未找到：{0}（库存记录可能不准）', item) },
    );
  }
  const alertThreshold = req.config.rules.staging.occupancyAlert;
  for (const z of ['AMBIENT', 'CHILLED', 'FROZEN'] as const) {
    // 带回差的阈值提醒：超过阈值时提醒一次，回落到阈值以下 5 个百分点后才会再次提醒
    let above = false;
    stagingOcc[z].forEach((v, i) => {
      if (!above && v >= alertThreshold) {
        notifications.push({ t: start + i * step, level: 'warn', text: t('{0}暂存占用率达到 {1}%', ZONES_CN[z] ?? z, Math.round(v * 100)), target: { type: 'staging', id: z } });
        above = true;
      } else if (above && v < alertThreshold - 0.05) above = false;
    });
  }
  // 道路拥堵：进入高峰时提醒一次
  const traffic = scenario.traffic;
  if (traffic && traffic.level > 0) {
    let jam = false;
    for (let h = Math.floor(start / 3600); h * 3600 < trace.end; h++) {
      const c = (traffic.profile[h % 24] ?? 0) * traffic.level;
      if (!jam && c >= 0.7) {
        const delayed = cars.filter((x) => x.arriveAt >= h * 3600 && x.arriveAt < (h + 2) * 3600 && (x.delaySec ?? 0) > 0);
        const avg = delayed.length ? delayed.reduce((n, x) => n + (x.delaySec ?? 0), 0) / delayed.length / 60 : 0;
        notifications.push({ t: h * 3600, level: 'warn', text: t('周边道路进入高峰拥堵，接下来到店的车辆平均推迟约 {0} 分钟', Math.round(avg)) });
        jam = true;
      } else if (jam && c < 0.55) jam = false;
    }
  }
  // 汽车快修中心（与线上订单相互独立，只在门店配置了该设施时运行）
  const autoService: AutoServiceTimeline[] = req.config.facilities.flatMap((f) => (f.kind === 'AUTO_SERVICE' ? [f] : [])).map((f) => {
    const r = simulateAutoService(f, req.seed * 17 + 3, DEFAULT_AUTO_SERVICE, scenario.traffic, req.demandFactor);
    const queue = zeros();
    const inService = zeros();
    for (const j of r.jobs) {
      if (j.balked || j.start === undefined || j.end === undefined) continue;
      queue[idx(j.arrive)] = (queue[idx(j.arrive)] as number) + 1;
      queue[idx(j.start)] = (queue[idx(j.start)] as number) - 1;
      inService[idx(j.start)] = (inService[idx(j.start)] as number) + 1;
      inService[idx(j.end)] = (inService[idx(j.end)] as number) - 1;
    }
    diffToLevel(queue);
    diffToLevel(inService);
    const bays = f.oilBays + f.tireBays;
    let long = false;
    queue.forEach((v, i) => {
      if (!long && v >= Math.max(3, bays)) {
        notifications.push({ t: start + i * step, level: 'warn', text: t('汽车服务中心排队 {0} 辆车，考虑增加技师', v) });
        long = true;
      } else if (long && v <= Math.max(1, bays / 2)) long = false;
    });
    for (const j of r.jobs) if (j.balked) notifications.push({ t: j.arrive, level: 'info', text: t(j.kind === 'OIL' ? '一位换机油的顾客因排队太长离开了汽车服务中心' : '一位换轮胎的顾客因排队太长离开了汽车服务中心') });
    return { facilityId: f.id, name: f.name, oilBays: f.oilBays, tireBays: f.tireBays, jobs: r.jobs, metrics: r.metrics, queue, inService };
  });
  // 突发状况：大事件开始、结束的提醒；小状况记录
  const SMALL_TEXT: Record<string, string> = { LABEL_REPRINT: '标签丢失，重新打印并重贴', DAMAGED_ITEM: '商品破损，重新拣一件', MISSING_TOTE: '交付时找不到框，回暂存区再找' };
  const EFFECT_TEXT: Record<string, string> = { FIRE_ALARM: '全员疏散，所有作业暂停', POLICE: '停车场封闭，车边交付暂停', POWER_OUTAGE: '拣货与暂存暂停，交付变慢', SYSTEM_OUTAGE: '订单暂停下发，改为手工记录', PRINTER_JAM: '暂存贴标变慢' };
  const disruptions = (scenario.incidents?.disruptions ?? []).filter((d) => !d.kind.startsWith('WEATHER'));
  for (const d of disruptions) {
    const label = translate(DISRUPTION_LABEL[d.kind]);
    notifications.push({ t: d.start, level: d.kind === 'PRINTER_JAM' ? 'warn' : 'alert', text: t('{0}：{1}（约 {2} 分钟）', label, t(EFFECT_TEXT[d.kind] ?? ''), Math.round((d.end - d.start) / 60)) });
    notifications.push({ t: d.end, level: 'info', text: t('{0}解除，恢复正常作业', label) });
  }
  const smallIncidents = of(events, 'IncidentOccurred')
    .filter((e) => e.payload.extraSec !== undefined)
    .map((e) => ({ t: e.t, kind: e.payload.kind, ref: e.payload.ref }));
  for (const e of smallIncidents) notifications.push({ t: e.t, level: 'info', text: t('小状况：{0}', t(SMALL_TEXT[e.kind] ?? e.kind)) });

  // 到货与夜班：累计上架曲线、货架占用曲线与提醒
  const nightStocked = zeros();
  for (const [t, c] of inbound.progress) nightStocked[idx(t)] = (nightStocked[idx(t)] as number) + c;
  cumulate(nightStocked);
  const rackUsed = zeros();
  for (const pl of inbound.pallets) {
    if (pl.location === undefined || pl.storedAt === undefined) continue;
    rackUsed[idx(Math.max(start, pl.storedAt))] = (rackUsed[idx(Math.max(start, pl.storedAt))] as number) + 1;
    if (pl.emptiedAt !== undefined) rackUsed[idx(pl.emptiedAt)] = (rackUsed[idx(pl.emptiedAt)] as number) - 1;
  }
  cumulate(rackUsed);
  const im = inbound.metrics;
  for (const tr of inbound.trucks) notifications.push({ t: tr.arrive, level: 'info', text: t('到货：{0}到达卸货区（{1} 托）', translate(tr.label), tr.pallets) });
  if (nightCrewN > 0) {
    notifications.push(
      im.backlogCases > 0
        ? { t: (hours.openMin + 24 * 60) * 60 - 60, level: 'alert', text: t('夜班结束时还有 {0} 箱没上架（补齐率 {1}%），开门后可能缺货', im.backlogCases, Math.round(im.readyAtOpen * 100)) }
        : { t: im.finishAt ?? (hours.openMin + 24 * 60) * 60, level: 'info', text: t('夜班补货完成：{0} 箱全部上架', im.totalCases) },
    );
  }
  const unstored = inbound.pallets.filter((pl) => pl.receivedAt !== undefined && !pl.direct && pl.storedAt === undefined).length;
  if (unstored > 0) notifications.push({ t: (hours.openMin + 24 * 60) * 60 - 120, level: 'warn', text: t('后仓货架放不下：{0} 托货仍堆在收货区，考虑加深后仓或增加货架层数', unstored) });
  // 多变天气：雨雪开始与结束
  if (dyn) {
    for (const w of dyn.windows) {
      if (w.start > start) notifications.push({ t: w.start, level: 'info', text: t(w.kind === 'rain' ? '开始下雨：车边交付变慢，路上更堵' : '开始下雪：车边交付变慢，路上明显变堵') });
      if (w.end < timelineEnd) notifications.push({ t: w.end, level: 'info', text: t(w.kind === 'rain' ? '雨停了，路面还湿' : '雪停了，路上还有积雪') });
    }
  }
  notifications.sort((a, b) => a.t - b.t);

  // 货架存量：每个货架段的填充率变化、空货架 / 补货事件与提醒
  let shelfTl: ShelfTimeline | undefined;
  if (res.shelf) {
    const r = res.shelf;
    const bays: Record<string, number[]> = {};
    for (const [b, v] of Object.entries(r.initial)) bays[b] = [start, Math.round(v.fill * 1000) / 1000, v.empty];
    for (const c of r.changes) (bays[c.bay] ??= [start, 1, 0]).push(Math.round(c.t), Math.round(c.fill * 1000) / 1000, c.empty);
    const byItem = new Map(planogram.map((p) => [p.itemId, p]));
    const bayOf = (locId: string) => {
      const loc = model.locations.get(locId);
      return loc ? `${loc.runId}|${loc.bay}` : '';
    };
    const shelfEvents: ShelfEventInfo[] = [];
    const info = (itemId: string) => byItem.get(itemId);
    for (const e of events) {
      if (e.type === 'ShelfEmpty') shelfEvents.push({ t: e.t, kind: 'EMPTY', itemId: e.payload.itemId, name: info(e.payload.itemId)?.name ?? e.payload.itemId, locationId: e.payload.locationId, bay: bayOf(e.payload.locationId) });
      else if (e.type === 'ReplenishmentTaskCreated') {
        const p = info(e.payload.itemId);
        if (p) shelfEvents.push({ t: e.t, kind: 'TASK', itemId: p.itemId, name: p.name, locationId: p.locationId, bay: bayOf(p.locationId), reason: e.payload.reason });
      } else if (e.type === 'ReplenishmentCompleted') shelfEvents.push({ t: e.t, kind: 'DONE', itemId: e.payload.itemId, name: info(e.payload.itemId)?.name ?? e.payload.itemId, locationId: e.payload.locationId, bay: bayOf(e.payload.locationId), units: e.payload.units });
    }
    const bayItems: Record<string, number> = {};
    for (const p of planogram) {
      const k = bayOf(p.locationId);
      if (k) bayItems[k] = (bayItems[k] ?? 0) + 1;
    }
    const backroomStart: Record<string, number> = {};
    for (const p of planogram) {
      const u = shelf?.backroom(p.itemId) ?? 0;
      if (u > 0) backroomStart[p.itemId] = u;
    }
    shelfTl = { bayItems, backroom: backroomStart, lostSalesUnits: r.lostSalesUnits, soldUnits: r.soldUnits, itemsEmptied: r.itemsEmptied, restocks: r.restocks, restockedUnits: r.restockedUnits, avgEmptyMin: r.avgEmptyMin, emptyAtClose: r.emptyAtClose, emptyCurve: r.emptyCurve, bays, events: shelfEvents };
    // 提醒：拣货员遇到空货架、补货完成（各最多 30 条，避免刷屏）
    let nEmpty = 0;
    let nDone = 0;
    const seenEmpty = new Set<string>();
    for (const e of shelfEvents) {
      if (e.kind === 'EMPTY' && !seenEmpty.has(e.itemId) && nEmpty < 30) {
        seenEmpty.add(e.itemId);
        nEmpty++;
        notifications.push({ t: e.t, level: 'warn', text: t('货架空了：{0}（{1}），已生成补货任务', translate(e.name), e.locationId), target: { type: 'run', id: e.bay } });
      } else if (e.kind === 'DONE' && nDone < 30) {
        nDone++;
        notifications.push({ t: e.t, level: 'info', text: t('补货完成：{0} 上架 {1} 件（{2}）', translate(e.name), e.units ?? 0, e.locationId), target: { type: 'run', id: e.bay } });
      }
    }
    notifications.sort((a, b) => a.t - b.t);
  }

  // 拣货热度
  const pickHeat: Record<string, number> = {};
  for (const e of of(events, 'ItemPicked')) {
    const item = catalog.byId.get(e.payload.itemId);
    const loc = item ? model.locations.get(item.locationIds[0] as string) : undefined;
    if (!loc) continue;
    const key = `${loc.runId}|${loc.bay}`;
    pickHeat[key] = (pickHeat[key] ?? 0) + e.payload.qty;
  }

  return {
    start,
    end: timelineEnd,
    policy: req.policy,
    seed: req.seed,
    orderCount: orders.length,
    metrics: res.metrics,
    staffing: scenario.staffing,
    associates: trace.associates,
    homeNodes: trace.homeNodes,
    cars,
    orders: orderInfo,
    staging: trace.staging,
    series: { t0: start, step, handedOff, waiting, avgWaitMin, late, picked, busy, onShift, stagingOcc, nightStocked, rackUsed },
    notifications,
    pickHeat,
    ...(shelfTl ? { shelf: shelfTl } : {}),
    traffic: { level: req.traffic, profile: [...(scenario.traffic?.profile ?? [])] },
    autoService,
    pharmacy: (() => {
      const f = req.config.facilities.find((x) => x.kind === 'PHARMACY');
      if (!f || f.kind !== 'PHARMACY') return undefined;
      const r = simulatePharmacy(f, req.seed, Math.max(0.3, (req.ordersPerDay ?? scenario.demand.ordersPerDay / req.demandFactor) / 260));
      return { counters: f.counters, visits: r.visits, metrics: r.metrics };
    })(),
    incidents: { disruptions, small: smallIncidents },
    inbound: { trucks: inbound.trucks, pallets: inbound.pallets, workers: inbound.workers, equipment: inbound.equipment, metrics: inbound.metrics, nightCrew: nightCrewN },
    simMs: performance.now() - t0,
  };
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  // 事件提醒的语言：英文字典按需加载
  await ensureLang((req.type === 'simulate' ? req.lang : req.base.lang) ?? 'zh');
  let msg: SimResponse;
  try {
    if (req.type === 'compare') {
      const results: PolicyDigest[] = (['baseline', 'optimized', 'efficiency'] as const).map((policy) => {
        const tl = buildTimeline({ ...req.base, type: 'simulate', reqId: req.reqId, policy });
        return { policy, metrics: tl.metrics, series: tl.series };
      });
      msg = { type: 'compare', reqId: req.reqId, results };
    } else if (req.type === 'multiDay') {
      const days: DayDigest[] = [];
      for (let d = 0; d < req.days; d++) {
        const weekday = d % 7;
        const seed = req.base.seed + d * 101;
        const demandFactor = req.base.demandFactor * (WEEKDAY_FACTORS[weekday] ?? 1);
        const tl = buildTimeline({ ...req.base, type: 'simulate', reqId: req.reqId, seed, demandFactor });
        days.push({
          day: d + 1,
          weekday,
          seed,
          demandFactor,
          metrics: tl.metrics,
          inbound: tl.inbound.metrics,
          autoRevenue: tl.autoService.reduce((n, a) => n + a.metrics.revenue, 0),
          pharmacyServed: tl.pharmacy?.metrics.served ?? 0,
        });
        (self as unknown as Worker).postMessage({ type: 'progress', reqId: req.reqId, done: d + 1, total: req.days } satisfies SimResponse);
      }
      msg = { type: 'multiDay', reqId: req.reqId, days };
    } else msg = { type: 'result', reqId: req.reqId, timeline: buildTimeline(req) };
  } catch (err) {
    msg = { type: 'error', reqId: req.reqId, message: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as Worker).postMessage(msg);
};
