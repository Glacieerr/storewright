import { expect, type Browser, type Page } from '@playwright/test';
import { device, DESK, PHONE } from './recorder';

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
