import type { OpsCommand } from '@storewright/ops';

/**
 * 可插拔感知层（决策 R-01、R-03）：传感器读数统一成货架传感原型指南 7.9 节的 JSON
 * （schema `storewright.shelf-sensing/0.1`），HTTP 和 MQTT 两种入口进入同一个转换函数。
 *
 * MQTT 主题：storewright/v1/{store_id}/sense/{fixture_id}/{position_id}/{sensor_type}/state
 */

export const SENSOR_SCHEMA = 'storewright.shelf-sensing/0.1';

export interface SensorPayload {
  schema: string;
  store_id?: string;
  fixture_id?: string;
  position_id: string;
  device_id?: string;
  sensor_type: string;
  seq?: number;
  ts?: string;
  estimated_units: number;
  confidence: number;
  flags?: string[];
  /** 扩展字段：传感器装在哪个商品的通道上（一个货位有几个商品时用） */
  item_id?: string;
}

export type ParseResult = { ok: true; cmd: Extract<OpsCommand, { type: 'RecordSensor' }> } | { ok: false; error: string };

/** 校验并转换成命令；设备上报的异常标记（例如遮挡、传感器故障）按低置信度处理 */
export function sensorCommand(raw: unknown): ParseResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'not_an_object' };
  const p = raw as Partial<SensorPayload>;
  if (p.schema !== SENSOR_SCHEMA) return { ok: false, error: 'schema' };
  if (typeof p.position_id !== 'string' || !p.position_id) return { ok: false, error: 'position_id' };
  if (p.sensor_type !== 'tof' && p.sensor_type !== 'weight') return { ok: false, error: 'sensor_type' };
  if (typeof p.estimated_units !== 'number' || !Number.isFinite(p.estimated_units)) return { ok: false, error: 'estimated_units' };
  if (typeof p.confidence !== 'number' || !Number.isFinite(p.confidence)) return { ok: false, error: 'confidence' };
  const flagged = Array.isArray(p.flags) && p.flags.some((f) => /occlu|fault|error|stale/i.test(String(f)));
  const cmd: Extract<OpsCommand, { type: 'RecordSensor' }> = {
    type: 'RecordSensor',
    locationId: p.position_id.toUpperCase(),
    sensor: p.sensor_type,
    units: p.estimated_units,
    confidence: flagged ? Math.min(p.confidence, 0.2) : p.confidence,
  };
  if (typeof p.item_id === 'string' && p.item_id) cmd.itemId = p.item_id;
  return { ok: true, cmd };
}

/** 从 MQTT 主题里取门店和传感器类型；不是 state 主题时返回 undefined */
export function parseTopic(topic: string): { storeId: string; positionId: string; sensor: string } | undefined {
  const m = /^storewright\/v1\/([^/]+)\/sense\/([^/]+)\/([^/]+)\/([^/]+)\/state$/.exec(topic);
  if (!m) return undefined;
  return { storeId: m[1] as string, positionId: m[3] as string, sensor: m[4] as string };
}

/** 构造一条读数（传感器仿真和测试用），格式与原型设备一致 */
export function sensorPayload(storeId: string, positionId: string, sensor: 'tof' | 'weight', units: number, confidence: number, seq: number, itemId?: string): SensorPayload {
  const p: SensorPayload = {
    schema: SENSOR_SCHEMA,
    store_id: storeId,
    fixture_id: positionId.split('-').slice(0, 2).join('-'),
    position_id: positionId,
    device_id: `sim-${positionId}`,
    sensor_type: sensor,
    seq,
    ts: new Date().toISOString(),
    estimated_units: units,
    confidence,
    flags: [],
  };
  if (itemId) p.item_id = itemId;
  return p;
}
