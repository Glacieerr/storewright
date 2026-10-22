import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { openDb } from './db';
import { devCert } from './devTls';

/**
 * 启动后端：
 *   npm run server                       # 嵌入式 PGlite，数据在 apps/server/.data
 *   DATABASE_URL=postgres://… npm run server
 *   HTTPS=1 npm run server               # 自签名证书，手机在局域网里也能用摄像头扫码
 * 环境变量：PORT（默认 8787）、HOST（默认 0.0.0.0，手机可以通过局域网 IP 访问）、DEMO（默认 1）、
 * CONSOLE_KEY（非演示模式下控制台密钥）、TICK_MS（默认 15000）、RELEASE_MS（演示默认 60000，否则 600000）、
 * HTTPS（默认 0；1 时证书保存在 apps/server/.data/tls）、SENSOR_KEY（传感器 / POS 接入密钥）、MQTT_URL（订阅传感器主题，例如 mqtt://localhost:1883）、
 * LLM_URL + LLM_MODEL（本地语言模型的 OpenAI 兼容地址与模型名，例如 http://127.0.0.1:11434/v1；不设置时助手用模板模式）、LLM_KEY（可选）。
 */
const here = dirname(fileURLToPath(import.meta.url));
const demo = process.env.DEMO !== '0';
const dataDir = process.env.DATA_DIR ?? join(here, '../.data');
const db = await openDb(process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : { dataDir });
// 证书放在 PGlite 已初始化的数据目录里（PGlite 不能在非空目录中初始化，所以用外部数据库时放到系统临时目录）
const tls = process.env.HTTPS === '1' ? devCert(db.kind === 'pglite' ? join(dataDir, 'tls') : join(tmpdir(), 'storewright-tls')) : undefined;
const { app, close } = await buildApp({
  db,
  demo,
  ...(process.env.CONSOLE_KEY ? { consoleKey: process.env.CONSOLE_KEY } : {}),
  ...(tls ? { https: { key: tls.key, cert: tls.cert } } : {}),
  ...(process.env.SENSOR_KEY ? { sensorKey: process.env.SENSOR_KEY } : {}),
  ...(process.env.MQTT_URL ? { mqttUrl: process.env.MQTT_URL } : {}),
  staticDir: join(here, '../../associate/dist'),
  // 门店编号列表（逗号分隔），例如 STORES=demo,hardware 同时运行中型超市和家居建材店
  ...(process.env.STORES ? { storeIds: process.env.STORES.split(',').map((x) => x.trim()).filter(Boolean) } : {}),
  logger: process.env.LOG === '1',
  tickMs: Number(process.env.TICK_MS ?? 15_000),
  releaseMs: Number(process.env.RELEASE_MS ?? (demo ? 60_000 : 600_000)),
  ...(process.env.LLM_URL && process.env.LLM_MODEL ? { llm: { url: process.env.LLM_URL, model: process.env.LLM_MODEL, ...(process.env.LLM_KEY ? { apiKey: process.env.LLM_KEY } : {}) } } : {}),
});
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';
await app.listen({ port, host });
const scheme = tls ? 'https' : 'http';
console.log(`Storewright server on ${scheme}://localhost:${port} (${db.kind}${demo ? ', demo' : ''})`);
if (tls) {
  if (host === '0.0.0.0' || host === '::') for (const ip of tls.lan) console.log(`  same Wi-Fi: https://${ip}:${port}`);
  console.log(`  Self-signed certificate${tls.created ? ' (new)' : ''}: each phone or browser must accept the warning once, then the camera scanner works.`);
}

const stop = async () => {
  await close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
