import type { AlertImpact, EquipmentAlertKind } from '@storewright/ops';
import type { HealthIssue, SensorDef, SensorStatus } from '@storewright/twin';
import { t } from '../i18n';

/** 数字孪生的界面文字（决策记录 0016）：传感器名称、读数、状态、告警、健康度问题 */

export function sensorName(d: SensorDef): string {
  if (d.kind === 'DOOR' && d.anchor.type === 'DOCK') return t('卸货门 {0}', d.anchor.index + 1);
  if (d.kind === 'COUNT') return t('入口客流');
  if (d.anchor.type === 'AREA') {
    const k = d.anchor.areaKind;
    if (k === 'COOLER') return t('冷藏库');
    if (k === 'FREEZER') return t('冷冻库');
    if (k === 'HOT_HOLD') return t('熟食保温柜');
    const base = d.tempZone === 'FROZEN' ? t('暂存冷冻柜') : t('暂存冷藏柜');
    return k === 'STAGING_DELIVERY' ? t('{0}（配送）', base) : base;
  }
  return d.id;
}

export function sensorValueText(d: SensorDef, v: number): string {
  if (d.kind === 'TEMP') return `${v.toFixed(1)} °C`;
  if (d.kind === 'DOOR') return v >= 0.5 ? t('开') : t('关');
  return t('{0} 人', Math.round(v));
}

const STATUS_RAW: Record<SensorStatus, string> = { OK: '正常', WARN: '注意', ALARM: '告警', STALE: '离线', NO_DATA: '无数据' };
export function statusText(s: SensorStatus): string {
  return t(STATUS_RAW[s]);
}

/** 状态颜色（与交付看板一致：绿、黄、红、灰） */
export const STATUS_COLOR: Record<SensorStatus, string> = { OK: '#2f9e62', WARN: '#e0a020', ALARM: '#d64545', STALE: '#8a96a3', NO_DATA: '#8a96a3' };

const ALERT_RAW: Record<EquipmentAlertKind, string> = { TEMP_HIGH: '温度过高', TEMP_LOW: '温度过低', DOOR_OPEN: '卸货门长时间打开', SENSOR_OFFLINE: '传感器离线' };
export function alertText(k: EquipmentAlertKind): string {
  return t(ALERT_RAW[k]);
}

/** 告警的影响，一行字 */
export function impactText(i: AlertImpact): string {
  const parts: string[] = [];
  if (i.orders.length) parts.push(t('{0} 张订单的 {1} 个框', i.orders.length, i.totes));
  if (i.cases) parts.push(t('后仓 {0} 箱（{1} 件）', i.cases, i.units));
  if (i.moveTo.length) parts.push(t('可转移到 {0}', i.moveTo.join('、')));
  return parts.join(' · ');
}

const ISSUE_RAW: Record<HealthIssue, string> = {
  NO_EVENTS: '很久没有作业事件',
  DEVICES_OFFLINE: '员工设备都不在线',
  POS_SILENT: 'POS 流水中断',
  SENSORS_OFFLINE: '有传感器离线',
  ALARMS: '有设备告警',
  LOW_FIDELITY: '账实一致率偏低',
  AI_DRIFT: '有 AI 模型误差明显变大',
  AI_PAUSED: '有 AI 模型因为数据中断暂停',
};
export function issueText(i: HealthIssue): string {
  return t(ISSUE_RAW[i]);
}

/** 多久以前（秒、分钟、小时） */
export function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t('{0} 秒前', s);
  if (s < 3600) return t('{0} 分钟前', Math.floor(s / 60));
  return t('{0} 小时前', Math.floor(s / 3600));
}

export function hhmm(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
