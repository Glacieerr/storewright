import type { OpsCommand } from '@storewright/ops';
import { parseTopic, sensorCommand } from './sensing';

export interface MqttBridge {
  close(): Promise<void>;
}

/** 设备遥测主题（决策记录 0016）：storewright/v1/{store_id}/twin/{sensor_id}/state，内容 {"value": 3.2, "ts": "…"} */
export function parseTwinTopic(topic: string): { storeId: string; sensorId: string } | undefined {
  const m = /^storewright\/v1\/([^/]+)\/twin\/([^/]+)\/state$/.exec(topic);
  return m ? { storeId: m[1] as string, sensorId: m[2] as string } : undefined;
}

/**
 * MQTT 入口：订阅所有门店的货架传感（sense）和设备遥测（twin）主题，转换后交给 submit / telemetry。
 * 需要 MQTT broker（例如 Mosquitto）；没有设置 MQTT_URL 时不启动。
 */
export async function startMqttBridge(
  url: string,
  submit: (storeId: string, cmd: Extract<OpsCommand, { type: 'RecordSensor' }>) => void,
  log: (msg: string) => void = () => undefined,
  telemetry?: (storeId: string, reading: { sensorId: string; value: number; at: number }) => void,
): Promise<MqttBridge> {
  const { connectAsync } = await import('mqtt');
  const client = await connectAsync(url, { clientId: `storewright-server-${Math.random().toString(16).slice(2, 8)}`, reconnectPeriod: 2000 });
  await client.subscribeAsync('storewright/v1/+/sense/+/+/+/state', { qos: 1 });
  if (telemetry) await client.subscribeAsync('storewright/v1/+/twin/+/state', { qos: 0 });
  client.on('message', (topic, buf) => {
    const tw = telemetry ? parseTwinTopic(topic) : undefined;
    if (tw && telemetry) {
      try {
        const j = JSON.parse(buf.toString('utf8')) as { value?: unknown; ts?: unknown };
        const at = typeof j.ts === 'string' ? Date.parse(j.ts) : Number(j.ts ?? Date.now());
        telemetry(tw.storeId, { sensorId: tw.sensorId, value: Number(j.value), at: Number.isFinite(at) ? at : Date.now() });
      } catch {
        log(`mqtt: bad json on ${topic}`);
      }
      return;
    }
    const t = parseTopic(topic);
    if (!t) return;
    let json: unknown;
    try {
      json = JSON.parse(buf.toString('utf8'));
    } catch {
      return log(`mqtt: bad json on ${topic}`);
    }
    const r = sensorCommand(json);
    if (!r.ok) return log(`mqtt: ${r.error} on ${topic}`);
    submit(t.storeId, r.cmd);
  });
  return { close: () => client.endAsync() };
}
