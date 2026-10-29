import { useEffect, useState } from 'react';
import type { AiModule } from '@storewright/ai';
import { outcomeSummary, type AiModelHealth, type AiModuleStats, type LiveRec } from '@storewright/ops';
import { ai, type AiSummary, type Brief, type BriefItem, type BriefPart, type CapacityPoint, type ClosingReview, type SlotCapacity, type WeeklyReport } from '../api';
import { toast } from '../ui/Toasts';
import { clock, t } from '../i18n';
import { useLive, useNow } from '../live';
import { canManageAi, type StoreStatic } from '@storewright/ops';
import { MODULE_TEXT, reasonText, ROLE_TEXT } from './AiScreen';

/**
 * 开店简报、AI 运行状态、效果追踪的显示（决策记录 0022 · F1、H3、F4）。
 * 数字都来自门店中枢；这里只负责按语言拼句子。
 */

const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

const PART_TEXT: Record<BriefPart, string> = { MORNING: '早上', MIDDAY: '中午', EVENING: '傍晚' };
const SKILL_TEXT: Record<string, string> = { AGE_CHECK: '年龄核验', FORKLIFT: '开叉车', DELI: '熟食' };
const PART_TITLE: Record<BriefPart, string> = { MORNING: '开店简报', MIDDAY: '午间简报', EVENING: '傍晚简报' };
const PROBLEM_TEXT: Record<string, string> = { LATE: '订单赶不上取货时段', WAIT: '顾客等待变长', COLD_FULL: '冷区暂存快满', BACKLOG: '拣货积压' };

/** AI 模型族的名字 */
export const MODEL_TEXT: Record<string, string> = {
  'orders-hourly': '订单量',
  'eta-arrival': '到店时间',
  'pick-time': '拣货时长',
  'shelf-availability': '可售概率',
  'count-risk': '盘点风险',
  'shelf-truth': '货架真相（顺路核对）',
  'ops-foresight': '运营预警',
  'equipment-health': '设备健康',
};

const HEALTH_STATUS_TEXT: Record<AiModelHealth['status'], string> = { OK: '正常', DRIFT: '误差变大', PAUSED: '已暂停', NO_DATA: '数据不够' };

export function modelName(id: string): string {
  return MODEL_TEXT[id] ? t(MODEL_TEXT[id]) : id;
}

/** 暂停的原因 */
export function causeText(cause: string | undefined, n?: number): string {
  if (cause === 'POS_STALE') return t('收银流水中断超过 30 分钟');
  if (cause === 'SENSORS_OFFLINE') return t('{0} 个传感器离线', n ?? 0);
  return cause ?? '';
}

/** 一条要注意的事、要店长决定的事 */
export function briefItemText(x: BriefItem): string {
  const p = x.params ?? {};
  switch (x.code) {
    case 'FORESIGHT':
      return t('推演预计 {0} 前后{1}', clock(Number(p.at ?? 0)), t(PROBLEM_TEXT[String(p.problem)] ?? '有运营问题'));
    case 'EQUIPMENT':
      return t('设备 {0} 在慢慢变坏，建议报修', String(p.sensor ?? ''));
    case 'TICKET':
      return t('设备 {0} 在报修，{1} 个暂存格位暂停放新框', String(p.sensor ?? ''), Number(p.slots ?? 0));
    case 'GAP':
      return t('{0}–{1} {2}缺 {3} 人', hm(Number(p.from ?? 0)), hm(Number(p.to ?? 0)), t(ROLE_TEXT[String(p.role)] ?? String(p.role)), Number(p.short ?? 0));
    case 'DEMAND':
      return Number(p.pct) >= 0 ? t('单量比平时多 {0}%', Number(p.pct)) : t('单量比平时少 {0}%', Math.abs(Number(p.pct)));
    case 'PEAK':
      return t('高峰在 {0} 点（约 {1} 单）', Number(p.hour ?? 0), Number(p.orders ?? 0));
    case 'AI_HEALTH':
      return p.status === 'PAUSED' ? t('AI 模型「{0}」暂停：{1}', modelName(String(p.model)), causeText(String(p.cause ?? ''))) : t('AI 模型「{0}」最近误差明显变大，考虑重新训练', modelName(String(p.model)));
    case 'INBOUND':
      return t('还有 {0} 车到货没到（共 {1} 箱）', Number(p.trucks ?? 0), Number(p.cases ?? 0));
    case 'RECS':
      return t('{0} 条「{1}」建议等你处理', Number(p.count ?? 0), t(MODULE_TEXT[String(p.module) as AiModule] ?? String(p.module)));
    case 'OFFERS':
      return t('{0} 个补班邀请还没人答复', Number(p.count ?? 0));
    case 'MODE_DOWNGRADED':
      return t('「{0}」最近说到做到率只有 {1}，已自动改为只显示：确认原因后可以改回来', t(MODULE_TEXT[String(p.module) as AiModule] ?? String(p.module)), pct(Number(p.hitRate ?? 0)));
    case 'PUBLISH_SCHEDULE':
      return t('下周（{0} 起）的排班还没发布', String(p.from ?? ''));
    case 'SKILL_GAP':
      return t('{0}–{1} 没有在岗的人会{2}', hm(Number(p.from ?? 0)), hm(Number(p.to ?? 0)), t(SKILL_TEXT[String(p.skill)] ?? String(p.skill))) + (p.train ? t('；可以请 {0} 学', String(p.train)) : '');
    default:
      return x.code;
  }
}

/** 开店简报（早、中、晚）：带班负责人和控制台在 AI 页最上面看到 */
export function BriefCard() {
  const { auth } = useLive();
  const now = useNow(60_000);
  const [part, setPart] = useState<BriefPart | undefined>();
  const [b, setB] = useState<Brief | undefined>();
  useEffect(() => {
    void ai
      .brief(auth, part)
      .then(setB)
      .catch(() => undefined);
  }, [part, now, auth]);
  if (!b) return null;
  const f = b.forecast;
  const st = b.stats;
  return (
    <details className="card brief" open>
      <summary>
        <span className="tag">{t(PART_TITLE[b.part])}</span> <span className="strong">{b.part === 'EVENING' ? t('明天 {0}', f?.date ?? '') : b.date}</span>
      </summary>
      <div className="chips" role="radiogroup" aria-label={t('简报')}>
        {(['MORNING', 'MIDDAY', 'EVENING'] as const).map((k) => (
          <button key={k} role="radio" aria-checked={b.part === k} className={`chip${b.part === k ? ' on' : ''}`} onClick={() => setPart(k)}>
            {t(PART_TEXT[k])}
          </button>
        ))}
      </div>
      {f && (
        <p>
          <b>{b.part === 'EVENING' ? t('明天预计 {0} 单', f.orders) : t('今天预计 {0} 单', f.orders)}</b> {t('（80% 区间 {0}–{1}，平时同一天约 {2} 单）', f.low, f.high, f.usual)}
          {f.peakHour !== undefined && ` · ${t('高峰 {0} 点约 {1} 单', f.peakHour, f.peakOrders ?? 0)}`}
          {f.reasons.length > 0 && <small className="sub-why">{f.reasons.map(reasonText).join(' · ')}</small>}
        </p>
      )}
      {b.soFar && <p>{t('到现在 {0} 单，同一时段预测 {1} 单', b.soFar.orders, b.soFar.expected)}</p>}
      <p>
        {b.inbound.trucks ? t('到货 {0} 车（{1} 箱，已到 {2} 车）', b.inbound.trucks, b.inbound.cases, b.inbound.arrived) : t('没有在途的到货')}
        {b.inbound.next && ` · ${b.inbound.next.at !== undefined ? t('下一车 {0} 预计 {1}', b.inbound.next.supplier, clock(b.inbound.next.at)) : t('下一车 {0}', b.inbound.next.supplier)}`}
      </p>
      <p>
        {t('排班 {0} 人', b.staffing.scheduled)}
        {b.staffing.gaps.length ? ` · ${t('缺口：{0}', b.staffing.gaps.map((g) => t('{0}–{1} {2}缺 {3} 人', hm(g.from), hm(g.to), t(ROLE_TEXT[g.role] ?? g.role), g.short)).join('；'))}` : ` · ${t('没有人手缺口')}`}
        {b.staffing.absences > 0 && ` · ${t('缺勤 {0} 人', b.staffing.absences)}`}
      </p>
      {st && (
        <p className="note">
          {b.part === 'MORNING' ? t('昨天') : t('今天到现在')}：{t('{0} 单，交付 {1} 单，迟到 {2} 单，平均等待 {3} 分钟；缺货 {4} 行、替代 {5} 行；冷链提醒 {6} 次；AI 建议 {7} 条、采纳 {8} 条', st.orders, st.handedOff, st.late, st.avgWaitMin, st.shortLines, st.substitutions, st.coldAlerts, st.recs, st.adopted)}
        </p>
      )}
      <h4>{t('要注意')}</h4>
      {b.watch.length ? (
        <ol className="plain brief-list">
          {b.watch.map((x, i) => (
            <li key={i}>{briefItemText(x)}</li>
          ))}
        </ol>
      ) : (
        <p className="muted">{t('暂时没有要特别注意的事')}</p>
      )}
      {b.decisions.length > 0 && (
        <>
          <h4>{t('需要你决定')}</h4>
          <ul className="plain brief-list">
            {b.decisions.map((x, i) => (
              <li key={i}>{briefItemText(x)}</li>
            ))}
          </ul>
        </>
      )}
      <p className="note">{t('数字来自订单量模型、排班和事件记录；门店助手也能回答「今天要注意什么」。')}</p>
    </details>
  );
}

/** AI 运行监控（H3）：每个模型的健康度；误差变大或暂停的排在前面 */
export function AiHealthCard() {
  const { client } = useLive();
  const h = client.state.aiHealth;
  if (!h) return null;
  const order: Record<AiModelHealth['status'], number> = { DRIFT: 0, PAUSED: 1, OK: 2, NO_DATA: 3 };
  const models = [...h.models].sort((a, b) => order[a.status] - order[b.status] || a.id.localeCompare(b.id));
  return (
    <>
      <h2 className="section-title">{t('AI 运行状态')}</h2>
      <section className="card">
        <ul className="plain ai-health">
          {models.map((m) => (
            <li key={m.id}>
              <span className="grow">{modelName(m.id)}</span>
              <span className={`tag ${m.status === 'OK' ? 'ok' : m.status === 'NO_DATA' ? '' : 'warn-tag'}`}>{t(HEALTH_STATUS_TEXT[m.status])}</span>
              <small className="muted">{healthDetail(m)}</small>
            </li>
          ))}
        </ul>
        <p className="note">{t('做法：最近 7 天对账出来的误差比回测时高三成以上算误差变大（提醒重新训练或回滚）；概率模型看实际发生的比例和模型自己说的差多少；收银流水中断、传感器离线时相关模型自动暂停。更新于 {0}。', clock(h.at))}</p>
      </section>
    </>
  );
}

function healthDetail(m: AiModelHealth): string {
  if (m.status === 'PAUSED') return causeText(m.cause, m.n);
  if (m.recent === undefined) return m.n ? t('样本 {0} 个', m.n) : '';
  if (m.metric === 'rate') return t('实际 {0}，模型说 {1}（{2} 个）', pct(m.recent), pct(m.backtest ?? 0), m.n ?? 0);
  if (m.metric === 'precision') return t('没采纳时问题真的发生 {0}（{1} 次）', pct(m.recent), m.n ?? 0);
  const fmt = (v: number) => (m.metric === 'mae' ? t('{0} 分钟', Math.round(v * 10) / 10) : pct(v));
  return m.backtest !== undefined ? t('最近 {0}，回测 {1}（{2} 个）', fmt(m.recent), fmt(m.backtest), m.n ?? 0) : t('最近 {0}（{1} 个）', fmt(m.recent), m.n ?? 0);
}

const GAIN_UNIT: Record<string, string> = { LATE: '单', WAIT: '分钟', COLD_FULL: '个百分点', BACKLOG: '分钟' };
const GAIN_TEXT: Record<string, string> = { LATE: '迟到', WAIT: '平均等待', COLD_FULL: '冷区峰值', BACKLOG: '拣货积压' };

/** 效果追踪（F4）：一个模块的说到做到率、实现比例、对照组 */
export function OutcomeLine({ stats }: { stats: AiModuleStats | undefined }) {
  const o = outcomeSummary(stats);
  if (!o) return null;
  const parts: string[] = [];
  if (o.hitRate !== undefined) parts.push(t('说到做到 {0}（{1} 次）', pct(o.hitRate), o.n));
  if (o.realized !== undefined) parts.push(t('实现预计改善的 {0}', pct(o.realized)));
  if (o.ctrlRate !== undefined) parts.push(t('没采纳时问题真的发生 {0}（{1} 次）', pct(o.ctrlRate), o.ctrlN));
  if (o.brier !== undefined) parts.push(t('概率的 Brier 分数 {0}', o.brier.toFixed(3)));
  const gains = Object.entries(o.gains).filter(([, g]) => g.n > 0);
  return (
    <>
      <p className="note">{parts.join(' · ')}</p>
      {gains.map(([k, g]) => {
        const scale = k === 'COLD_FULL' ? 100 : 1;
        const pred = Math.round(g.predicted * scale * 10) / 10;
        const act = Math.round(g.actual * scale * 10) / 10;
        return (
          <p key={k} className="note">
            {t('采纳 {0} 次：{1}预计共少 {2} {3}，实际约 {4} {3}（{5}）', g.n, t(GAIN_TEXT[k] ?? k), pred, t(GAIN_UNIT[k] ?? ''), act, pred > 0 ? pct(act / pred) : '—')}
          </p>
        );
      })}
    </>
  );
}

/** 最近处理的建议后面的实际效果（F4） */
export function outcomeText(r: LiveRec): string | undefined {
  const o = r.outcome;
  if (!o) return undefined;
  if (o.kind === 'EFFECT') {
    const v = (x: number) => (o.unit === 'RATIO' ? pct(x) : String(Math.round(x * 10) / 10));
    return o.adopted ? t('实际 {0}（预计 {1}，不处理 {2}）', v(o.actual), v(o.predicted), v(o.baseline ?? o.predicted)) : o.hit ? t('没采纳 · 问题确实发生（{0}）', v(o.actual)) : t('没采纳 · 问题没有发生（{0}）', v(o.actual));
  }
  switch (o.metric) {
    case 'ON_SHELF':
      return r.module === 'PICKING' ? (o.actual ? t('数出来有货') : t('数出来没有')) : o.actual ? t('其实有货') : t('确实没有');
    case 'MISPLACED':
      return o.actual ? t('在附近找到了') : t('附近没有');
    case 'FAULT':
      return o.actual ? t('确认有故障') : t('没发现问题');
    case 'ETA_MIN':
      return o.hit ? t('AI 比导航准（实际 {0} 分钟）', o.actual) : t('导航更准（实际 {0} 分钟）', o.actual);
    case 'RECORD_WRONG':
      return o.actual ? t('盘出差异') : t('记录是对的');
    case 'ORDERS':
      return o.hit ? t('实际 {0} 单（在区间里）', o.actual) : t('实际 {0} 单（在区间外）', o.actual);
    default:
      return String(o.actual);
  }
}

/** 时段产能（决策记录 0023 · B6）：接下来每个取货时段接了多少、还能接多少；带班负责人可以停止 / 重新开放；取舍曲线 */
/** compact：建议页上的精简版（接下来几个时段 + 停止 / 恢复接单，决策记录 0026）；停止接单要点两下 */
export function CapacityCard({ compact }: { compact?: boolean } = {}) {
  const { client, auth, run } = useLive();
  const can = canManageAi(client.statics as StoreStatic, auth.actor);
  const [slots, setSlots] = useState<SlotCapacity[] | undefined>();
  const [curve, setCurve] = useState<CapacityPoint[] | undefined>();
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState<number | undefined>();
  useEffect(() => {
    void ai
      .capacity(auth)
      .then((r) => setSlots(r.slots))
      .catch(() => undefined);
  }, [auth, client.version]);
  if (!slots?.length) return null;
  const rows = compact ? slots.slice(0, 3) : slots;
  return (
    <>
      <h2 className="section-title">{t('时段产能')}</h2>
      <section className="card">
        <p className="note">
          {compact ? t('接下来几个取货时段还能接多少单；快接满时可以停止接新单（已经接的单照常做）。') : t('按在岗的拣货员、交付员和拣货时长模型估计每个取货时段能做多少单；订单平台按这个接口决定还能不能接单。快接满时 AI 建议停止接新单。')}
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('时段')}</th>
                <th>{t('已接')}</th>
                <th>{t('能做（拣货 / 交付）')}</th>
                <th>{t('还能接')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.start}>
                  <td className="mono">
                    {clock(x.start)}–{clock(x.end)}
                  </td>
                  <td className="mono">{x.booked}</td>
                  <td className="mono">
                    {x.capacity}（{x.pick} / {x.handoff}）
                  </td>
                  <td className={`mono ${x.remaining <= Math.max(1, x.capacity * 0.1) ? 'warn-text' : ''}`}>{x.remaining}</td>
                  <td>
                    {x.closed ? <span className="tag warn-tag">{t('停止接单')}</span> : null}
                    {can && closing === x.start && !x.closed ? (
                      <span className="actions">
                        <button
                          className="link danger"
                          onClick={() => {
                            setClosing(undefined);
                            void run({ type: 'CloseSlot', slotStart: x.start }, { quiet: true });
                          }}
                        >
                          {t('确认停止 {0} 接新单', clock(x.start))}
                        </button>
                        <button className="link" onClick={() => setClosing(undefined)}>
                          {t('取消')}
                        </button>
                      </span>
                    ) : (
                      can && (
                        <button className="link" onClick={() => (x.closed ? void run({ type: 'ReopenSlot', slotStart: x.start }, { quiet: true }) : setClosing(x.start))}>
                          {x.closed ? t('重新开放') : t('停止接单')}
                        </button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {can && !compact && (
          <button
            className="chip"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setCurve((await ai.capacityCurve(auth)).curve);
              } catch (e) {
                toast(String(e), 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('仿真：接单上限和迟到的取舍')}
          </button>
        )}
        {curve && curve.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('接单上限')}</th>
                  <th>{t('想下单')}</th>
                  <th>{t('接了')}</th>
                  <th>{t('迟到')}</th>
                </tr>
              </thead>
              <tbody>
                {curve.map((c) => (
                  <tr key={String(c.factor)}>
                    <td>{Number.isFinite(c.factor) && c.factor !== null ? t('产能 × {0}', c.factor) : t('不设上限')}</td>
                    <td className="mono">{c.offered}</td>
                    <td className="mono">{c.accepted}</td>
                    <td className="mono">
                      {c.late}（{pct(c.latePct)}）
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="note">{t('今天剩下的时段按订单量预测和在岗拣货员各跑 20 天（随机种子）取平均：上限越松接得越多、迟到也越多。')}</p>
          </div>
        )}
      </section>
    </>
  );
}

const ATTR_TEXT: Record<string, string> = { flavor: '口味', size: '规格', organic: '有机', glutenFree: '无麸质' };

/** 替代推荐 2.0（决策记录 0023 · B4）：真实标签、属性补充、删除顾客的个人记录 */
export function SubstitutionLive({ data }: { data: NonNullable<AiSummary['substitution']> }) {
  const { auth, client } = useLive();
  const can = canManageAi(client.statics as StoreStatic, auth.actor);
  const [name, setName] = useState('');
  const l = data.labels;
  return (
    <>
      <h2 className="section-title">{t('替代推荐：真实标签与属性补充')}</h2>
      <section className="card">
        <p>{l.n ? t('交付时记下了 {0} 条顾客反应，满意 {1}；AI 推荐第一名的 {2} 条里满意 {3}。', l.n, pct(l.accepted / l.n), l.top1, l.top1 ? pct(l.top1Accepted / l.top1) : '—') : t('还没有交付时记下的顾客反应（交付页上「顾客满意 / 不太满意」）。')}</p>
        <p className="note">
          {t('从商品名里抽属性（规则；接上本地语言模型后可以补得更全）：')}
          {Object.entries(data.attributes)
            .map(([k, v]) => t('{0} 准确 {1}、覆盖 {2}', t(ATTR_TEXT[k] ?? k), pct(v.precision), pct(v.recall)))
            .join(' · ')}
        </p>
        <p className="note">{t('个人偏好只用于本店的替代推荐，不用于营销；顾客要求时可以删除他的记录（替代标签、到店习惯）。')}</p>
        {can && (
          <div className="actions">
            <input value={name} placeholder={t('顾客姓名（名 姓）')} aria-label={t('顾客姓名（名 姓）')} onChange={(e) => setName(e.target.value)} />
            <button
              disabled={!name.trim()}
              onClick={async () => {
                const r = await ai.forgetCustomer(auth, name.trim());
                toast(t('已删除 {0} 的个人记录（替代标签 {1} 条），以后不再使用', name.trim(), r.removed), 'ok');
                setName('');
              }}
            >
              {t('删除这位顾客的记录')}
            </button>
          </div>
        )}
      </section>
    </>
  );
}

/** 每个原因：让迟到变多时、让迟到变少时（Shapley 值为负：例如单量比预测少，帮了忙）的说法 */
const FACTOR_TEXT: Record<string, [string, string]> = { DEMAND: ['单量比预测多', '单量比预测少'], STAFF: ['拣货的人比排班少', '拣货的人比排班多'], PACE: ['拣货比标准慢', '拣货比标准快'] };

/** 打烊复盘（决策记录 0024 · F3）：迟到订单按原因分开，附复刻精度、晚到的车造成的缺货、建议的效果、明天要注意的事 */
export function ReviewCard() {
  const { auth, client } = useLive();
  const [r, setR] = useState<ClosingReview | undefined>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    void ai
      .review(auth)
      .then(setR)
      .catch(() => undefined);
  }, [auth, open, client.version]);
  return (
    <details className="card review" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <span className="tag">{t('打烊复盘')}</span> <span className="strong">{t('今天的迟到订单按原因分开')}</span>
      </summary>
      {!r ? (
        <p className="muted">{t('正在复刻今天…')}</p>
      ) : (
        <>
          <p>
            <b>{t('今天迟到 {0} 单', r.actualLate)}</b>
            {(['DEMAND', 'STAFF', 'PACE'] as const)
              .filter((f) => Math.abs(r.factors[f]) >= 0.5)
              .map((f) => {
                const v = Math.round(r.factors[f]);
                const [more, less] = FACTOR_TEXT[f] as [string, string];
                return ` · ${v > 0 ? t('{0}：多迟到约 {1} 单', t(more), v) : t('{0}：少迟到约 {1} 单', t(less), -v)}`;
              })
              .join('')}
            {Math.round(r.other) > 0 && ` · ${t('其他原因约 {0} 单', Math.round(r.other))}`}
          </p>
          <p className="note">{t('复刻今天：实际输入下 {0} 单迟到，三个原因都没有时 {1} 单；和实际差 {2} 单（复刻精度）。输入：{3} 单（预测 {4}），拣货的人平均 {5}（排班 {6}），拣货快慢是标准的 {7} 倍。', r.replay, r.baseline, Math.abs(r.actualLate - r.replay), r.inputs.orders, r.inputs.forecast, r.inputs.pickers, r.inputs.scheduled, r.inputs.pace)}</p>
          <p className="note">{t('缺货 {0} 行，其中 {1} 行的商品在晚到的车上。AI 建议 {2} 条、采纳 {3} 条；测到效果的 {4} 条里 {5} 条达到预计。', r.shortages.lines, r.shortages.lateTruckLines, r.recs.issued, r.recs.adopted, r.recs.measured, r.recs.hits)}</p>
          {r.notes.length > 0 && (
            <>
              <h4>{t('明天要注意')}</h4>
              <ul className="plain brief-list">
                {r.notes.map((x, i) => (
                  <li key={i}>{briefItemText(x)}</li>
                ))}
              </ul>
            </>
          )}
          <p className="note">{t('做法：用今天的实际输入复刻一天（和时段产能同一个排队模型），逐个去掉扰动再复刻，三个原因的全部组合算 Shapley 值；复刻不了的部分算「其他」。')}</p>
        </>
      )}
    </details>
  );
}

/** 周报（决策记录 0024 · F5） */
export function WeeklyCard() {
  const { auth } = useLive();
  const [w, setW] = useState<WeeklyReport | undefined>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    void ai
      .weekly(auth)
      .then(setW)
      .catch(() => undefined);
  }, [auth, open]);
  return (
    <details className="card weekly" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <span className="tag">{t('周报')}</span> <span className="strong">{t('最近 7 天和下周')}</span>
      </summary>
      {!w ? (
        <p className="muted">{t('正在整理…')}</p>
      ) : (
        <>
          <p>{t('{0} 到 {1}：{2} 单，迟到 {3}，平均等待 {4} 分钟，缺货 {5} 行、替代 {6} 行，冷链提醒 {7} 次；AI 建议 {8} 条、采纳 {9} 条。', w.from, w.to, w.totals.orders, w.totals.late, w.totals.avgWaitMin, w.totals.shortLines, w.totals.substitutions, w.totals.coldAlerts, w.totals.recs, w.totals.adopted)}</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('日期')}</th>
                  <th>{t('订单')}</th>
                  <th>{t('迟到')}</th>
                  <th>{t('平均等待')}</th>
                </tr>
              </thead>
              <tbody>
                {w.days.map((d) => (
                  <tr key={d.date}>
                    <td className="mono">{d.date.slice(5)}</td>
                    <td className="mono">{d.orders}</td>
                    <td className="mono">{d.late ?? '—'}</td>
                    <td className="mono">{d.avgWaitMin ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {w.outcomes.length > 0 && <p className="note">{t('说到做到率：{0}', w.outcomes.map((x) => `${t(MODULE_TEXT[x.module as AiModule] ?? x.module)} ${x.hitRate !== undefined ? pct(x.hitRate) : '—'}（${x.n}）`).join('、'))}</p>}
          <p>{t('下周（{0} 起）预计 {1} 单（{2}–{3}），排班缺口 {4} 段。', w.nextWeek.from, w.nextWeek.orders, w.nextWeek.low, w.nextWeek.high, w.nextWeek.gaps)}</p>
          <p className="note">{t('数字来自事件记录和订单量模型；门店助手也能回答「给我这周的周报」。')}</p>
        </>
      )}
    </details>
  );
}
