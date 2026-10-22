import type { OpsCommand } from '@storewright/ops';
import { parseTopic, sensorCommand } from './sensing';

export interface MqttBridge {
  close(): Promise<void>;
}

/**
 * MQTT 入口：订阅所有门店的 state 主题，转换后交给 submit。
 * 需要 MQTT broker（例如 Mosquitto）；没有设置 MQTT_URL 时不启动。
 */
export async function startMqttBridge(url: string, submit: (storeId: string, cmd: Extract<OpsCommand, { type: 'RecordSensor' }>) => void, log: (msg: string) => void = () => undefined): Promise<MqttBridge> {
  const { connectAsync } = await import('mqtt');
  const client = await connectAsync(url, { clientId: `storewright-server-${Math.random().toString(16).slice(2, 8)}`, reconnectPeriod: 2000 });
  await client.subscribeAsync('storewright/v1/+/sense/+/+/+/state', { qos: 1 });
  client.on('message', (topic, buf) => {
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
