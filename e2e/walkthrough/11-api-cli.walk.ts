import { execSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { Recorder } from './recorder';
import { LIVE } from './helpers';

/** 接口与命令行：健康检查、权限、传感器与 POS 接入、标签（SVG / ZPL）、仿真与报告命令 */
test('11 接口与命令行', async ({ request }) => {
  const r = new Recorder('接口与命令行', 11);
  const api = (path: string) => `${LIVE}/api${path}`;
  let token = '';

  await r.step('健康检查：数据库类型、门店列表', async () => JSON.stringify(await (await request.get(api('/health'))).json()));
  await r.step('没有令牌读快照：401；不存在的门店：404；员工提交控制台命令：403', async () => {
    const a = (await request.get(api('/stores/demo/snapshot'))).status();
    const b = (await request.post(api('/stores/nowhere/session'), { data: { role: 'console' } })).status();
    const assoc = (await (await request.post(api('/stores/demo/session'), { data: { associateId: 'A01' } })).json()) as { token: string };
    const c = (await request.post(api('/stores/demo/commands'), { headers: { authorization: `Bearer ${assoc.token}` }, data: { cmd: { type: 'CancelOrder', orderId: 'x', reason: 'r' } } })).status();
    expect([a, b, c]).toEqual([401, 404, 403]);
    return `401 / 404 / 403`;
  });
  await r.step('传感器读数（货架传感原型的 JSON）和 POS 销售流水接入', async () => {
    const con = (await (await request.post(api('/stores/demo/session'), { data: { role: 'console' } })).json()) as { token: string };
    token = con.token;
    const snap = (await (await request.get(api('/stores/demo/snapshot'), { headers: { authorization: `Bearer ${token}` } })).json()) as { statics: { planogram: Array<{ itemId: string; locationId: string; sensor?: string }> } };
    const s = snap.statics.planogram.find((p) => p.sensor) ?? snap.statics.planogram[0]!;
    const sensor = await request.post(api('/stores/demo/sensors'), { data: { schema: 'storewright.shelf-sensing/0.1', position_id: s.locationId, sensor_type: s.sensor ?? 'tof', estimated_units: 3, confidence: 0.9, item_id: s.itemId } });
    const pos = await request.post(api('/stores/demo/pos/sales'), { data: { lines: [{ itemId: s.itemId, qty: 1 }] } });
    return `传感器：${sensor.status()} ${JSON.stringify(await sensor.json())}；POS：${pos.status()}`;
  });
  await r.step('暂存格位标签：SVG 预览与 ZPL（热敏打印机）', async () => {
    const svg = await request.get(api('/stores/demo/labels/slot/AMB-01-01-01.svg'));
    const zpl = await request.get(api('/stores/demo/labels/slot/AMB-01-01-01.zpl'));
    const z = await zpl.text();
    return `SVG ${svg.status()}（${(await svg.text()).length} 字节）；ZPL ${zpl.status()}：${z.split('\n').slice(0, 3).join(' ')}`;
  });

  const run = (cmd: string) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 });
  await r.step('命令行：仿真一天（家居建材店，默认档位）', async () => run('npx tsx apps/sim-cli/src/main.ts run --template hardware').split('\n').slice(0, 12).join('\n'));
  await r.step('命令行：基线与默认档位的对比实验（中型店，5 天）', async () => {
    const out = run('npx tsx apps/sim-cli/src/main.ts compare --template medium --reps 5 --out experiments/results/walkthrough/cli');
    return out.split('\n').filter((l) => /完成|报告/.test(l)).join('\n');
  });
  await r.step('命令行：行业迁移报告（快速版：每组 4 天、1 个种子）', async () => {
    const out = run('npx tsx apps/sim-cli/src/main.ts industry-report --reps 4 --seeds 1 --out experiments/results/walkthrough/cli');
    const i = out.indexOf('## 3.');
    return out.slice(i, i + 900);
  });
  void token;
  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
