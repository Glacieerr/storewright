import { expect, test } from '@playwright/test';
import { Recorder } from './recorder';
import { createOrders, scan, signIn, stageOrders, state, tab, until, type AnyState } from './helpers';

/**
 * 自取订单在四台设备上的完整流程，包括：找不到商品时的 AI 替代推荐、转后仓补取、
 * 顾客「我在路上」后的 AI 到店时间修正、错误的取货码、年龄核验、交付完成后的等待时长。
 */
test('02 自取订单全流程（四台设备）', async ({ browser }) => {
  const r = new Recorder('自取订单全流程（四台设备）', 2);
  const con = await signIn(browser, 'console');
  const picker = await signIn(browser, 'Avery');
  const stager = await signIn(browser, 'Riley');
  const handoff = await signIn(browser, 'Morgan');
  const backroom = await signIn(browser, 'Drew');
  let order = { orderId: '', shortCode: '', code: '', name: '' };

  await r.step('控制台下单：1 张自取订单（最多 6 行，立即锁单并生成拣货批次）', async () => {
    [order] = (await createOrders(con, { lines: 6 })) as [typeof order];
    await until(con, (s) => s.orders[order.orderId]?.status === 'LOCKED');
    const s = await state(con);
    const o = s.orders[order.orderId];
    return `订单 ${order.shortCode}（${order.name}），${o.lines.length} 行，${o.toteIds.length} 个框；取货码 ${order.code}（只在控制台显示）`;
  }, { shot: con, device: '控制台' });

  await r.step('拣货员看到可领取的批次（按温区分批，带截止时间、距离、预计用时）', async () => {
    await expect(picker.getByText(/可以领取的批次/)).toBeVisible();
    return (await picker.locator('main').innerText()).split('\n').slice(0, 12).join(' · ');
  }, { shot: picker, device: '拣货员手机' });

  // 逐个批次：领取、扫框、拣货；第一个可替代的行走「找不到 → AI 替代」，第一个后仓有货的行走「转后仓补取」
  let subDone = false;
  let excDone = false;
  for (let guard = 0; guard < 6; guard++) {
    const s = await state(picker);
    const walk = Object.values(s.walks as Record<string, AnyState>).find((w) => w.status === 'OPEN' && w.toteIds.some((id: string) => s.totes[id]?.orderId === order.orderId));
    if (!walk) break;
    await r.step(`领取批次 ${walk.id}，逐框扫描标签绑定`, async () => {
      await tab(picker, '拣货');
      await picker.locator('.card', { hasText: walk.id }).getByRole('button', { name: '领取这个批次' }).click();
      for (const id of walk.toteIds) await scan(picker, '扫描框上的标签', s.totes[id]?.labelId ?? '');
      await expect(picker.getByRole('button', { name: /^已拣到|完成拣货/ }).first()).toBeVisible();
      return `${walk.toteIds.length} 个框已绑定`;
    }, { shot: picker, device: '拣货员手机' });
    const picked = async () => Number(/已拣 (\d+)/.exec(await picker.locator('main').innerText())?.[1] ?? 0);
    for (let i = 0; i < 30 && !(await picker.getByRole('button', { name: '完成拣货，去暂存' }).isVisible()); i++) {
      const title = (await picker.locator('.pick-card, .phase').first().innerText()).split('\n').slice(0, 6).join(' ');
      const allowSub = !(await picker.getByText('不允许替代').isVisible());
      if (!subDone && allowSub) {
        subDone = true;
        await r.step('找不到 → 查看替代商品：AI 按顾客接受概率排序并给出理由', async () => {
          await picker.getByRole('button', { name: '找不到' }).click();
          await picker.getByRole('button', { name: '查看替代商品' }).click();
          await expect(picker.locator('.subs li').first()).toBeVisible();
          const top = await picker.locator('.subs li').first().innerText();
          return `当前行：${title}\n第一名：${top.replace(/\n/g, ' ')}`;
        }, { shot: picker, device: '拣货员手机' });
        await r.step('选择 AI 推荐的第一名替代', async () => {
          await picker.locator('.subs li').first().getByRole('button').click();
          await expect(picker.getByRole('dialog')).toHaveCount(0);
        }, { shot: picker, device: '拣货员手机' });
        continue;
      }
      if (!excDone) {
        await picker.getByRole('button', { name: '找不到' }).click();
        await picker.getByRole('dialog').waitFor();
        const exc = picker.getByRole('button', { name: /转后仓补取/ });
        if ((await exc.count()) && (await exc.isEnabled())) {
          excDone = true;
          await r.step('另一行找不到，库存记录显示后仓有货 → 转后仓补取（拣货员不用等）', async () => {
            const txt = await exc.innerText();
            await exc.click();
            return txt;
          }, { shot: picker, device: '拣货员手机' });
          continue;
        }
        await picker.getByRole('button', { name: '取消' }).click();
      }
      const before = await picked();
      await picker.getByRole('button', { name: /^已拣到/ }).click();
      await expect.poll(async () => (await picker.getByRole('button', { name: '完成拣货，去暂存' }).isVisible()) || (await picked()) > before).toBe(true);
    }
    await r.step(`批次 ${walk.id} 拣完，去暂存`, async () => {
      await picker.getByRole('button', { name: '完成拣货，去暂存' }).click();
    }, { shot: picker, device: '拣货员手机' });
  }

  await r.step('暂存员逐框扫描，放进建议的格位（按温区、按自取 / 配送分区）', async () => {
    const slots = await stageOrders(stager, [order.orderId]);
    return `格位：${slots.join('、')}`;
  }, { shot: stager, device: '暂存员手机' });

  if (excDone) {
    await r.step('后仓员（有永久授权）在「补取」里看到任务：订单、时段、后仓库位', async () => {
      await tab(backroom, '库存');
      await backroom.getByRole('tab', { name: /补取/ }).click();
      await expect(backroom.getByRole('button', { name: '领取' }).first()).toBeVisible();
      return (await backroom.locator('main').innerText()).split('\n').slice(0, 10).join(' · ');
    }, { shot: backroom, device: '后仓员手机' });
    await r.step('领取补取任务，在后仓找到箱子（点选库位里的箱子 = 扫描箱标签）', async () => {
      await backroom.getByRole('button', { name: '领取' }).first().click();
      await backroom.locator('.tote-list .row-btn').first().click();
      await backroom.getByRole('button', { name: '还有' }).click();
      await expect(backroom.getByText(/扫描格位标签确认|没有格位标签/).first()).toBeVisible();
      return '库位里还有这个商品；补货任务自动生成';
    }, { shot: backroom, device: '后仓员手机' });
    await r.step('送到这张订单的暂存格位，确认后补取完成', async () => {
      const s = await state(backroom);
      const x = Object.values(s.exceptions as Record<string, AnyState>).find((e) => e.orderId === order.orderId && e.status !== 'DELIVERED');
      const tote = x ? s.totes[x.toteId] : undefined;
      if (tote?.slotCode) await scan(backroom, '扫描格位标签确认', tote.slotCode);
      else await backroom.getByRole('button', { name: /手动确认/ }).click();
      await until(backroom, (st) => Object.values(st.exceptions as Record<string, AnyState>).filter((e) => e.orderId === order.orderId).every((e) => e.status === 'DELIVERED'));
      return `送到格位 ${tote?.slotCode ?? '（手动确认）'}`;
    }, { shot: backroom, device: '后仓员手机' });
  }

  await r.step('交付看板：订单显示「未到达」，还有后仓补取未送到时会注明', async () => {
    await tab(handoff, '交付');
    await expect(handoff.locator('.board-row').first()).toBeVisible();
    return (await handoff.locator('.board').innerText()).replace(/\n/g, ' · ');
  }, { shot: handoff, device: '交付员手机' });

  await r.step('顾客点「我在路上」：AI 修正到店时间（导航报 4 分钟）', async () => {
    await con.locator('tr', { hasText: order.shortCode }).getByRole('button', { name: '我在路上' }).click();
    await until(con, (s) => s.orders[order.orderId]?.etaAt !== undefined);
    await handoff.waitForTimeout(2500);
    const s = await state(con);
    const o = s.orders[order.orderId];
    const rec = Object.values(s.recs as Record<string, AnyState>).find((x) => x.module === 'ETA' && x.target === order.orderId);
    return `顾客报的到达时间 ${new Date(o.etaAt).toTimeString().slice(0, 5)}；AI 建议 ${rec ? `${Math.round(rec.prediction.value)} 分钟（${rec.status}）` : '无'}；看板用 ${o.aiEtaAt ? new Date(o.aiEtaAt).toTimeString().slice(0, 5) : '顾客上报'}`;
  }, { shot: handoff, device: '交付员手机' });

  await r.step('顾客到店签到：看板变蓝（已到达），显示车位', async () => {
    await con.locator('tr', { hasText: order.shortCode }).getByRole('button', { name: '到店' }).click();
    await expect(handoff.locator('.board-row.c-blue')).toBeVisible();
    return (await handoff.locator('.board-row.c-blue').first().innerText()).replace(/\n/g, ' ');
  }, { shot: handoff, device: '交付员手机' });

  await r.step('交付员打开订单，开始准备，逐框扫描取出', async () => {
    await scan(handoff, '扫描任意一个框，或输入订单短号', order.shortCode);
    await handoff.getByRole('button', { name: '开始准备' }).click();
    const s = await state(handoff);
    for (const id of s.orders[order.orderId].toteIds) if (s.totes[id]?.status === 'STAGED') await scan(handoff, '逐框扫描', s.totes[id].labelId);
    return `${s.orders[order.orderId].toteIds.length} 个框`;
  }, { shot: handoff, device: '交付员手机' });

  await r.step('输入错误的取货码 4 次：不限次数、不锁定（决策记录 0014），错 3 次后多一个「人工核验」入口，验证码仍可继续输入', async () => {
    for (let i = 1; i <= 4; i++) {
      await handoff.getByLabel('验证码').fill(`ZZZ${i}`);
      await handoff.getByRole('button', { name: '核验', exact: true }).click();
      await expect(handoff.getByText(new RegExp(`已错 ${i} 次`))).toBeVisible();
    }
    await expect(handoff.locator('.manual-alt')).toBeVisible();
    await expect(handoff.getByLabel('验证码')).toBeEnabled();
    return `${(await handoff.getByText(/验证码不正确/).innerText()).trim()}；${(await handoff.locator('.manual-alt').innerText()).replace(/\n/g, ' ')}`;
  }, { shot: handoff, device: '交付员手机' });

  await r.step('输入正确的取货码；有年龄限制商品时核验证件；显示缺货与替代清单', async () => {
    await handoff.getByLabel('验证码').fill(order.code);
    await handoff.getByRole('button', { name: '核验', exact: true }).click();
    await expect(handoff.getByRole('button', { name: '完成交付' })).toBeVisible();
    let age = '';
    if (await handoff.getByRole('button', { name: '已核验证件' }).isVisible()) {
      // 年龄核验没做时「完成交付」不可用
      await expect(handoff.getByRole('button', { name: '完成交付' })).toBeDisabled();
      await handoff.getByRole('button', { name: '已核验证件' }).click();
      age = '含年龄限制商品：核验证件前「完成交付」不可用，核验后可用。';
    }
    await expect(handoff.getByRole('button', { name: '完成交付' })).toBeEnabled();
    return age + ((await handoff.locator('main').innerText()).split('\n').filter((l) => /替换|缺货|没有缺货/.test(l)).join(' · ') || '（无缺货、替代）');
  }, { shot: handoff, device: '交付员手机' });

  await r.step('完成交付：四台设备同步显示已完成，控制台记录等待时长', async () => {
    await handoff.getByRole('button', { name: '完成交付' }).click();
    for (const p of [con, picker, stager, handoff]) await until(p, (s) => s.orders[order.orderId]?.status === 'COMPLETED');
    const done = await con.locator('.card', { hasText: '最近完成' }).innerText();
    return done.split('\n').slice(1, 3).join(' · ');
  }, { shot: con, device: '控制台' });

  r.note('这张订单的事件', await (async () => {
    const s = await state(con);
    return `事件序号到 #${s.seq}；订单状态 ${s.orders[order.orderId].status}；替代 ${Object.values(s.orders[order.orderId].lineResults as Record<string, AnyState>).reduce((a, x) => a + (x.substituted ?? 0), 0)} 件，缺货 ${Object.values(s.orders[order.orderId].lineResults as Record<string, AnyState>).reduce((a, x) => a + (x.short ?? 0), 0)} 件；后仓补取任务 ${Object.values(s.exceptions as Record<string, AnyState>).filter((x) => x.orderId === order.orderId).length} 个`;
  })());
  expect(r.failures, r.failures.join('\n')).toEqual([]);
});
