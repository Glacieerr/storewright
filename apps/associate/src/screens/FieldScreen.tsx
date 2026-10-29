import { useEffect, useState } from 'react';
import { activeIncident, canManageAi, INCIDENT_KINDS, INCIDENT_STEPS, RECALL_STEPS, currentRole, recallTotes, type Incident, type IncidentKind, type Recall, type RecallStep, type StoreStatic } from '@storewright/ops';
import { sensorsFor } from '@storewright/twin';
import { ai, type FoodSafetyLog, type RecallMatch } from '../api';
import { clock, t } from '../i18n';
import { useLive, useNow } from '../live';
import { toast } from '../ui/Toasts';
import { ROLE_TEXT } from './AiScreen';
import { sensorName } from './TwinCard';

/**
 * 现场应对（决策记录 0024 · C5、E4、E5）：突发状况的清单、召回、食品安全记录。
 * 带班负责人和门店管理员在 AI 页的「现场」里操作；突发状况进行中时，每个人在顶部看到自己岗位的清单。
 */

export const INCIDENT_TEXT: Record<IncidentKind, string> = { POWER: '停电', FIRE: '火警', SYSTEM: '系统故障', STORM: '暴雨' };
export const STEP_TEXT: Record<string, string> = {
  CALL_FACILITIES: '联系物业 / 电力公司，问恢复时间',
  DECIDE_PAUSE: '决定要不要暂停接单、暂停冷链拣货',
  CLOSE_COLD_DOORS: '关好所有冷柜、冷库的门，少开门',
  LOG_TEMPS: '每 15 分钟记一次冷柜温度',
  RETURN_COLD_TOTES: '推车上的冷藏 / 冷冻框立即送回暂存区',
  INFORM_CUSTOMERS: '告诉到店和快到的顾客可能要多等',
  CALL_EMERGENCY: '拨打火警电话，报门店地址',
  EVACUATE: '放下手上的东西，从最近的出口离开',
  GUIDE_CUSTOMERS: '引导顾客从出口离开，不要用电梯',
  HEADCOUNT: '在集合点清点人数',
  NO_REENTRY: '确认安全之前不要回到店里',
  SWITCH_PAPER: '切换到纸质单据（拣货单、交付登记）',
  PRINT_PICKLISTS: '用打印好的拣货单拣货，记下拣了什么',
  MANUAL_HANDOFF_LOG: '交付时手写登记订单号和顾客姓名',
  HOLD_RECEIVING: '收货先不入库，放待检区',
  RECONCILE_AFTER: '恢复后把纸质记录补录进系统',
  SECURE_DOCKS: '关好卸货门，收起外面的推车和托盘',
  PRIORITIZE_PICKUPS: '先拣快到的自取单',
  CHECK_LOT: '看停车场和取货车位有没有积水，必要时改到门口交付',
};
const RECALL_STEP_TEXT: Record<RecallStep, string> = { SHELF: '货架下架', BACKROOM: '后仓的箱子转待检', STAGED: '暂存和推车上的框拿出来', ORDERS: '未完成的订单换替代或标缺货', CUSTOMERS: '通知已经取走的顾客' };
const REASON_TEXT: Record<string, string> = { SALMONELLA: '可能受沙门氏菌污染', LISTERIA: '可能受李斯特菌污染', E_COLI: '可能受大肠杆菌污染', ALLERGEN: '含有未标注的过敏原', FOREIGN_MATTER: '可能混入异物', MOLD: '可能发霉', LABELING: '标签有误' };

export function reasonOf(code?: string): string {
  return code ? t(REASON_TEXT[code] ?? code) : '';
}

/** 突发状况进行中：每个人在顶部看到自己岗位（和所有人）的清单，做完打勾 */
export function IncidentBanner() {
  const { client, auth, run } = useLive();
  const now = useNow(30_000);
  const [open, setOpen] = useState<boolean | undefined>();
  const x = activeIncident(client.state);
  if (!x) return null;
  const st = client.statics as StoreStatic | undefined;
  const mine = auth.role === 'console' ? undefined : (currentRole(st, client.state, auth.actor, client.now()) ?? undefined);
  const lead = st?.roster.find((a) => a.id === auth.actor)?.role === 'LEAD' || auth.role === 'console';
  const steps = INCIDENT_STEPS[x.kind].filter((p) => lead || p.role === 'ALL' || p.role === mine || (mine === 'RESTOCK' && p.role === 'BACKROOM'));
  // 员工默认展开（自己岗位的一两步）；带班负责人默认收起（「现场」里有完整的清单），点标题展开
  const expanded = open ?? !lead;
  const done = steps.filter((p) => x.checked[p.id]).length;
  return (
    <div className="banner error incident" role="alert">
      <button className="incident-head" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
        <span className="strong">
          {t('突发状况：{0}', t(INCIDENT_TEXT[x.kind]))} · {t('{0} 开始，已经 {1} 分钟', clock(x.startedAt), Math.max(0, Math.round((now - x.startedAt) / 60_000)))}
        </span>
        <span className="incident-count">{t('清单（{0} / {1}）', done, steps.length)}</span>
      </button>
      {expanded && (
        <ul className="plain">
          {steps.map((p) => (
            <li key={p.id}>
              <label className="toggle">
                <input type="checkbox" checked={!!x.checked[p.id]} disabled={!!x.checked[p.id]} onChange={() => void run({ type: 'CheckIncidentStep', incidentId: x.id, stepId: p.id }, { quiet: true })} />
                <span>
                  {t(STEP_TEXT[p.id] ?? p.id)}
                  {p.role !== 'ALL' && <small className="muted"> · {t(ROLE_TEXT[p.role] ?? p.role)}</small>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function FieldScreen() {
  return (
    <div className="list">
      <IncidentSection />
      <RecallSection />
      <FoodSafetySection />
    </div>
  );
}

function IncidentSection() {
  const { client, auth, run } = useLive();
  const can = canManageAi(client.statics as StoreStatic, auth.actor);
  // 开启前再确认一次（决策记录 0026：以前点一下就推到所有人的手机上）
  const [starting, setStarting] = useState<IncidentKind | undefined>();
  const x = activeIncident(client.state);
  const last = Object.values(client.state.incidents ?? {})
    .filter((i) => i.endedAt !== undefined)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
  return (
    <>
      <h2 className="section-title">{t('突发状况')}</h2>
      {x ? (
        <IncidentCard x={x} />
      ) : (
        <section className="card">
          <p className="note">{t('停电、火警、系统故障、暴雨时，开启后每个人的手机上出现按岗位分好的清单，附实时影响和顾客通知草稿；结束后按事件记录生成时间线。')}</p>
          {can && !starting && (
            <div className="chips">
              {INCIDENT_KINDS.map((k) => (
                <button key={k} className="chip" onClick={() => setStarting(k)}>
                  {t('开启：{0}', t(INCIDENT_TEXT[k]))}
                </button>
              ))}
            </div>
          )}
          {can && starting && (
            <div className="ai-confirm" role="alertdialog" aria-label={t('确认开启')}>
              <p className="strong">{t('确认开启「{0}」？每个人的手机上会马上出现清单。', t(INCIDENT_TEXT[starting]))}</p>
              <div className="actions">
                <button onClick={() => setStarting(undefined)}>{t('取消')}</button>
                <button
                  className="primary"
                  onClick={() => {
                    const k = starting;
                    setStarting(undefined);
                    void run({ type: 'StartIncident', kind: k });
                  }}
                >
                  {t('确认开启')}
                </button>
              </div>
            </div>
          )}
        </section>
      )}
      {last && <IncidentReport x={last} />}
    </>
  );
}

function IncidentCard({ x }: { x: Incident }) {
  const { client, auth, run } = useLive();
  const can = canManageAi(client.statics as StoreStatic, auth.actor);
  const now = useNow(30_000);
  const done = Object.keys(x.checked).length;
  const steps = INCIDENT_STEPS[x.kind];
  const draft = x.kind === 'FIRE' ? '' : t('您好，门店现在遇到{0}，正在处理。您的订单可能会晚一些，我们准备好后会再通知您。给您带来不便，非常抱歉。', t(INCIDENT_TEXT[x.kind]));
  return (
    <section className="card">
      <div className="card-head">
        <span className="tag warn-tag">{t(INCIDENT_TEXT[x.kind])}</span>
        <span className="strong">{t('{0} 开始，已经 {1} 分钟（冷链计时从开始算）', clock(x.startedAt), Math.max(0, Math.round((now - x.startedAt) / 60_000)))}</span>
      </div>
      <p>{t('影响：暂存里冷藏框 {0}、冷冻框 {1}，后仓冷链箱 {2}，接下来两小时要取的订单 {3} 张', x.impact.coldTotes, x.impact.frozenTotes, x.impact.coldCases, x.impact.ordersSoon.length)}</p>
      <h4>{t('清单（{0} / {1}）', done, steps.length)}</h4>
      <ul className="plain">
        {steps.map((p) => (
          <li key={p.id}>
            <label className="toggle">
              <input type="checkbox" checked={!!x.checked[p.id]} disabled={!!x.checked[p.id]} onChange={() => void run({ type: 'CheckIncidentStep', incidentId: x.id, stepId: p.id }, { quiet: true })} />
              <span>
                {t(STEP_TEXT[p.id] ?? p.id)} <small className="muted">· {p.role === 'ALL' ? t('所有人') : t(ROLE_TEXT[p.role] ?? p.role)}</small>
                {x.checked[p.id] && <small className="muted"> · {clock((x.checked[p.id] as { at: number }).at)}</small>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {draft && x.impact.ordersSoon.length > 0 && (
        <>
          <h4>{t('顾客通知草稿（{0} 张订单）', x.impact.ordersSoon.length)}</h4>
          <p className="note">{draft}</p>
          <button className="chip" onClick={() => void navigator.clipboard?.writeText(draft).then(() => toast(t('已复制'), 'ok'))}>
            {t('复制')}
          </button>
        </>
      )}
      {can && (
        <button className="primary block" onClick={() => void run({ type: 'EndIncident', incidentId: x.id })}>
          {t('结束，生成时间线')}
        </button>
      )}
    </section>
  );
}

function IncidentReport({ x }: { x: Incident }) {
  const { auth } = useLive();
  const [rows, setRows] = useState<Array<{ at: number; type: string; actor: string }> | undefined>();
  useEffect(() => {
    void ai
      .incidentReport(auth, x.id)
      .then((r) => setRows(r.timeline))
      .catch(() => undefined);
  }, [auth, x.id]);
  return (
    <details className="card">
      <summary>
        {t('上一次：{0}（{1}–{2}）', t(INCIDENT_TEXT[x.kind]), clock(x.startedAt), clock(x.endedAt ?? x.startedAt))}
      </summary>
      <p className="note">{t('清单完成 {0} / {1}', Object.keys(x.checked).length, INCIDENT_STEPS[x.kind].length)}</p>
      {rows && (
        <ol className="plain timeline">
          {rows.map((r, i) => (
            <li key={i}>
              <span className="mono">{clock(r.at)}</span> {r.type} <small className="muted">{r.actor}</small>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

function RecallSection() {
  const { client, auth, run } = useLive();
  const can = canManageAi(client.statics as StoreStatic, auth.actor);
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<{ parsed: { product: string; size?: string; gtins: string[]; lots: string[]; from?: string; to?: string; reason?: string }; matches: RecallMatch[] } | undefined>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const open = Object.values(client.state.recalls ?? {}).filter((r) => r.status === 'OPEN');
  const parse = async (raw: string) => {
    const r = await ai.parseRecall(auth, raw);
    setParsed(r);
    // 默认勾上：条码一致的、名字的词全部对上的（分数 ≥ 0.85）
    setPicked(new Set(r.matches.filter((m) => m.score >= 0.85).map((m) => m.itemId)));
  };
  return (
    <>
      <h2 className="section-title">{t('召回')}</h2>
      {open.map((r) => (
        <RecallCard key={r.id} r={r} />
      ))}
      {can && (
        <section className="card">
          <p className="note">{t('粘贴公开的召回通知：AI 抽出商品、条码、批号、日期和原因，和商品目录匹配；你确认后才开始下架、拦截和通知顾客。宁可多选。')}</p>
          <textarea className="field-text" rows={4} value={text} placeholder={t('召回通知的文字')} aria-label={t('召回通知的文字')} onChange={(e) => setText(e.target.value)} />
          <button className="primary block" disabled={!text.trim()} onClick={() => void parse(text).catch((e: unknown) => toast(String(e), 'error'))}>
            {t('识别')}
          </button>
          <button
            className="link"
            onClick={async () => {
              const r = await ai.demoRecall(auth);
              setText(r.text);
              await parse(r.text);
            }}
          >
            {t('演示：生成一条召回通知')}
          </button>
          {parsed && (
            <>
              <p className="note">
                {t('商品：{0}', parsed.parsed.product)}
                {parsed.parsed.size ? ` · ${parsed.parsed.size}` : ''}
                {parsed.parsed.gtins.length ? ` · ${t('条码 {0}', parsed.parsed.gtins.join('、'))}` : ''}
                {parsed.parsed.lots.length ? ` · ${t('批号 {0}', parsed.parsed.lots.join('、'))}` : ''}
                {parsed.parsed.from ? ` · ${parsed.parsed.from}${parsed.parsed.to ? ` – ${parsed.parsed.to}` : ''}` : ''}
                {parsed.parsed.reason ? ` · ${reasonOf(parsed.parsed.reason)}` : ''}
              </p>
              {parsed.matches.length ? (
                <ul className="plain recall-matches">
                  {parsed.matches.map((m) => (
                    <li key={m.itemId}>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={picked.has(m.itemId)}
                          onChange={(e) => {
                            const next = new Set(picked);
                            if (e.target.checked) next.add(m.itemId);
                            else next.delete(m.itemId);
                            setPicked(next);
                          }}
                        />
                        <span>
                          {m.name}
                          <small className="muted">{t('{0} · 匹配 {1}% · 货架约 {2} 件 · 后仓 {3} 箱 · 未完成订单 {4}', m.by === 'GTIN' ? t('条码一致') : t('名字'), Math.round(m.score * 100), m.shelf, m.cases, m.openOrders)}</small>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">{t('商品目录里没有匹配的商品')}</p>
              )}
              <button
                className="primary block"
                disabled={!picked.size}
                onClick={async () => {
                  const p = parsed.parsed;
                  if (await run({ type: 'OpenRecall', title: p.product, itemIds: [...picked], lots: p.lots, ...(p.reason ? { reason: p.reason } : {}), ...(p.from ? { from: p.from } : {}), ...(p.to ? { to: p.to } : {}) })) {
                    setParsed(undefined);
                    setText('');
                  }
                }}
              >
                {t('确认 {0} 件商品，开始召回', picked.size)}
              </button>
            </>
          )}
        </section>
      )}
    </>
  );
}

function RecallCard({ r }: { r: Recall }) {
  const { client, auth, run } = useLive();
  const can = canManageAi(client.statics as StoreStatic, auth.actor);
  const st = client.statics as StoreStatic;
  // 同名的不同商品（规格不同）后面写上货位，免得看成重复
  const items = r.itemIds.map((id) => st.planogram.find((p) => p.itemId === id));
  const names = items.map((p, i) => (p ? (items.filter((x) => x?.name === p.name).length > 1 ? `${p.name}（${p.locationId}）` : p.name) : (r.itemIds[i] as string)));
  const shelfUnits = Object.values(r.affected.shelf).reduce((a, b) => a + b, 0);
  const locs = r.itemIds.map((id) => st.planogram.find((p) => p.itemId === id)?.locationId).filter(Boolean);
  const counts: Record<RecallStep, string> = {
    SHELF: t('货架约 {0} 件（{1}）', shelfUnits, locs.join('、')),
    BACKROOM: t('{0} 箱（已经转待检）', r.affected.cases.length),
    STAGED: t('{0} 个框', r.affected.totes.length),
    ORDERS: t('{0} 张订单', r.affected.openOrders.length),
    CUSTOMERS: t('{0} 位顾客（30 天内取走的）', r.affected.doneOrders.length),
  };
  const done = client.state.orders;
  // 召回列出位置（决策记录 0026）：还没交给顾客的框在哪里、哪张订单、哪些商品
  const totes = recallTotes(client.state, r);
  const openSteps = RECALL_STEPS.filter((x) => !r.steps[x]);
  const where = (x: (typeof totes)[number]) => (x.slotCode ? t('格位 {0}', x.slotCode) : x.status === 'PULLED' ? t('已取出（交付准备中）') : x.status === 'PICKED' ? t('拣完待暂存') : t('拣货车上'));
  const draft = (name: string) => t('{0}，您好：您最近在本店取走的订单里有「{1}」，这件商品被召回（{2}）。请不要食用，可以带回门店全额退款。给您带来不便，非常抱歉。', name, r.title, reasonOf(r.reason) || t('安全原因'));
  return (
    <section className="card recall">
      <div className="card-head">
        <span className="tag warn-tag">{t('召回')}</span>
        <span className="strong">{r.title}</span>
        <span className="due">{clock(r.openedAt)}</span>
      </div>
      <p className="note">
        {names.join('、')}
        {r.lots.length ? ` · ${t('批号 {0}', r.lots.join('、'))}` : ''}
        {r.reason ? ` · ${reasonOf(r.reason)}` : ''}
      </p>
      <p className="note">
        {r.lots.length && r.steps.SHELF ? t('货架已经下架这些批号：线上拣货可以照常拣货架上剩下的（别的批号）；货架上没有批次记录的商品，已经请补货员数一下剩下几件。') : t('线上拣货已经不能拣这些商品（按找不到处理：替代或缺货）；收银可以按接口拦截。')}
        {r.lots.length && !r.steps.SHELF ? ` ${t('只召回部分批号：货架下架打勾后，别的批号可以照常拣。')}` : ''}
      </p>
      <ul className="plain">
        {RECALL_STEPS.map((step) => (
          <li key={step}>
            <label className="toggle">
              <input type="checkbox" checked={!!r.steps[step]} disabled={(step === 'CUSTOMERS' || step === 'ORDERS') && !can} onChange={(e) => void run({ type: 'MarkRecallStep', recallId: r.id, step, done: e.target.checked }, { quiet: true })} />
              <span>
                {t(RECALL_STEP_TEXT[step])} <small className="muted">· {counts[step]}</small>
                {r.steps[step]?.auto && <small className="muted"> · {t('开启时已处理或没有要做的')}</small>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {totes.length > 0 && (
        <details open>
          <summary>{t('要拿出来的框（{0}）', totes.length)}</summary>
          <ul className="plain recall-totes">
            {totes.map((x) => (
              <li key={x.toteId}>
                <span className="mono">{x.shortCode}</span> · {where(x)} · {x.items.join('、')}
              </li>
            ))}
          </ul>
        </details>
      )}
      {r.affected.doneOrders.length > 0 && (
        <details>
          <summary>{t('顾客通知草稿（确认后再发）')}</summary>
          <ul className="plain">
            {r.affected.doneOrders.slice(0, 20).map((id) => {
              const o = done[id];
              const text = draft(o ? o.firstName : '');
              return (
                <li key={id}>
                  <span className="mono">{o?.shortCode ?? id}</span> {text}
                  <button className="link" onClick={() => void navigator.clipboard?.writeText(text).then(() => toast(t('已复制'), 'ok'))}>
                    {t('复制')}
                  </button>
                </li>
              );
            })}
          </ul>
        </details>
      )}
      {can && (
        <>
          {openSteps.length > 0 && <p className="note">{t('还有 {0} 步没做完，做完才能关闭', openSteps.length)}</p>}
          <button className="link" disabled={openSteps.length > 0} onClick={() => void run({ type: 'CloseRecall', recallId: r.id })}>
            {t('全部处理完，关闭召回')}
          </button>
        </>
      )}
    </section>
  );
}

function FoodSafetySection() {
  const { client, auth, run } = useLive();
  const can = canManageAi(client.statics as StoreStatic, auth.actor);
  const today = new Date();
  const [date, setDate] = useState(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`);
  const [log, setLog] = useState<FoodSafetyLog | undefined>();
  const [note, setNote] = useState('');
  useEffect(() => {
    void ai
      .foodSafety(auth, date)
      .then(setLog)
      .catch(() => undefined);
  }, [auth, date, client.version]);
  const defs = client.statics ? sensorsFor(client.statics) : [];
  const name = (id: string) => sensorName(defs.find((d) => d.id === id), id);
  if (!log) return null;
  const sm = log.summary;
  return (
    <>
      <h2 className="section-title">{t('食品安全记录')}</h2>
      <section className="card">
        <div className="actions">
          <input type="date" value={date} aria-label={t('日期')} onChange={(e) => setDate(e.target.value)} />
          {log.confirmed ? <span className="tag ok">{t('{0} 已确认', clock(log.confirmed.at))}</span> : <span className="tag">{t('未确认')}</span>}
        </div>
        <p>{t('{0} 台温控设备，{1} 台有越线；告警 {2} 次，已确认 {3} 次{4}；报修 {5} 张。', sm.sensors, sm.withExcursion, sm.alerts, sm.acked, sm.avgAckMin !== undefined ? t('（平均 {0} 分钟确认）', sm.avgAckMin) : '', sm.tickets)}</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('设备')}</th>
                <th>{t('最低 / 平均 / 最高（°C）')}</th>
                <th>{t('越线（分钟）')}</th>
              </tr>
            </thead>
            <tbody>
              {log.rows.map((r) => (
                <tr key={r.sensorId}>
                  <td>{name(r.sensorId)}</td>
                  <td className="mono">{r.readings ? `${r.min} / ${r.avg} / ${r.max}` : t('没有读数')}</td>
                  <td className={`mono ${r.minutesOut ? 'warn-text' : ''}`}>{r.minutesOut}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {log.alerts.length > 0 && (
          <ul className="plain">
            {log.alerts.map((a) => (
              <li key={a.id}>
                <span className="mono">{clock(a.raisedAt)}</span> {name(a.sensorId)} · {a.kind} · {a.severity}
                {a.ackAt !== undefined ? ` · ${t('{0} 确认（{1}）', clock(a.ackAt), a.ackBy ?? '')}` : ` · ${t('未确认')}`}
                {a.clearedAt !== undefined ? ` · ${t('{0} 解除', clock(a.clearedAt))}` : ''}
              </li>
            ))}
          </ul>
        )}
        {log.tickets.length > 0 && <p className="note">{t('报修：{0}', log.tickets.map((x) => `${name(x.sensorId)}${x.closedAt ? ` · ${t('已关单')}` : ''}`).join('；'))}</p>}
        {can && !log.confirmed && (
          <div className="actions">
            <input value={note} placeholder={t('说明（可选）')} aria-label={t('说明（可选）')} onChange={(e) => setNote(e.target.value)} />
            <button className="primary" onClick={() => void run({ type: 'ConfirmFoodSafetyLog', date, ...(note.trim() ? { note: note.trim() } : {}) })}>
              {t('确认这一天的记录')}
            </button>
          </div>
        )}
        <p className="note">{t('读数来自数字孪生的遥测（只保留最近一段）；确认后记进事件记录，可以随时导出检查。')}</p>
      </section>
    </>
  );
}
