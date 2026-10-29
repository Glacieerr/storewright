import { expect, type Page } from '@playwright/test';
import { Recorder } from './recorder';
import { SITE, test } from './helpers';

const app = (p: Page, fn: string) => p.evaluate(`(() => { const s = window.__sw.useApp.getState(); return (${fn})(s); })()`);
const look = async (p: Page, t: number, cam: readonly number[], tgt: readonly number[]) => {
  await p.evaluate(`(() => { const sw = window.__sw; sw.clock.playing = false; sw.setTime(${t}); const th = sw.three(); th.camera.position.set(${cam.join(',')}); th.controls.target.set(${tgt.join(',')}); th.controls.update(); })()`);
  await p.waitForTimeout(1800);
};
const settle = async (p: Page) => {
  await p.waitForTimeout(600);
  await expect.poll(async () => app(p, '(s) => s.status'), { timeout: 90_000 }).toBe('ready');
  await p.waitForTimeout(1200);
};
/** 等 AI 分析完（当前方案的结果） */
const analysed = async (p: Page) => {
  await expect.poll(async () => app(p, "(s) => s.status === 'ready' && s.aiAdvice.status === 'ready' && !s.aiAdvice.stale"), { timeout: 120_000 }).toBe(true);
  await p.waitForTimeout(800);
};
const hm = (t: number) => `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`;

/**
 * 学生兼职工、船只多少与 AI 建议（决策记录 0020）：学生只在自己的班次里在岗（上学日放学后最多 4 小时）；
 * 周边环境的船只可以调多，海湾里同时有好几条船；AI 建议按「做什么、为什么、预计效果、把握多大」列出，
 * 可以采纳（改动应用到方案、重新仿真、可以撤销）或忽略，有当天计划、交接班小结和采纳 / 不采纳对比。
 */
test('18 学生兼职工、船只与 AI 建议', async ({ browser }) => {
  const r = new Recorder('学生兼职工、船只与 AI 建议', 18);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', baseURL: SITE });
  const p = await ctx.newPage();
  await p.addInitScript(() => localStorage.setItem('storewright.tour.seen', '1'));
  await p.goto('/sim/?debug');
  await expect(p.getByText(/仿真用时/)).toBeVisible({ timeout: 60_000 });
  await p.getByRole('button', { name: '3D', exact: true }).click();
  await p.waitForTimeout(1500);

  await r.step('学生兼职工：在「实时数据」的特殊班组里打开，名单 6 人；上学日（周四）只有放学后能来，每人最多 4 小时，不是每天都来', async () => {
    await p.getByRole('group', { name: '学生兼职工' }).getByRole('button').first().click();
    await settle(p);
    const shifts = (await app(p, '(s) => s.timeline.students')) as Array<{ id: string; role: string; start: number; end: number }>;
    expect(shifts.length).toBeGreaterThan(0);
    for (const s of shifts) {
      expect(s.start).toBeGreaterThanOrEqual(16 * 3600);
      expect(s.end - s.start).toBeLessThanOrEqual(4 * 3600);
    }
    await p.getByRole('group', { name: '学生兼职工' }).scrollIntoViewIfNeeded();
    return `今天来 ${shifts.length} 人：${shifts.map((s) => `${s.id} ${s.role} ${hm(s.start)}–${hm(s.end)}`).join('、')}`;
  }, { shot: p, device: '电脑' });

  await r.step('傍晚的岗位排班：拣货、交付在全职人数之外多了学生；场景里学生穿着岗位色上衣和牛仔裤，选中后写明「学生兼职工」', async () => {
    const s0 = (await app(p, '(s) => s.timeline.students[0]')) as { id: string; role: string; start: number };
    await p.evaluate(`(() => { window.__sw.clock.playing = false; window.__sw.setTime(${s0.start + 1800}); })()`);
    await p.waitForTimeout(1200);
    await app(p, `(s) => s.select({ type: 'associate', id: '${s0.role}-${s0.id}' })`);
    await app(p, `(s) => s.setFollow('${s0.role}-${s0.id}')`);
    await p.waitForTimeout(2500);
    return `选中 ${s0.role}-${s0.id}`;
  }, { shot: p, device: '电脑' });

  await r.step('周六（不上学）：9:00–20:00 之间每人最多 6 小时，分三拨', async () => {
    await app(p, '(s) => s.setFollow(undefined)');
    await p.getByRole('group', { name: '星期' }).getByRole('button', { name: '周六', exact: true }).click();
    await settle(p);
    const shifts = (await app(p, '(s) => s.timeline.students')) as Array<{ id: string; start: number; end: number }>;
    for (const s of shifts) expect(s.end - s.start).toBeLessThanOrEqual(6 * 3600);
    await p.getByRole('group', { name: '星期' }).getByRole('button', { name: '周四', exact: true }).click();
    await settle(p);
    return shifts.map((s) => `${s.id} ${hm(s.start)}–${hm(s.end)}`).join('、');
  });

  await r.step('船只多少：编辑布局 → 周边环境 → 船只「多」；海湾里同时有停泊的钓鱼船和经过的帆船，出海水道进出分道', async () => {
    await p.getByRole('button', { name: '编辑布局', exact: true }).click();
    await p.getByLabel('船只多少').selectOption('many');
    await p.getByRole('button', { name: '完成编辑' }).first().click();
    await settle(p);
    await p.waitForTimeout(1500);
    // 同时在场地里的船最多的时刻
    const best = (await p.evaluate(`(() => {
      const sw = window.__sw; const st = { x: 0, z: 0, heading: 0 }; const f = Math.min(12, Math.max(1, sw.clock.speed / 8)); const minZ = sw.site.water.minZ;
      let best = { t: 12 * 3600, n: 0 };
      for (let t = 9 * 3600; t < 18 * 3600; t += 30) {
        let n = 0;
        for (const l of sw.boats) { if (t < l.start || t > l.start + l.path.duration * f) continue; l.path.at((t - l.start) / f, st); if (st.z > minZ + 2) n++; }
        if (n > best.n) best = { t, n };
      }
      const o = sw.site.water.outlet; return { ...best, x: o.bay.cx, z: o.bay.cz };
    })()`)) as { t: number; n: number; x: number; z: number };
    await look(p, best.t, [best.x + 34, 48, best.z + 74], [best.x, 0, best.z + 14]);
    return `${hm(best.t)}：海湾和水道里 ${best.n} 条船`;
  }, { shot: p, device: '电脑' });

  await r.step('AI 建议：打开标签后按当前方案分析（再看另外 3 天）；每条写清做什么、为什么、预计效果、把握多大；上面是今日计划', async () => {
    await p.getByRole('tab', { name: /AI 建议/ }).click();
    await analysed(p);
    const list = (await app(p, '(s) => s.aiAdvice.result.advice.map((a) => a.code)')) as string[];
    expect(list.length).toBeGreaterThan(2);
    await p.locator('.ai-plan').first().scrollIntoViewIfNeeded();
    return `${list.length} 条：${list.join('、')}`;
  }, { shot: p, device: '电脑' });

  await r.step('只看一个方向（到货与卸货场），点「定位」跳到那辆车进场前、镜头跟着它', async () => {
    const chip = p.getByRole('group', { name: '建议的方向' }).getByRole('button', { name: /到货与卸货场/ });
    await chip.click();
    const card = p.locator('.advice').first();
    await card.scrollIntoViewIfNeeded();
    const title = (await card.locator('h4').innerText()).trim();
    await card.getByRole('button', { name: '定位' }).click();
    await p.evaluate('window.__sw.clock.playing = true');
    await p.waitForTimeout(2500);
    await p.evaluate('window.__sw.clock.playing = false');
    return title;
  }, { shot: p, device: '电脑' });

  await r.step('采纳一条可以执行的建议：改动应用到方案上并重新仿真；「已采纳」里可以撤销', async () => {
    await p.getByRole('group', { name: '建议的方向' }).getByRole('button', { name: /^全部/ }).click();
    const btn = p.locator('.advice .advice-actions button.primary').first();
    await expect(btn).toBeVisible();
    const card = p.locator('.advice').filter({ has: p.locator('button.primary') }).first();
    const title = (await card.locator('h4').innerText()).trim();
    await btn.click();
    await analysed(p);
    const adopted = (await app(p, "(s) => s.aiLog.filter((e) => e.status === 'adopted').length")) as number;
    expect(adopted).toBe(1);
    await p.locator('ul.adopted').scrollIntoViewIfNeeded();
    return title;
  }, { shot: p, device: '电脑' });

  await r.step('采纳 / 不采纳对比：同一天按两组设置各跑一遍，比较订单、等待、卸货场、溢流、补货、暂存、工时和经营账', async () => {
    await p.getByRole('button', { name: /对比已采纳的/ }).click();
    await expect(p.locator('.ai-panel table.cmp')).toBeVisible({ timeout: 120_000 });
    await p.locator('.ai-panel table.cmp').scrollIntoViewIfNeeded();
    return (await p.locator('.ai-panel table.cmp').innerText()).split('\n').slice(0, 14).join(' · ');
  }, { shot: p, device: '电脑' });

  await r.step('忽略一条建议并选原因（作为反馈记在本机）；交接班小结（15:00）：做完了什么、还没做完的、出过的问题、下一班要注意的', async () => {
    const card = p.locator('.advice').filter({ has: p.getByRole('button', { name: '忽略' }) }).first();
    await card.getByRole('button', { name: '忽略' }).click();
    await card.getByRole('group', { name: '忽略的原因' }).getByRole('button', { name: '现场情况不一样' }).click();
    const fb = (await app(p, '(s) => s.aiFeedback.dismissed')) as number;
    expect(fb).toBeGreaterThan(0);
    const handoff = p.locator('details.ai-plan').nth(1);
    await handoff.locator('summary').click();
    await handoff.getByRole('button', { name: '15:00' }).click();
    await handoff.scrollIntoViewIfNeeded();
    return (await handoff.innerText()).split('\n').slice(0, 12).join(' · ');
  }, { shot: p, device: '电脑' });
  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
