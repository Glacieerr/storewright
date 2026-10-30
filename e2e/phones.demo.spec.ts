import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test';

/**
 * 展示页里的两部手机（约 300 × 520 的 iframe）：全部用真实点击操作。
 * 2026-10-24 作者验证时发现「打开摄像头后无法关闭」等问题后补上：按下时 button:active 的 transform 盖掉了「关闭」按钮的居中
 * transform，按钮跳开，抬起时点到了下面的遮罩。这里逐个检查手机上的弹层、面板和整条流程。
 */

const phoneBox = (page: Page, i: number) => page.locator('.phone').nth(i);
const phone = (page: Page, i: number): FrameLocator => phoneBox(page, i).frameLocator('iframe');
const tab = (p: FrameLocator, name: string) => p.locator('.tabbar button').filter({ hasText: name }).click();
/** 点一下以后等门店中枢处理完、手机上更新：持续集成的机器慢，偶尔超过默认的等待时间 */
const settled = { timeout: 60_000 };

async function open(page: Page): Promise<FrameLocator> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/app/showcase.html');
  const con = page.frameLocator('iframe.sc-console');
  await expect(con.getByRole('heading', { name: '创建测试订单' })).toBeVisible({ timeout: 90_000 });
  await expect(phone(page, 0).locator('.link-state.live')).toBeVisible({ timeout: 60_000 });
  await expect(phone(page, 1).locator('.link-state.live')).toBeVisible({ timeout: 60_000 });
  // 两部手机整个在屏幕里：底部的标签栏不用滚动整页就能点到（以前按「整屏减 140 像素」算高度，手机底部落在屏幕外）
  for (let i = 0; i < 2; i++) {
    const r = await phoneBox(page, i).locator('iframe').boundingBox();
    expect((r?.y ?? 0) + (r?.height ?? 0)).toBeLessThanOrEqual(900);
  }
  return con;
}

async function role(page: Page, i: number, id: string): Promise<void> {
  await phoneBox(page, i).locator('select').selectOption(id);
  await expect(phone(page, i).locator('.link-state.live')).toBeVisible({ timeout: 60_000 });
}

/** 逐个点列表里还能点的按钮：每点一下等它生效（变灰或消失）再点下一个，避免点到正在更新的那一行 */
async function clickEach(rows: Locator, max = 8): Promise<void> {
  for (let k = 0; k < max; k++) {
    const n = await rows.count();
    if (!n) return;
    await rows.first().click();
    await expect.poll(() => rows.count(), settled).toBeLessThan(n);
  }
}

/** 领取一个批次：点框绑定标签（演示），逐行「已拣到」，完成后去暂存 */
async function pickOneWalk(p: FrameLocator): Promise<void> {
  await tab(p, '拣货');
  await p.getByRole('button', { name: '领取这个批次' }).first().click();
  await expect(p.locator('.phase .row-btn').first()).toBeVisible();
  await clickEach(p.locator('.phase .row-btn:not([disabled])'));
  const done = p.getByRole('button', { name: '完成拣货，去暂存' });
  const picked = async () => Number(/已拣 (\d+)/.exec(await p.locator('main').innerText())?.[1] ?? 0);
  for (let k = 0; k < 40 && !(await done.isVisible()); k++) {
    const before = await picked();
    await p.getByRole('button', { name: /^已拣到/ }).click();
    // 等这一行记上了再点下一行（不然慢的机器上可能对同一行点两次）
    await expect.poll(async () => (await done.isVisible()) || (await picked()) > before, settled).toBe(true);
  }
  await done.click();
}

/** 逐框暂存：点框，再点建议的格位；等这个框从「待暂存」里消失再点下一个（慢的机器上列表还没更新，会再点到刚放好的框） */
async function stageAll(p: FrameLocator): Promise<void> {
  const totes = p.locator('main .tote-list .row-btn');
  await expect(p.getByText(/待暂存（\d+）/)).toBeVisible();
  for (let k = 0; k < 8; k++) {
    const n = await totes.count();
    const tote = totes.first();
    if (!n || !(await tote.isVisible().catch(() => false))) return;
    await tote.click();
    // 正在暂存的框：「下一步」不该把格位挤到屏幕外
    await expect(p.locator('.next-task')).toHaveCount(0);
    await p.locator('.chip.mono').first().click();
    await expect.poll(() => totes.count(), settled).toBeLessThan(n);
  }
}

test('手机：摄像头打开后能关闭（真实点击），没有摄像头时可以改成手动输入', async ({ page }) => {
  const con = await open(page);
  const p = phone(page, 0);
  await con.getByRole('button', { name: '创建', exact: true }).click();
  await p.getByRole('button', { name: '领取这个批次' }).first().click();
  for (let k = 0; k < 2; k++) {
    await p.locator('.scanbox .icon-btn.primary').first().click();
    const cam = p.locator('.camera');
    await expect(cam).toBeVisible();
    // 第一次点「关闭」，第二次（没有摄像头权限时）点「手动输入」
    const manual = cam.getByRole('button', { name: '手动输入' });
    if (k === 1 && (await manual.isVisible())) {
      await manual.click();
      await expect(p.locator('.scanbox input').first()).toHaveAttribute('inputmode', 'text');
    } else {
      await cam.getByRole('button', { name: '关闭' }).click();
    }
    await expect(cam).toHaveCount(0);
  }
  // Esc 也能关
  await p.locator('.scanbox .icon-btn.primary').first().click();
  await expect(p.locator('.camera')).toBeVisible();
  await p.locator('.camera').press('Escape');
  await expect(p.locator('.camera')).toHaveCount(0);
});

test('手机：引导的整条流程（拣货 → 暂存 → 到店 → 交付）用真实点击走通，引导逐步打勾', async ({ page }) => {
  test.setTimeout(240_000);
  const con = await open(page);
  const picker = phone(page, 0);
  const handoff = phone(page, 1);
  await con.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.locator('.sc-steps li').first()).toHaveClass(/done/);

  // 拣货：一张订单可能分成几个温区的批次，全部拣完
  for (let w = 0; w < 4; w++) {
    await tab(picker, '拣货');
    if (!(await picker.getByRole('button', { name: '领取这个批次' }).first().isVisible().catch(() => false))) break;
    await pickOneWalk(picker);
  }
  await expect(page.locator('.sc-steps li').nth(1)).toHaveClass(/done/);

  // 暂存：第一部手机换成暂存员，逐框点选、放进建议的格位
  await role(page, 0, 'A04');
  await tab(picker, '暂存');
  await stageAll(picker);
  await expect(page.locator('.sc-steps li').nth(2)).toHaveClass(/done/);

  // 到店：控制台「我在路上」「到店」，读出验证码
  const row = con.locator('tr').filter({ has: con.getByRole('button', { name: '到店' }) }).first();
  const cells = (await row.locator('td').allInnerTexts()).map((x) => x.trim());
  const code = cells.find((c) => /^[0-9A-Z]{4}$/.test(c) && !cells[0]?.startsWith(c)) as string;
  expect(code).toBeTruthy();
  const otw = row.getByRole('button', { name: '我在路上' });
  if (await otw.isVisible()) await otw.click();
  await row.getByRole('button', { name: '到店' }).click();
  await expect(page.locator('.sc-steps li').nth(3)).toHaveClass(/done/);

  // 交付：打开订单，开始准备，逐框点选，输入验证码，完成交付
  await tab(handoff, '交付');
  await handoff.locator('.board-row').first().click();
  await handoff.getByRole('button', { name: '开始准备' }).click();
  // 等准备清单出来再逐框点：点完「开始准备」马上数是 0（清单还没渲染），一个框也不取，后面「完成交付」就一直不出现
  await expect(handoff.locator('main .prep-list .row-btn').first()).toBeVisible();
  await clickEach(handoff.locator('main .prep-list .row-btn:not([disabled])'));
  await handoff.getByLabel('验证码').fill(code);
  await handoff.getByRole('button', { name: '核验', exact: true }).click();
  // 核验通过后「完成交付」和年龄核验（订单里有年龄限制商品时）一起出现：先等「完成交付」出现再看要不要核验证件，
  // 不然慢的机器上还没出现就判断成不用核验，「完成交付」一直不能点
  const finish = handoff.getByRole('button', { name: '完成交付' });
  await expect(finish).toBeVisible(settled);
  const age = handoff.getByRole('button', { name: /已核验证件/ });
  if (await age.isVisible()) await age.click();
  await finish.click();
  await expect(page.locator('.sc-steps li').nth(4)).toHaveClass(/done/);
});

test('手机：语音面板能收起；「找不到」的操作不用滚动就能点到；提示条不挡按钮；展示页里的手机没有「退出登录」', async ({ page }) => {
  const con = await open(page);
  const p = phone(page, 0);
  await con.getByRole('button', { name: '创建', exact: true }).click();
  await p.getByRole('button', { name: '领取这个批次' }).first().click();
  await expect(p.locator('.phase .row-btn').first()).toBeVisible();
  await clickEach(p.locator('.phase .row-btn:not([disabled])'));

  // 语音：打开后输入框在屏幕里，可以收起
  await p.getByRole('button', { name: '语音命令' }).click();
  await expect(p.getByLabel('语音命令')).toBeInViewport();
  await p.locator('form.voice').getByRole('button', { name: '收起' }).click();
  await expect(p.locator('form.voice')).toHaveCount(0);

  // 找不到：「标记缺货」「取消」固定在面板底部
  await p.getByRole('button', { name: '找不到' }).click();
  const sheet = p.getByRole('dialog', { name: '找不到' });
  await expect(sheet.getByRole('button', { name: '取消' })).toBeInViewport();
  await sheet.getByRole('button', { name: '取消' }).click();
  await expect(sheet).toHaveCount(0);

  // 提示条（加一个框）出现时，下面的按钮照样点得到
  await p.getByRole('button', { name: /装满了？加一个框/ }).click();
  await expect(p.locator('.toast').first()).toBeVisible();
  expect(await p.locator('.toast').first().evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');

  // 展示页里的手机由上方的选择框切换员工
  await tab(p, '更多');
  await expect(p.getByRole('button', { name: '退出登录' })).toHaveCount(0);
  await expect(p.getByText('在展示页里，用手机上方的选择框切换员工。')).toBeVisible();
});

test('手机：分段标签不竖着换行；带班负责人的提醒面板在标签栏上面、「关闭」点得到；「下一步」可以收起', async ({ page }) => {
  const con = await open(page);
  const lead = phone(page, 0);
  await role(page, 0, 'A08');
  await tab(lead, 'AI');
  // 六个标签：窄屏排成三列，每个标签一行字
  for (const name of ['建议', '模式与统计']) {
    const b = lead.getByRole('tab', { name: new RegExp(name) });
    const h = await b.evaluate((el) => el.getBoundingClientRect().height);
    expect(h).toBeLessThan(60);
  }
  await lead.locator('button.bell').click();
  const sheet = lead.getByRole('dialog', { name: '提醒' });
  await expect(sheet).toBeVisible();
  const hit = await sheet.getByRole('button', { name: '关闭' }).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
  });
  expect(hit).toBe(true);
  await sheet.getByRole('button', { name: '关闭' }).click();
  await expect(sheet).toHaveCount(0);

  // 「下一步」：在拣货页（批次就在列表里）不显示；在别的页显示，可以收起
  await con.getByRole('button', { name: '创建', exact: true }).click();
  const picker = phone(page, 1);
  await role(page, 1, 'A01');
  await tab(picker, '拣货');
  await expect(picker.getByRole('button', { name: '领取这个批次' }).first()).toBeVisible();
  await expect(picker.locator('.next-task')).toHaveCount(0);
  await tab(picker, '库存');
  const card = picker.locator('.next-task');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '收起' }).click();
  await expect(card).toHaveCount(0);
});

// 在岗人员与调配（决策记录 0025）
test('手机：在岗人员——每部手机都能看到谁在哪个岗位；带班负责人临时调人，被调的人的手机切到新岗位并提示，调回后恢复', async ({ page }) => {
  await open(page);
  const lead = phone(page, 0);
  const avery = phone(page, 1);
  await role(page, 0, 'A08');
  await role(page, 1, 'A01');

  // 拣货员的手机：只能看，自己那一行标「你」，没有「调配」
  await avery.locator('button.team-btn').click();
  const mine = avery.getByRole('dialog', { name: '在岗人员' });
  await expect(mine.locator('section[aria-label="拣货"] .team-row.me')).toContainText('Avery');
  await expect(mine.getByRole('button', { name: '调配' })).toHaveCount(0);
  await mine.getByRole('button', { name: '关闭' }).click();
  await expect(mine).toHaveCount(0);

  // 带班负责人：Avery 调到暂存 30 分钟
  await lead.locator('button.team-btn').click();
  const sheet = lead.getByRole('dialog', { name: '在岗人员' });
  const row = sheet.locator('.team-row', { hasText: 'Avery' });
  await row.getByRole('button', { name: '调配' }).click();
  await row.getByRole('radio', { name: '30 分钟' }).click();
  await row.getByRole('button', { name: /调到暂存/ }).click();
  await expect(lead.locator('.toast', { hasText: /已把 Avery 调到暂存，\d\d:\d\d 自动回拣货/ })).toBeVisible();
  await expect(sheet.locator('section[aria-label="暂存"] .team-row', { hasText: 'Avery' })).toContainText(/临时 · \d\d:\d\d 回拣货/);

  // Avery 的手机：提示、切到暂存页，在岗人员里在暂存组
  await expect(avery.locator('.toast', { hasText: /你已被调到暂存，\d\d:\d\d 回原岗位/ })).toBeVisible();
  await expect(avery.locator('.tabbar button[aria-current="page"]')).toContainText('暂存');
  await avery.locator('button.team-btn').click();
  await expect(mine.locator('section[aria-label="暂存"] .team-row.me')).toContainText(/临时 · \d\d:\d\d 回拣货/);
  // Esc 也能关
  await mine.getByRole('button', { name: '关闭' }).press('Escape');
  await expect(mine).toHaveCount(0);

  // 带班负责人调回：Avery 回到拣货
  await sheet.locator('.team-row', { hasText: 'Avery' }).getByRole('button', { name: '调配' }).click();
  await sheet.locator('.team-row', { hasText: 'Avery' }).getByRole('button', { name: '回到拣货' }).click();
  await expect(avery.locator('.toast', { hasText: '你已回到拣货' })).toBeVisible();
  await expect(avery.locator('.tabbar button[aria-current="page"]')).toContainText('拣货');
  await expect(sheet.locator('section[aria-label="拣货"] .team-row', { hasText: 'Avery' })).not.toContainText('临时');
});

// 流程梳理时发现的问题（决策记录 0025 · 第 8 节）：准备中取消订单，以前交付准备结束不了、交付员一直算「忙」
test('手机：准备中取消订单——交付员的页面列出已取出的框，放进回收专区后回到看板', async ({ page }) => {
  test.setTimeout(240_000);
  const con = await open(page);
  const picker = phone(page, 0);
  const handoff = phone(page, 1);
  await con.getByRole('button', { name: '创建', exact: true }).click();
  for (let w = 0; w < 4; w++) {
    await tab(picker, '拣货');
    if (!(await picker.getByRole('button', { name: '领取这个批次' }).first().isVisible().catch(() => false))) break;
    await pickOneWalk(picker);
  }
  await role(page, 0, 'A04');
  await tab(picker, '暂存');
  await stageAll(picker);
  // 顾客到店，交付员开始准备并取出一个框
  const row = con.locator('tr').filter({ has: con.getByRole('button', { name: '到店' }) }).first();
  const short = ((await row.locator('td').first().innerText()).trim().split(/\s/)[0] ?? '').trim();
  await row.getByRole('button', { name: '到店' }).click();
  await tab(handoff, '交付');
  await handoff.locator('.board-row', { hasText: short }).click();
  await handoff.getByRole('button', { name: '开始准备' }).click();
  // 等取出的框记上了（按钮变灰）再取消：慢的机器上取消可能先到，就没有要放回的框
  const prep = handoff.locator('main .prep-list .row-btn:not([disabled])');
  await expect(prep.first()).toBeVisible();
  const left = await prep.count();
  await prep.first().click();
  await expect.poll(() => prep.count(), settled).toBeLessThan(left);
  // 控制台取消这张订单
  await con.locator('tr', { hasText: short }).getByRole('button', { name: '取消' }).click();
  const notice = handoff.getByText('订单已取消：把已经取出的框放进对应温区的回收专区，放好后点一下。');
  await expect(notice).toBeVisible();
  await handoff.locator('main .tote-list .row-btn').first().click();
  await expect(notice).toHaveCount(0);
  await expect(handoff.getByText('订单已取消', { exact: true })).toBeVisible();
  await handoff.getByRole('button', { name: /返回看板/ }).click();
  await expect(handoff.locator('.board-row', { hasText: short })).toHaveCount(0);
});

test('展示页：常见的笔记本窗口（1366 × 740）里两部手机也整个在屏幕里，不用滚动整页', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 740 });
  await page.goto('/app/showcase.html');
  await expect(phone(page, 0).locator('.link-state.live')).toBeVisible({ timeout: 60_000 });
  for (let i = 0; i < 2; i++) {
    const r = await phoneBox(page, i).locator('iframe').boundingBox();
    expect((r?.y ?? 0) + (r?.height ?? 0)).toBeLessThanOrEqual(740);
  }
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(741);
});
