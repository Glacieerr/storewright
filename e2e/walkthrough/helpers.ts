import { expect, test as base, type Browser, type Locator, type Page } from '@playwright/test';
import { device, DESK, PHONE } from './recorder';

/**
 * 走查用的 test：每一节走完关掉这一节打开的所有浏览器上下文。各节都用 browser.newContext() 自己开页面，
 * 不关的话前面几节的模拟器（三维画面，无界面的 Chrome 用软件渲染）一直在后台渲染，拖慢后面的节直到超时。
 */
export const test = base.extend<{ closeContexts: void }>({
  closeContexts: [
    async ({ browser }, use) => {
      await use();
      await Promise.all(browser.contexts().map((c) => c.close().catch(() => undefined)));
    },
    { auto: true },
  ],
});

export const LIVE = 'http://127.0.0.1:8798';
export const SITE = 'http://127.0.0.1:4178';

// 页面里的实时状态（?debug 时 LiveClient 挂在 window.__swa）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyState = any;

export async function state(p: Page): Promise<AnyState> {
  return p.evaluate(() => (window as unknown as { __swa: { state: unknown } }).__swa.state);
}
export async function statics(p: Page): Promise<AnyState> {
  return p.evaluate(() => (window as unknown as { __swa: { statics: unknown } }).__swa.statics);
}

/** 打开员工端并以某个身份登录（名单上的名字，或 console） */
export async function signIn(browser: Browser, who: string, opts: { store?: string; desk?: boolean; locale?: string } = {}): Promise<Page> {
  const p = await device(browser, LIVE, { viewport: opts.desk || who === 'console' ? DESK : PHONE, ...(opts.locale ? { locale: opts.locale } : {}) });
  await p.goto('/?debug');
  if (opts.store && opts.store !== 'demo') {
    await p.getByLabel('门店').fill(opts.store);
    await p.waitForTimeout(800);
  }
  if (who === 'console') await p.getByRole('button', { name: /演示控制台/ }).click();
  else await p.getByRole('button', { name: new RegExp(who) }).click();
  await expect(p.locator('.link-state.live')).toBeVisible({ timeout: 60_000 });
  return p;
}

export async function scan(p: Page, label: string, code: string): Promise<void> {
  const box = p.getByLabel(label, { exact: true });
  await box.fill(code);
  await box.press('Enter');
}

/** 采纳一张 AI 建议；涉及人、钱、顾客的动作还要点「确认执行」（决策记录 0026） */
export async function accept(card: Locator): Promise<void> {
  await card.getByRole('button', { name: '采纳' }).click();
  const confirm = card.getByRole('button', { name: '确认执行' });
  if (await confirm.waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false)) await confirm.click();
}

/** 补货：领取的整批先取箱（演示：点每一行代替扫箱子），再按货位逐个扫描货位标签上架（决策记录 0026）；返回完成的任务数 */
export async function restockClaimed(p: Page): Promise<number> {
  const claimed = Object.values((await state(p)).repl as Record<string, AnyState>).filter((x) => x.status === 'CLAIMED');
  for (let i = 0; i < claimed.length; i++) {
    const row = p.locator('.batch-cases .row-btn:not([disabled])').first();
    if (!(await row.count())) break;
    await row.click();
  }
  let done = 0;
  for (const x of claimed) {
    await scan(p, '扫描箱子或货位标签', x.locationId);
    const btn = p.getByRole('button', { name: '完成上架' });
    if (!(await btn.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false))) continue;
    await btn.click();
    await expect.poll(async () => (await state(p)).repl[x.id]?.status).not.toBe('CLAIMED');
    done++;
  }
  return done;
}

export async function tab(p: Page, name: string): Promise<void> {
  await p.locator('.tabbar button').filter({ hasText: name }).click();
}

/** 等到条件为真（读页面实时状态） */
export async function until(p: Page, fn: (s: AnyState) => boolean, timeout = 20_000): Promise<void> {
  await expect.poll(async () => fn(await state(p)), { timeout }).toBe(true);
}

/** 控制台下单，返回订单号、短号、验证码 */
export async function createOrders(consolePage: Page, opts: { type?: 'PICKUP' | 'DELIVERY'; count?: number; lines?: number; mto?: boolean; big?: boolean; release?: boolean } = {}): Promise<Array<{ orderId: string; shortCode: string; code: string; name: string }>> {
  await consolePage.getByRole('tab', { name: '演示控制台' }).click();
  const form = consolePage.locator('.card', { hasText: '创建测试订单' });
  await form.getByLabel('类型').selectOption(opts.type === 'DELIVERY' ? 'DELIVERY' : 'PICKUP');
  await form.getByLabel('张数').fill(String(opts.count ?? 1));
  await form.getByLabel('每单最多商品行').fill(String(opts.lines ?? 4));
  const setBox = async (label: string, on: boolean) => {
    const box = form.getByLabel(label);
    if ((await box.count()) && (await box.isChecked()) !== on) await box.click();
  };
  await setBox('立即锁单并生成拣货批次', opts.release ?? true);
  await setBox('每单加一份熟食现做', !!opts.mto);
  await setBox('每单加一件大件（2 件）', !!opts.big);
  const [res] = await Promise.all([consolePage.waitForResponse((r) => r.url().endsWith('/demo/orders')), form.getByRole('button', { name: '创建', exact: true }).click()]);
  return ((await res.json()) as { orders: Array<{ orderId: string; shortCode: string; code: string; name: string }> }).orders;
}

/** 拣完包含这些订单的全部批次（扫框标签绑定、逐行「已拣到」），返回拣货行数 */
export async function pickOrders(picker: Page, orderIds: string[], opts: { onRow?: (row: number) => Promise<boolean> } = {}): Promise<number> {
  let rows = 0;
  for (let guard = 0; guard < 8; guard++) {
    const s = await state(picker);
    const walk = Object.values(s.walks as Record<string, AnyState>).find((w) => w.status === 'OPEN' && w.toteIds.some((id: string) => orderIds.includes(s.totes[id]?.orderId)));
    if (!walk) break;
    await tab(picker, '拣货');
    await picker.locator('.card', { hasText: walk.id }).getByRole('button', { name: '领取这个批次' }).click();
    for (const id of walk.toteIds) await scan(picker, '扫描框上的标签', s.totes[id]?.labelId ?? '');
    const picked = async () => Number(/已拣 (\d+)/.exec(await picker.locator('main').innerText())?.[1] ?? 0);
    for (let i = 0; i < 60 && !(await picker.getByRole('button', { name: '完成拣货，去暂存' }).isVisible()); i++) {
      if (opts.onRow && (await opts.onRow(rows))) {
        rows++;
        continue;
      }
      const before = await picked();
      await picker.getByRole('button', { name: /^已拣到/ }).click();
      await expect.poll(async () => (await picker.getByRole('button', { name: '完成拣货，去暂存' }).isVisible()) || (await picked()) > before).toBe(true);
      rows++;
    }
    await picker.getByRole('button', { name: '完成拣货，去暂存' }).click();
  }
  return rows;
}

/** 暂存这些订单的全部已拣框（扫框标签，点第一个建议格位） */
export async function stageOrders(stager: Page, orderIds: string[]): Promise<string[]> {
  await tab(stager, '暂存');
  await until(stager, (s) => Object.values(s.totes as Record<string, AnyState>).some((t) => orderIds.includes(t.orderId) && t.status === 'PICKED'));
  const slots: string[] = [];
  const s = await state(stager);
  for (const t of Object.values(s.totes as Record<string, AnyState>).filter((x) => orderIds.includes(x.orderId) && x.status === 'PICKED')) {
    await scan(stager, '扫描框标签', t.labelId ?? '');
    const chip = stager.locator('.chip.mono').first();
    slots.push((await chip.innerText()).trim());
    await chip.click();
    await expect.poll(async () => (await state(stager)).totes[t.id]?.status).toBe('STAGED');
  }
  return slots;
}
