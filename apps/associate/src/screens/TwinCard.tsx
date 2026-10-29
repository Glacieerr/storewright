import { useState } from 'react';
import { activeAlerts, MAINTENANCE_FAULTS, rolesForSensor, type AlertImpact, type AssociateRole, type EquipmentAlert, type EquipmentAlertKind, type MaintenanceFault } from '@storewright/ops';
import { currentImpact, sensorsFor, slotsOf, type SensorDef, type SensorStatus, type TwinFrame } from '@storewright/twin';
import { demo } from '../api';
import { clock, t } from '../i18n';
import { useIntent } from '../nav';
import { useLive } from '../live';
import { toast } from '../ui/Toasts';

/**
 * 数字孪生在员工端（决策记录 0016）：
 * - 控制台的「设备与告警」：设备读数（订阅了孪生推送）、未解除的告警和影响、确认；演示门店可以制造故障；
 * - 员工手机顶部的告警条：带班负责人看到全部并可以确认，后仓看到冷库和卸货门，暂存和交付看到暂存冷柜。
 */

export function sensorName(d: SensorDef | undefined, id: string): string {
  if (!d) return id;
  if (d.kind === 'DOOR' && d.anchor.type === 'DOCK') return t('卸货门 {0}', d.anchor.index + 1);
  if (d.kind === 'COUNT') return t('入口客流');
  if (d.anchor.type === 'AREA') {
    const k = d.anchor.areaKind;
    if (k === 'COOLER') return t('冷藏库');
    if (k === 'FREEZER') return t('冷冻库');
    if (k === 'HOT_HOLD') return t('熟食保温柜');
    return d.tempZone === 'FROZEN' ? t('暂存冷冻柜') : t('暂存冷藏柜');
  }
  return id;
}

function valueText(d: SensorDef | undefined, v: number): string {
  if (!d || d.kind === 'TEMP') return `${v.toFixed(1)} °C`;
  if (d.kind === 'DOOR') return v >= 0.5 ? t('开') : t('关');
  return t('{0} 人', Math.round(v));
}

const STATUS_TEXT: Record<SensorStatus, string> = { OK: '正常', WARN: '注意', ALARM: '告警', STALE: '离线', NO_DATA: '无数据' };
export const ALERT_TEXT: Record<EquipmentAlertKind, string> = { TEMP_HIGH: '温度过高', TEMP_LOW: '温度过低', DOOR_OPEN: '卸货门长时间打开', SENSOR_OFFLINE: '传感器离线' };

function impactText(i: AlertImpact, shortCode: (orderId: string) => string): string {
  const parts: string[] = [];
  if (i.orders.length) parts.push(t('影响订单 {0}（{1} 个框）', i.orders.slice(0, 5).map(shortCode).join('、') + (i.orders.length > 5 ? '…' : ''), i.totes));
  if (i.cases) parts.push(t('后仓 {0} 箱（{1} 件）', i.cases, i.units));
  if (i.moveTo.length) parts.push(t('同温区有空位：{0}', i.moveTo.join('、')));
  return parts.join(' · ');
}

/** 处理建议 */
function tipFor(a: EquipmentAlert, i: AlertImpact): string {
  if (a.kind === 'TEMP_HIGH' || a.kind === 'TEMP_LOW') return i.totes ? t('把受影响的框转移到同温区的其他格位，交付前检查商品温度。') : t('检查设备和门是否关好，必要时把商品转移到其他冷库。');
  if (a.kind === 'DOOR_OPEN') return t('没有收货作业时关上卸货门。');
  return t('检查传感器的电源和网络。');
}

/** 一条告警：设备、读数、影响、建议、确认 */
function AlertRow({ a, defs, canAck, canRepair, current, onAcked }: { a: EquipmentAlert; defs: readonly SensorDef[]; canAck: boolean; canRepair?: boolean; current?: number; onAcked?: () => void }) {
  const { client, run, nameOf } = useLive();
  // 带班负责人在手机上报修（决策记录 0026）：这台设备管着的暂存格位暂停放新框
  const ticket = Object.values(client.state.tickets ?? {}).find((x) => x.sensorId === a.sensorId && x.status === 'OPEN');
  const d = defs.find((x) => x.id === a.sensorId);
  const shortCode = (id: string) => client.state.orders[id]?.shortCode ?? id;
  const impact = client.statics ? currentImpact(client.state, client.statics, a, defs) : a.impact;
  const tip = tipFor(a, impact);
  return (
    <li className={`twin-alert ${a.severity === 'ALARM' ? 'alarm' : 'warn'}`}>
      <div className="row-head">
        <b>
          {sensorName(d, a.sensorId)} · {t(ALERT_TEXT[a.kind])}
        </b>
        {a.kind !== 'SENSOR_OFFLINE' && (
          <span className="mono">{current !== undefined ? t('{0}（触发时 {1}）', valueText(d, current), valueText(d, a.value)) : t('触发时 {0}', valueText(d, a.value))}</span>
        )}
      </div>
      <p className="note">
        {t('{0} 起', clock(a.since))}
        {impactText(impact, shortCode) ? ` · ${impactText(impact, shortCode)}` : ''}
      </p>
      <p className="note">{tip}</p>
      {a.status === 'ACKED' ? (
        <p className="note ok-text">{t('{0} 已确认，正在处理', nameOf(a.ackBy))}</p>
      ) : canAck ? (
        <button
          className="primary"
          onClick={async () => {
            if (await run({ type: 'AcknowledgeAlert', alertId: a.id })) onAcked?.();
          }}
        >
          {t('确认，我来处理')}
        </button>
      ) : (
        <p className="note">{t('等待负责的同事确认')}</p>
      )}
      {canRepair &&
        a.kind !== 'SENSOR_OFFLINE' &&
        (ticket ? (
          <p className="note">{t('已报修（{0}）', clock(ticket.openedAt))}</p>
        ) : (
          <button
            className="link"
            onClick={() => {
              const d = defs.find((x) => x.id === a.sensorId);
              void run({ type: 'RequestMaintenance', sensorId: a.sensorId, ...(d && client.statics ? { slots: slotsOf(d, client.statics) } : {}) });
            }}
          >
            {t('报修')}
          </button>
        ))}
    </li>
  );
}

type FaultMode = 'OFFLINE' | 'DEGRADE' | 'SEAL' | 'STUCK';
const FAULTS: Array<{ target: string; label: string; mode?: FaultMode }> = [
  { target: 'STAGING_CHILLED', label: '暂存冷藏柜故障' },
  { target: 'STAGING_FROZEN', label: '暂存冷冻柜故障' },
  { target: 'COOLER', label: '冷藏库故障' },
  { target: 'DOOR', label: '卸货门没关' },
  { target: 'ANY_SENSOR', label: '传感器断线', mode: 'OFFLINE' },
];
/** 慢性故障（决策记录 0022）：看预测性维护能不能在越线之前发现 */
const SLOW_FAULTS: Array<{ target: string; label: string; mode: FaultMode }> = [
  { target: 'STAGING_CHILLED', label: '暂存冷藏柜制冷慢慢变差', mode: 'DEGRADE' },
  { target: 'COOLER', label: '冷藏库门封漏气', mode: 'SEAL' },
  { target: 'STAGING_FROZEN', label: '暂存冷冻柜读数卡住', mode: 'STUCK' },
];
export const HEALTH_TEXT: Record<string, string> = { OK: '正常', WATCH: '留意', RISK: '在变坏', STUCK: '读数卡住' };
export const FAULT_TEXT: Record<MaintenanceFault, string> = { COMPRESSOR: '压缩机', DOOR_SEAL: '门封', SENSOR: '传感器', DEFROST: '除霜', OTHER: '其他', NONE: '没发现问题' };

/** 设备健康的一句话：状态 + 预计多久越线（预测性维护，决策记录 0022） */
export function healthText(h: { s: string; eta?: number; slope?: number } | undefined): string {
  if (!h || h.s === 'OK') return '';
  if (h.s === 'STUCK') return t('读数卡住：传感器可能坏了');
  if (h.s === 'RISK') return t('在变坏：底线温度每小时 +{0} °C，约 {1} 分钟后越过告警线', h.slope ?? 0, h.eta ?? 0);
  return h.slope !== undefined && h.slope > 0 ? t('留意：底线温度每小时 +{0} °C', h.slope) : t('留意：开门后回温变慢');
}

/** 控制台的「设备与告警」 */
export function TwinCard() {
  const { client, auth } = useLive();
  const [busy, setBusy] = useState(false);
  const defs = client.statics ? sensorsFor(client.statics) : [];
  const frame = client.twinFrame as TwinFrame | undefined;
  const alerts = activeAlerts(client.state);
  const faults = frame?.faults ?? [];
  const fault = async (target: string, mode?: FaultMode) => {
    setBusy(true);
    try {
      const r = await demo.fault(auth, { target, ...(mode ? { mode } : {}) });
      if (r.ok && r.sensorId) toast(mode === 'DEGRADE' || mode === 'SEAL' || mode === 'STUCK' ? t('已模拟慢性故障：{0}。看 AI 能不能在越线之前发出报修建议。', sensorName(defs.find((d) => d.id === r.sensorId), r.sensorId)) : t('已模拟故障：{0}。告警会在越线后出现。', sensorName(defs.find((d) => d.id === r.sensorId), r.sensorId)), 'ok');
      else toast(t('没有可以模拟这个故障的设备'), 'error');
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const repair = async () => {
    setBusy(true);
    try {
      await demo.fault(auth, { target: 'ALL', on: false });
      toast(t('已修复全部故障，读数恢复后告警自动解除'), 'ok');
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card twin-card">
      <div className="row-head">
        <h2 className="section-title">{t('设备与告警')}</h2>
        {frame && <span className={`pill ${frame.health.score >= 85 ? 'ok' : ''}`}>{t('孪生健康度 {0}', frame.health.score)}</span>}
      </div>
      <p className="note">{t('数字孪生的设备层：冷库和暂存冷柜的温度、卸货门、入口客流。越线时告警写进事件流，推到带班负责人的手机上，三维孪生里对应的区域闪红。')}</p>
      {alerts.length > 0 && (
        <ul className="twin-alerts">
          {alerts.map((a) => {
            const v = frame?.sensors.find((x) => x.id === a.sensorId)?.v;
            return <AlertRow key={a.id} a={a} defs={defs} canAck canRepair {...(v !== undefined ? { current: v } : {})} />;
          })}
        </ul>
      )}
      <ul className="twin-readings">
        {defs.map((d) => {
          const x = frame?.sensors.find((y) => y.id === d.id);
          const status = x?.s ?? 'NO_DATA';
          const h = frame?.equipment?.find((y) => y.id === d.id);
          return (
            <li key={d.id} className={`s-${status.toLowerCase()}${h && h.s !== 'OK' ? ` h-${h.s.toLowerCase()}` : ''}`}>
              <span>{sensorName(d, d.id)}</span>
              <b className="mono">{x ? valueText(d, x.v) : '—'}</b>
              <small>
                {t(STATUS_TEXT[status])}
                {faults.includes(d.id) ? ` · ${t('故障中')}` : ''}
                {h && h.s !== 'OK' ? ` · ${healthText(h)}` : ''}
              </small>
            </li>
          );
        })}
      </ul>
      {!frame && <p className="muted">{t('正在接收设备读数…')}</p>}
      <div className="actions">
        {FAULTS.map((f) => (
          <button key={f.target} disabled={busy} onClick={() => void fault(f.target, f.mode)}>
            {t(f.label)}
          </button>
        ))}
        <button className="primary" disabled={busy || !faults.length} onClick={() => void repair()}>
          {t('全部修复')}
        </button>
      </div>
      <p className="note">{t('慢性故障（预测性维护）：设备慢慢变坏，看 AI 能不能在越线、告警之前发出报修建议。')}</p>
      <div className="actions">
        {SLOW_FAULTS.map((f) => (
          <button key={f.target + f.mode} disabled={busy} onClick={() => void fault(f.target, f.mode)}>
            {t(f.label)}
          </button>
        ))}
      </div>
      <Tickets defs={defs} />
    </section>
  );
}

/** 报修单（预测性维护，决策记录 0022 · E1）：修好后关单，选实际故障（以后评估预测的标签） */
export function Tickets({ defs }: { defs: readonly SensorDef[] }) {
  const { client, run } = useLive();
  const [fault, setFault] = useState<MaintenanceFault>('COMPRESSOR');
  const open = Object.values(client.state.tickets ?? {}).filter((x) => x.status === 'OPEN');
  if (!open.length) return null;
  return (
    <div className="tickets">
      <h3 className="ai-sub">{t('报修单')}</h3>
      <ul className="plain">
        {open.map((x) => (
          <li key={x.id}>
            <b>{sensorName(defs.find((d) => d.id === x.sensorId), x.sensorId)}</b> · {clock(x.openedAt)} · {x.reason === 'MANUAL' ? t('人工报修') : x.reason === 'STUCK' ? t('AI：读数卡住') : t('AI：预计会越线')}
            {x.slots.length > 0 && <span className="muted"> · {t('{0} 个格位暂停放新框', x.slots.length)}</span>}
            <div className="actions">
              <select value={fault} onChange={(e) => setFault(e.target.value as MaintenanceFault)} aria-label={t('实际故障')}>
                {MAINTENANCE_FAULTS.map((f) => (
                  <option key={f} value={f}>
                    {t(FAULT_TEXT[f])}
                  </option>
                ))}
              </select>
              <button onClick={() => void run({ type: 'CloseMaintenance', ticketId: x.id, fault })}>{t('修好了，关单')}</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 告警解除以后报修单还开着（或 AI 没有告警就开了报修单）：带班负责人在手机顶部关单（写操作指南时发现，以前只能去控制台关）。
 * 单独一个组件：从告警条切过来时总是先收起，不沿用告警条的展开状态。
 */
function TicketsBanner({ defs }: { defs: readonly SensorDef[] }) {
  const { client } = useLive();
  const [open, setOpen] = useState(false);
  const count = Object.values(client.state.tickets ?? {}).filter((x) => x.status === 'OPEN').length;
  if (!count) return null;
  return (
    <div className="alert-banner warn" role="status">
      <button className="alert-banner-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <b>{t('报修单（{0}）', count)}</b>
        <span>{t('修好后在这里关单')}</span>
      </button>
      {open && <Tickets defs={defs} />}
    </div>
  );
}

/** 员工手机顶部的告警条 */
export function AlertBanner({ rosterRole, role }: { rosterRole?: AssociateRole; role?: AssociateRole }) {
  const { client } = useLive();
  const [open, setOpen] = useState(false);
  // 提醒里的告警点「去处理」：展开告警条（决策记录 0026）
  useIntent('alert', () => setOpen(true));
  const defs = client.statics ? sensorsFor(client.statics) : [];
  const lead = rosterRole === 'LEAD';
  // 负责这台设备的岗位也能确认（决策记录 0026：以前只有带班负责人，真正去处理的后仓员工不能确认）
  const responsible = (a: EquipmentAlert) => !!role && rolesForSensor(a.sensorId).includes(role);
  const mine = activeAlerts(client.state).filter((a) => {
    if (lead) return true;
    // 和提醒发给谁一致（流程梳理发现，决策记录 0025：以前补货员、熟食收到提醒却看不到告警条）
    if (!role || !rolesForSensor(a.sensorId).includes(role)) return false;
    // 暂存冷柜：里面有框时才打扰暂存、交付
    if (role === 'STAGE' || role === 'HANDOFF') return (a.kind === 'TEMP_HIGH' || a.kind === 'TEMP_LOW') && !!client.statics && currentImpact(client.state, client.statics, a, defs).totes > 0;
    return true;
  });
  if (!mine.length) return lead ? <TicketsBanner defs={defs} /> : null;
  const first = mine[0] as EquipmentAlert;
  const waiting = mine.filter((a) => a.status === 'ACTIVE').length;
  const tickets = lead ? Object.values(client.state.tickets ?? {}).filter((x) => x.status === 'OPEN') : [];
  return (
    <div className={`alert-banner ${first.severity === 'ALARM' ? 'alarm' : 'warn'}`} role="alert">
      <button className="alert-banner-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <b>
          {t('设备告警')} · {sensorName(defs.find((d) => d.id === first.sensorId), first.sensorId)} · {t(ALERT_TEXT[first.kind])}
        </b>
        <span>{[mine.length > 1 ? t('共 {0} 条', mine.length) : '', waiting ? t('{0} 条待确认', waiting) : t('已确认，正在处理')].filter(Boolean).join(' · ')}</span>
      </button>
      {open && (
        <ul className="twin-alerts">
          {mine.map((a) => (
            // 都确认了就收起横幅（小屏幕上一直展开会挡住页面）
            <AlertRow key={a.id} a={a} defs={defs} canAck={lead || responsible(a)} canRepair={lead} onAcked={() => waiting <= 1 && setOpen(false)} />
          ))}
        </ul>
      )}
      {open && tickets.length > 0 && <Tickets defs={defs} />}
    </div>
  );
}
