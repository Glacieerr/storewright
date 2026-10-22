import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { LlmConfig } from './assistant';
import type { Db } from './db';
import { sqlStorage } from './eventStore';
import { Hub, type StoreEntry } from './hub';
import { startMqttBridge, type MqttBridge } from './mqttBridge';
import { nodePlatform } from './platform.node';

export { oversizedLabelData, toteLabelData } from './hub';

/**
 * HTTP + WebSocket 外壳：把 Fastify 的请求交给门店中枢（hub.ts），另外提供员工端静态文件和 MQTT 入口。
 * 接口说明见 hub.ts；浏览器内演示模式用同一个中枢（不经过这里）。
 */

export interface AppOptions {
  db: Db;
  /** 演示模式：允许控制台、查看者身份和演示接口 */
  demo: boolean;
  /** 非演示模式下控制台身份需要的密钥 */
  consoleKey?: string;
  /** 员工端构建产物目录（存在时从根路径提供） */
  staticDir?: string;
  storeIds?: string[];
  logger?: boolean;
  /** 提供时改用 HTTPS（本地演示的自签名证书，见 devTls.ts） */
  https?: { key: Buffer; cert: Buffer };
  /** 传感器与 POS 接入的密钥（演示模式下可以不设） */
  sensorKey?: string;
  /** MQTT broker 地址；设置时订阅传感器主题 */
  mqttUrl?: string;
  /** 排程：每隔 tickMs 发一次 Tick，每隔 releaseMs 生成一次拣货批次；0 表示不启动 */
  tickMs?: number;
  releaseMs?: number;
  /** 本地语言模型（OpenAI 兼容接口）；不设置时助手用模板模式 */
  llm?: LlmConfig;
}

export async function buildApp(opts: AppOptions): Promise<{ app: FastifyInstance; hub: Hub; stores: Map<string, StoreEntry>; close: () => Promise<void> }> {
  const app = Fastify({ logger: opts.logger ?? false, ...(opts.https ? { https: opts.https } : {}) });
  const hub = await Hub.create({
    storage: sqlStorage(opts.db),
    platform: nodePlatform,
    demo: opts.demo,
    ...(opts.consoleKey ? { consoleKey: opts.consoleKey } : {}),
    ...(opts.storeIds ? { storeIds: opts.storeIds } : {}),
    ...(opts.sensorKey ? { sensorKey: opts.sensorKey } : {}),
    ...(opts.tickMs ? { tickMs: opts.tickMs } : {}),
    ...(opts.releaseMs ? { releaseMs: opts.releaseMs } : {}),
    ...(opts.llm ? { llm: opts.llm } : {}),
    log: (level, msg) => (level === 'error' ? app.log.error(msg) : app.log.warn(msg)),
  });

  await app.register(cors, { origin: true });
  // 快照里有陈列表，压缩后小很多
  await app.register(websocket, { options: { perMessageDeflate: true } });

  // 实时推送
  app.get('/api/stores/:storeId/ws', { websocket: true }, async (socket, req) => {
    const q = req.query as { after?: string; token?: string };
    const send = (m: unknown) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(m));
    };
    const conn = await hub.connect((req.params as { storeId: string }).storeId, q.token, Number(q.after ?? 0), send);
    if (!conn) {
      socket.close(4401, 'unauthorized');
      return;
    }
    socket.on('message', (raw: Buffer) => conn.receive(String(raw)));
    socket.on('close', () => conn.close());
  });

  // 其他接口全部交给中枢
  const forward = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const url = new URL(req.url, 'http://local');
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
    const r = await hub.handle({ method: req.method, path: url.pathname, query, headers, body: req.body });
    reply.code(r.status);
    if (r.type) reply.type(r.type);
    return reply.send(r.body);
  };
  app.get('/api/*', forward);
  app.post('/api/*', forward);

  // 员工端静态文件（单页应用）
  if (opts.staticDir && existsSync(opts.staticDir)) {
    // 按请求查找文件（重新构建后不用重启）；页面路由回落到 index.html，缺失的静态资源返回 404
    await app.register(fastifyStatic, { root: opts.staticDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/assets/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found' });
    });
  }

  // MQTT 传感器入口
  let mqtt: MqttBridge | undefined;
  if (opts.mqttUrl) mqtt = await startMqttBridge(opts.mqttUrl, (storeId, cmd) => hub.submitSensor(storeId, cmd), (msg) => app.log.warn(msg));

  // 排程
  hub.start();

  return {
    app,
    hub,
    stores: hub.stores,
    close: async () => {
      hub.stop();
      await mqtt?.close();
      await app.close();
    },
  };
}
