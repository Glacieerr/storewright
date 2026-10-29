import { expect } from '@playwright/test';
import { device, Recorder } from './recorder';
import { LIVE, test } from './helpers';

test('01 登录与语言', async ({ browser }) => {
  const r = new Recorder('登录与语言', 1);
  const p = await device(browser, LIVE);
  await r.step('打开员工端：门店名单与演示控制台入口', async () => {
    await p.goto('/');
    await expect(p.getByRole('button', { name: /Avery/ })).toBeVisible({ timeout: 60_000 });
    const names = await p.locator('.person b').allInnerTexts();
    return `名单 ${names.length} 人：${names.join('、')}`;
  }, { shot: p, device: '手机' });
  await r.step('切换到英文界面', async () => {
    await p.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(p.getByText('Who are you?')).toBeVisible();
  }, { shot: p, device: '手机' });
  await r.step('切回中文；门店填 hardware 显示家居建材店的名单（没有熟食员工）', async () => {
    await p.getByRole('button', { name: '中文', exact: true }).click();
    await p.getByLabel('门店').fill('hardware');
    await expect(p.getByRole('button', { name: /Jamie/ })).toBeVisible();
    // 名单按门店编号重新读取：等它换成建材店的名单
    await expect(p.getByRole('button', { name: /Jamie/ })).not.toContainText('熟食', { timeout: 15_000 });
    const jamie = await p.getByRole('button', { name: /Jamie/ }).innerText();
    return `Jamie 的岗位：${jamie.split('\n').pop()}`;
  }, { shot: p, device: '手机' });
  await r.step('不存在的门店给出提示', async () => {
    await p.getByLabel('门店').fill('nowhere');
    await expect(p.locator('.banner.error')).toBeVisible();
    return (await p.locator('.banner.error').innerText()).trim();
  }, { shot: p, device: '手机' });
  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
