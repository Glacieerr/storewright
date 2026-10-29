import { ROLES, type Role } from '@storewright/sim-engine';
import { useApp } from '../state/store';
import { clock, setTime, useClock } from '../state/clock';
import { MotionIndex } from '../scene/motion';
import { makePolyPose, polyPose } from '../scene/polyTrace';
import { carSpot } from '../scene/lot';
import { framePositions } from '../scene/framePositions';
import { ROLE_COLOR, ROLE_LABEL, ZONE_COLOR, ZONE_LABEL } from '../scene/palette';
import { at, clockText, num, pct } from './format';
import type { Notification, NotificationLevel } from '../sim/protocol';
import { getLang, t, translate } from '../i18n';

function BackroomWorkerView({ id }: { id: string }) {
  const tm = useClock(4);
  const timeline = useApp((s) => s.timeline);
  const w = timeline?.inbound.workers.find((x) => x.id === id);
  if (!w) return <p className="muted">{t('该员工不在本次仿真中。')}</p>;
  const pose = makePolyPose();
  const onShift = w.shifts.some(([on, off]) => tm >= on && tm < off);
  const active = onShift && polyPose(w.segments, tm, pose) ? pose.activity : undefined;
  const cases = (upTo: number) => w.segments.filter((s) => s.activity.startsWith('上架') && s.t1 <= upTo).reduce((n, s) => n + (Number(/\d+/.exec(s.activity)?.[0]) || 0), 0);
  const pallets = (upTo: number) => w.segments.filter((s) => (s.activity === '叉车卸货' || s.activity === '搬运车卸货') && s.t1 <= upTo).length;
  const night = w.role === 'night';
  return (
    <>
      <h2>
        <span className="dot" style={{ background: night ? '#2f5d8a' : '#c98b2c' }} />
        {t(night ? '夜班补货员' : '收货员')} · {w.id}
      </h2>
      <dl className="facts">
        <dt>{t('当前')}</dt>
        <dd>{!onShift ? t('不在岗') : active ? translate(active) : t('待命')}</dd>
        <dt>{t('班次')}</dt>
        <dd>{w.shifts.map(([on, off]) => `${clockText(on)}–${clockText(off)}`).join(t('，'))}</dd>
        <dt>{t('已卸托盘')}</dt>
        <dd>
          {t('{0} 托（全班 {1} 托）', pallets(tm), pallets(Infinity))}
        </dd>
        {night && (
          <>
            <dt>{t('已上架')}</dt>
            <dd>
              {t('{0} 箱（整晚 {1} 箱）', cases(tm), cases(Infinity))}
            </dd>
          </>
        )}
      </dl>
      <p className="hint">{t(night ? '夜班卸夜间半挂车、把托盘放进货架，再从收货区或货架取货推到货架通道逐箱上架；高层托盘先由叉车放到地面。' : '早班收货员用叉车和搬运车卸早上的冷藏车和供应商货车，点数贴标后放进货架。')}</p>
    </>
  );
}

function AssociateView({ id }: { id: string }) {
  const tm = useClock(4);
  const timeline = useApp((s) => s.timeline);
  const a = timeline?.associates.find((x) => x.id === id);
  if (!a && timeline?.inbound.workers.some((x) => x.id === id)) return <BackroomWorkerView id={id} />;
  if (!a) return <p className="muted">{t('该员工不在本次仿真中。')}</p>;
  const seg = MotionIndex.segmentAt(a.segments, tm);
  const onShift = a.shifts.some(([on, off]) => tm >= on && tm < off);
  const walks = new Set(a.segments.filter((s) => s.ref?.startsWith('W')).map((s) => s.ref)).size;
  const busySec = a.segments.reduce((n, s) => n + (s.t1 - s.t0), 0);
  const shiftSec = a.shifts.reduce((n, [on, off]) => n + (off - on), 0);
  return (
    <>
      <h2>
        <span className="dot" style={{ background: ROLE_COLOR[a.role] }} />
        {t('{0}员', ROLE_LABEL[a.role])} · {a.id}
      </h2>
      {a.student && <p className="hint">{t('学生兼职工：不能按全职的时长工作，只在自己的班次里在岗（上学日放学后最多 4 小时，周末和暑假最多 6 小时）。')}</p>}
      <dl className="facts">
        <dt>{t('当前')}</dt>
        <dd>{!onShift ? t('不在岗') : seg ? translate(seg.activity) : t('待命')}</dd>
        {seg?.ref && (
          <>
            <dt>{t('任务')}</dt>
            <dd className="mono">{seg.ref}</dd>
          </>
        )}
        <dt>{t('在岗')}</dt>
        <dd>{a.shifts.map(([on, off]) => `${clockText(on)}–${clockText(off)}`).join(t('，'))}</dd>
        {a.role === 'pick' && (
          <>
            <dt>{t('今日拣货批次')}</dt>
            <dd>{walks}</dd>
          </>
        )}
        <dt>{t('全天利用率')}</dt>
        <dd>{shiftSec ? pct(busySec / shiftSec) : '—'}</dd>
      </dl>
      {!a.student && <h3>{t('改派（从当前小时起）')}</h3>}
      <div className="chips">
        {(a.student ? [] : ROLES.filter((r) => r !== a.role)).map((r: Role) => (
          <button key={r} className="chip" onClick={() => useApp.getState().reassign(a.role, r)}>
            → {ROLE_LABEL[r]}
          </button>
        ))}
      </div>
      {!a.student && <p className="hint">{t('改派会把本岗位从当前小时起的排班减 1、目标岗位加 1，然后重新仿真；管理员的调整优先于系统建议。')}</p>}
    </>
  );
}

function RunView({ id }: { id: string }) {
  const config = useApp((s) => s.config);
  const timeline = useApp((s) => s.timeline);
  const run = config.layout.runs.find((r) => r.id === id);
  if (!run) return <p className="muted">{t('找不到该货架通道。')}</p>;
  const cats = run.categoryIds.map((c) => config.catalog.categories.find((x) => x.id === c) ?? c).map((c) => (typeof c === 'string' ? c : getLang() === 'en' ? c.name : c.nameZh));
  let picks = 0;
  for (const [k, v] of Object.entries(timeline?.pickHeat ?? {})) if (k.startsWith(`${id}|`)) picks += v;
  return (
    <>
      <h2>
        <span className="dot" style={{ background: ZONE_COLOR[run.tempZone] }} />
        {run.label ?? run.id}
      </h2>
      <dl className="facts">
        <dt>{t('温区')}</dt>
        <dd>{ZONE_LABEL[run.tempZone]}</dd>
        <dt>{t('商品类别')}</dt>
        <dd>{cats.join(t('、'))}</dd>
        <dt>{t('货架')}</dt>
        <dd>
          {t('{0} 段 × {1} 层 × {2}', run.bays, run.levels, t(run.sides === 2 ? '两侧' : '单侧'))}
        </dd>
        <dt>{t('今日拣货')}</dt>
        <dd>{picks} {t('件')}</dd>
      </dl>
      <RunStock runId={id} />
    </>
  );
}

const REASON_LABEL: Record<string, string> = { EXCEPTION: '后仓补取后', EMPTY: '货架空了', LOW: '库存偏低', MANUAL: '手动请求' };

/** 这条通道的货架存量：当前时刻空着的商品、进行中的补货任务；可以手动请求补货 */
function RunStock({ runId }: { runId: string }) {
  const tm = useClock(2);
  const timeline = useApp((s) => s.timeline);
  const shelfOn = useApp((s) => s.shelfStock);
  const requests = useApp((s) => s.restockRequests);
  const sh = timeline?.shelf;
  if (!shelfOn) return <p className="hint">{t('开启「货架存量模型」后，这里显示货架空了的商品和补货任务。')}</p>;
  if (!sh) return null;
  // 每个商品在当前时刻的状态：最后一条事件
  const status = new Map<string, { kind: string; t: number; name: string; locationId: string; reason?: string }>();
  for (const e of sh.events) {
    if (e.t > tm) break;
    if (!e.bay.startsWith(`${runId}|`)) continue;
    const prev = status.get(e.itemId);
    // 已经空了时，补货任务不覆盖「空」的状态
    status.set(e.itemId, { kind: e.kind === 'TASK' && prev?.kind === 'EMPTY' ? 'EMPTY_TASK' : e.kind, t: e.t, name: e.name, locationId: e.locationId, ...(e.reason ? { reason: e.reason } : {}) });
  }
  const open = [...status.entries()].filter(([, v]) => v.kind !== 'DONE');
  const bayFills = Object.entries(sh.bays).filter(([k]) => k.startsWith(`${runId}|`));
  let fill = 0;
  for (const [, steps] of bayFills) {
    let last = steps[1] ?? 1;
    for (let i = 0; i + 2 < steps.length; i += 3) {
      if ((steps[i] as number) > tm) break;
      last = steps[i + 1] as number;
    }
    fill += last;
  }
  const avg = bayFills.length ? fill / bayFills.length : 1;
  return (
    <>
      <h3 className="gap">{t('货架存量')}</h3>
      <dl className="facts">
        <dt>{t('平均填充率')}</dt>
        <dd>{Math.round(avg * 100)}%</dd>
        <dt>{t('空着 / 待补货')}</dt>
        <dd>{open.length}</dd>
      </dl>
      {open.length > 0 && (
        <ul className="stock-list">
          {open.slice(0, 12).map(([itemId, v]) => {
            const asked = requests.some((r) => r.itemId === itemId && r.t <= tm);
            return (
              <li key={itemId}>
                <span className={v.kind.startsWith('EMPTY') ? 'warn' : ''}>{translate(v.name)}</span>
                <span className="muted mono">{v.locationId}</span>
                <span className="muted">{v.kind === 'EMPTY' ? ((sh.backroom[itemId] ?? 0) > 0 ? t('空了') : t('空了 · 后仓也没有')) : v.kind === 'EMPTY_TASK' ? t('空了 · 已派补货') : t('补货中 · {0}', t(REASON_LABEL[v.reason ?? ''] ?? v.reason ?? ''))}</span>
                {v.kind === 'EMPTY' && !asked && (sh.backroom[itemId] ?? 0) > 0 && (
                  <button className="link" onClick={() => useApp.getState().requestRestock(itemId)}>
                    {t('请求补货')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="hint">{t('点「请求补货」会在当前时刻生成补货任务并重新仿真；后仓补取员空闲时去后仓取箱上架（需要后仓有货）。')}</p>
    </>
  );
}

function CarView({ id }: { id: string }) {
  const tm = useClock(2);
  const timeline = useApp((s) => s.timeline);
  const longWait = useApp((s) => s.config.rules.handoff.longWaitMin);
  const car = timeline?.cars.find((c) => c.id === id);
  if (!car || !timeline) return <p className="muted">{t('车辆已离开。')}</p>;
  const waitingMin = (Math.min(tm, car.doneAt) - car.arriveAt) / 60;
  return (
    <>
      <h2>{t(car.kind === 'TRIP' ? '配送司机' : '自取顾客')} · {translate(car.label)}</h2>
      <dl className="facts">
        <dt>{t('到达')}</dt>
        <dd>{clockText(car.arriveAt)}</dd>
        <dt>{t(tm < car.doneAt ? '已等待' : '总等待')}</dt>
        <dd className={waitingMin >= longWait ? 'warn' : ''}>{num(Math.max(0, waitingMin), 1)} {t('分钟')}</dd>
        <dt>{t('交付完成')}</dt>
        <dd>{clockText(car.doneAt)}</dd>
        {car.delaySec ? (
          <>
            <dt>{t('路上堵车')}</dt>
            <dd>{t('晚到 {0} 分钟', num(car.delaySec / 60, 1))}</dd>
          </>
        ) : null}
      </dl>
      <h3>{t('订单')}</h3>
      <ul className="orders">
        {car.orderIds.map((oid) => {
          const o = timeline.orders[oid];
          if (!o) return null;
          return (
            <li key={oid}>
              <span className="mono">#{o.shortCode}</span> {o.name} · {t('{0} 件 / {1} 框', o.units, o.totes)}
              {o.lateMin ? <span className="warn"> {t('· 晚 {0} 分钟就绪', o.lateMin)}</span> : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function StagingView({ id }: { id: string }) {
  const tm = useClock(4);
  const timeline = useApp((s) => s.timeline);
  if (!timeline || !(id in timeline.series.stagingOcc)) return <h2>{t('暂存区')} · {id === 'RECOVERY' ? t('回收专区') : id === 'OVERSIZED' ? t('大件区') : id}</h2>;
  const z = id as 'AMBIENT' | 'CHILLED' | 'FROZEN';
  const v = at(timeline.series, timeline.series.stagingOcc[z], tm);
  return (
    <>
      <h2>
        <span className="dot" style={{ background: ZONE_COLOR[z] }} />
        {t('{0}暂存', ZONE_LABEL[z])}
      </h2>
      <dl className="facts">
        <dt>{t('当前占用率')}</dt>
        <dd>{pct(v)}</dd>
      </dl>
    </>
  );
}

function FacilityView({ id }: { id: string }) {
  const tm = useClock(4);
  const timeline = useApp((s) => s.timeline);
  const a = timeline?.autoService.find((x) => x.facilityId === id);
  if (!a || !timeline) return <p className="muted">{t('该设施不在本次仿真中。')}</p>;
  const s = timeline.series;
  const done = a.jobs.filter((j) => j.end !== undefined && j.end <= tm);
  const revenue = done.reduce((n, j) => n + j.revenue, 0);
  const bays = a.oilBays + a.tireBays;
  const busy = new Map<number, (typeof a.jobs)[number]>();
  for (const j of a.jobs) if (j.start !== undefined && j.end !== undefined && j.bay !== undefined && tm >= j.start && tm < j.end) busy.set(j.bay, j);
  return (
    <>
      <h2>{t('汽车服务中心')}</h2>
      <dl className="facts">
        <dt>{t('正在作业')}</dt>
        <dd>
          {t('{0} / {1} 个工位', busy.size, bays)}
        </dd>
        <dt>{t('排队')}</dt>
        <dd>{num(at(s, a.queue, tm))} {t('辆')}</dd>
        <dt>{t('今日已完成')}</dt>
        <dd>
          {t('{0} 辆（全天 {1}）', done.length, a.metrics.served)}
        </dd>
        <dt>{t('今日营收')}</dt>
        <dd>${num(revenue)}</dd>
        <dt>{t('平均等待')}</dt>
        <dd>{num(a.metrics.avgWaitMin, 1)} {t('分钟')}</dd>
        <dt>{t('因排队离开')}</dt>
        <dd className={a.metrics.balked ? 'warn' : ''}>{a.metrics.balked} {t('位')}</dd>
        <dt>{t('工位利用率')}</dt>
        <dd>{pct(a.metrics.bayUtil)}</dd>
      </dl>
      <h3>{t('工位')}</h3>
      <ul className="orders">
        {Array.from({ length: bays }, (_, b) => {
          const j = busy.get(b);
          return (
            <li key={b}>
              <span className="mono">{b < a.oilBays ? t('机油 {0}', b + 1) : t('轮胎 {0}', b - a.oilBays + 1)}</span> · {j ? t('{0} 作业中，预计 {1} 完成', j.id, clockText(j.end as number)) : t('空闲')}
            </li>
          );
        })}
      </ul>
      <p className="hint">{t('收入与工时是公开常识级的假设参数（机油保养 $45–85，换轮胎工时 $60–140，35% 的顾客同时购买一套新轮胎）。')}</p>
    </>
  );
}

/** 选中事件关联的对象并把镜头移过去（车辆已离开时，时间轴回到事件发生时） */
export function focusNotification(n: Notification): void {
  const app = useApp.getState();
  const { timeline, simGeo: geo } = app;
  if (!n.target || !timeline) return;
  if (n.target.type === 'car') {
    const car = timeline.cars.find((c) => c.id === n.target?.id);
    if (car && clock.time > car.doneAt) setTime(Math.max(car.arriveAt, n.t));
    app.select({ type: 'car', id: n.target.id });
    const p = car ? carSpot(geo.lot, car.spot) : undefined;
    if (p) app.focusOn(p.x, p.y, p.z);
    else {
      const fp = framePositions.get(n.target.id);
      if (fp) app.focusOn(fp.x, fp.y, fp.z);
    }
  } else if (n.target.type === 'run') {
    const [runId, bay] = n.target.id.split('|');
    app.select({ type: 'run', id: runId ?? '' });
    const sh = geo.shelves.find((x) => x.runId === runId && x.bay === Number(bay));
    if (sh) app.focusOn(sh.x, sh.y, sh.z);
  } else if (n.target.type === 'staging') {
    app.select({ type: 'staging', id: n.target.id });
    const r = geo.racks.find((x) => x.tempZone === n.target?.id);
    if (r) app.focusOn(r.x, 0, r.z);
  } else {
    app.select({ type: 'associate', id: n.target.id });
    const fp = framePositions.get(n.target.id);
    if (fp) app.focusOn(fp.x, fp.y, fp.z);
  }
}

/** 把镜头移到当前选中的对象 */
function locateSelection(): void {
  const app = useApp.getState();
  const sel = app.selection;
  if (!sel) return;
  const moving = framePositions.get(sel.id);
  if ((sel.type === 'associate' || sel.type === 'car') && moving) return app.focusOn(moving.x, moving.y, moving.z);
  if (sel.type === 'run') {
    const run = app.config.layout.runs.find((r) => r.id === sel.id);
    if (run) app.focusOn((run.start.x + run.end.x) / 2, app.geo.floorY.get(run.floorId) ?? 0, (run.start.y + run.end.y) / 2);
  } else if (sel.type === 'staging') {
    const r = app.geo.racks.find((x) => x.tempZone === sel.id || x.purpose === sel.id);
    if (r) app.focusOn(r.x, 0, r.z);
  } else if (sel.type === 'facility') {
    const f = app.geo.facilities.find((x) => x.id === sel.id);
    if (f) app.focusOn((f.x0 + f.x1) / 2, 0, (f.z0 + f.z1) / 2 - 6);
  }
}

/** 场景上的浮动卡片：显示当前选中对象的实时详情 */
export function Inspector() {
  const selection = useApp((s) => s.selection);
  const follow = useApp((s) => s.follow);
  if (!selection) return null;
  const movable = selection.type === 'associate' || selection.type === 'car';
  return (
    <section className="inspector float-card" aria-live="polite">
      {movable && (
        <button className={`follow${follow === selection.id ? ' on' : ''}`} aria-pressed={follow === selection.id} title={t('镜头跟随（G）')} onClick={() => useApp.getState().setFollow(follow === selection.id ? undefined : selection.id)}>
          {t(follow === selection.id ? '跟随中' : '跟随')}
        </button>
      )}
      <button className="locate" aria-label={t('定位到该对象')} title={t('定位')} onClick={locateSelection}>
        ◎
      </button>
      <button className="close" aria-label={t('关闭')} onClick={() => useApp.getState().select(undefined)}>
        ×
      </button>
      {selection.type === 'associate' && <AssociateView id={selection.id} />}
      {selection.type === 'run' && <RunView id={selection.id} />}
      {selection.type === 'car' && <CarView id={selection.id} />}
      {selection.type === 'staging' && <StagingView id={selection.id} />}
      {selection.type === 'facility' && <FacilityView id={selection.id} />}
    </section>
  );
}

/** 场景左下角的图例 */
export function Legend() {
  return (
    <ul className="legend scene-legend" aria-label={t('图例')}>
      {(['pick', 'stage', 'handoff', 'exception'] as const).map((r) => (
        <li key={r}>
          <span className="dot" style={{ background: ROLE_COLOR[r] }} />
          {t('{0}员', ROLE_LABEL[r])}
        </li>
      ))}
    </ul>
  );
}

export function EventFeed({ limit = 40, levels }: { limit?: number; levels?: ReadonlySet<NotificationLevel> }) {
  const tm = useClock(3);
  const timeline = useApp((s) => s.timeline);
  if (!timeline) return null;
  const list = timeline.notifications;
  // 二分找到当前时刻之前的最后一条
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid]?.t ?? 0) <= tm) lo = mid + 1;
    else hi = mid;
  }
  const recent: typeof list = [];
  for (let i = lo - 1; i >= 0 && recent.length < limit; i--) {
    const n = list[i] as (typeof list)[number];
    if (!levels || levels.has(n.level)) recent.push(n);
  }
  return (
    <section className="feed">
      {recent.length === 0 && <p className="muted">{t('暂无事件。')}</p>}
      <ul>
        {recent.map((n, i) => (
          <li
            key={`${n.t}-${i}`}
            className={`lvl-${n.level}${n.target ? ' clickable' : ''}`}
            role={n.target ? 'button' : undefined}
            tabIndex={n.target ? 0 : undefined}
            onClick={() => focusNotification(n)}
            onKeyDown={(e) => e.key === 'Enter' && focusNotification(n)}
          >
            <span className="mono time">{clockText(n.t)}</span>
            <span className="lvl" aria-label={t(n.level === 'alert' ? '警报' : n.level === 'warn' ? '提醒' : '信息')}>
              {n.level === 'alert' ? '⚠' : n.level === 'warn' ? '●' : '·'}
            </span>
            <span>{translate(n.text)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
