import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AiModule } from '@storewright/ai';
import { myNudges, sessionKeyFor, type EquipmentAlertKind, type Nudge } from '@storewright/ops';
import { sensorsFor } from '@storewright/twin';
import { clock, t } from '../i18n';
import { useLive } from '../live';
import { navigate } from '../nav';
import { MODULE_TEXT } from '../screens/AiScreen';
import { causeText, modelName } from '../screens/AiBrief';
import { ALERT_TEXT, sensorName } from '../screens/TwinCard';
import { toast } from './Toasts';

/**
 * 提醒（建议中枢，决策记录 0021 · G1）：AI 决定发给谁、什么时候发、合不合并，这里只负责显示。
 * 顶栏的铃铛显示没处理完的提醒数；新提醒到达时弹出一次（紧急的标红）；点开看全部，「去处理」跳到对应的页面并标记已读。
 */

export type NudgeTarget = 'ai' | 'inventory' | 'pick' | 'handoff' | 'console' | 'more' | 'none';

/** 提醒去哪里处理 */
export function nudgeTarget(n: Nudge): NudgeTarget {
  switch (n.kind) {
    case 'REC':
      return 'ai';
    case 'TASK':
      return 'inventory';
    case 'COLD':
      return 'pick';
    case 'ESCALATION':
      return 'console';
    case 'OFFER':
      return 'more';
    case 'NOTICE':
      return n.params?.notice === 'TRIP_AT_RISK' ? 'handoff' : 'ai';
    // 顾客到店（决策记录 0026）
    case 'ARRIVAL':
      return 'handoff';
    default:
      return 'none';
  }
}

export function nudgeText(n: Nudge, sensor: (id: string) => string): string {
  const count = Number(n.params?.count ?? n.refs.length);
  const many = count > 1 ? t('（{0} 条）', count) : '';
  switch (n.kind) {
    case 'REC':
      return t('AI 建议：{0}', t(MODULE_TEXT[String(n.params?.module ?? '') as AiModule] ?? String(n.params?.module ?? ''))) + many;
    case 'ALERT':
      if (n.topic === 'ALERT:MULTI') return t('{0} 台冷柜同时超温：可能是停电或同一条线路故障', Number(n.params?.sensors ?? count));
      return t('设备告警：{0} · {1}', sensor(String(n.params?.sensor ?? '')), t(ALERT_TEXT[String(n.params?.kind ?? 'TEMP_HIGH') as EquipmentAlertKind] ?? ''));
    case 'ESCALATION':
      return t('{0} 的严重告警 {1} 分钟没人确认', sensor(String(n.params?.sensor ?? '')), Number(n.params?.minutes ?? 0));
    case 'COLD':
      return n.params?.early ? t('按现在的速度，冷链会超时约 {0} 分钟：先把已经拣好的框送回暂存，剩下 {1} 行可以转给别人', Number(n.params?.over ?? 0), Number(n.params?.lines ?? 0)) : t('冷链超时：请立即把冷藏 / 冷冻框送回暂存区');
    case 'OFFER': {
      const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      return n.params?.kind === 'EARLY_LEAVE'
        ? t('可以提前下班：{0} {1} 起（自愿）', String(n.params?.date ?? ''), hm(Number(n.params?.from ?? 0)))
        : t('补班邀请：{0} {1}–{2}', String(n.params?.date ?? ''), hm(Number(n.params?.from ?? 0)), hm(Number(n.params?.to ?? 0)));
    }
    // 负荷与安全（决策记录 0023 · D5）
    case 'SAFETY': {
      const p = n.params ?? {};
      if (p.safety === 'FREEZER') return t('冷冻区累计 {0} 分钟：出来暖和一下，再接冷冻批次', Number(p.minutes ?? 0));
      if (p.safety === 'BREAK') return t('已经连续工作 {0} 小时 {1} 分钟：记得休息 15 分钟', Math.floor(Number(p.minutes ?? 0) / 60), Number(p.minutes ?? 0) % 60);
      return t('{0} 在搬一件 {1} kg 的大件（需两人搬运）：请去帮忙', String(p.who ?? ''), Number(p.kg ?? 0));
    }
    // AI 自己的通知（决策记录 0022 · F4、H3）
    // 顾客到店（决策记录 0026）
    case 'ARRIVAL':
      return count > 1 ? t('{0} 位顾客到店，等着交付', count) : t('顾客到店：订单 {0}{1}', String(n.params?.order ?? ''), n.params?.bay ? t('，车位 {0}', String(n.params.bay)) : '');
    case 'NOTICE': {
      const p = n.params ?? {};
      if (p.notice === 'TRIP_AT_RISK') return t('行程 {0} 改派后可能赶不上送达时段：请安排人跟进', String(p.trip ?? ''));
      if (p.notice === 'DOWNGRADED')
        return t('AI 自动降级：「{0}」最近 {1} 次只有 {2}% 达到预计效果，已改为只显示', t(MODULE_TEXT[String(p.module) as AiModule] ?? String(p.module)), Number(p.n ?? 0), Math.round(Number(p.hitRate ?? 0) * 100));
      if (p.notice === 'PAUSED') return t('AI 运行监控：「{0}」暂停（{1}）', modelName(String(p.model)), causeText(String(p.cause ?? '')));
      return t('AI 运行监控：「{0}」最近误差明显变大，建议重新训练或回滚', modelName(String(p.model)));
    }
    case 'TASK': {
      const task = String(n.params?.task ?? '');
      if (task === 'CHECK')
        return (
          t(
            '核对货架：{0} 通道',
            String(n.params?.run ?? '')
              .split('-')
              .pop() ?? '',
          ) + many
        );
      if (task === 'PREPICK')
        return (
          t(
            '拣货前补货：{0} 通道，拣货员快到了',
            String(n.params?.run ?? '')
              .split('-')
              .pop() ?? '',
          ) + many
        );
      if (task === 'EXCEPTION') return t('有后仓补取任务') + many;
      // 后仓补取找到了、框也放进暂存了（决策记录 0026）
      if (task === 'DELIVER') return t('订单的框已经放进暂存 {0}：可以把补取的商品送过去了', String(n.params?.slot ?? ''));
      return t('新任务') + many;
    }
  }
}

export function NudgeBell({ onGo }: { onGo: (to: NudgeTarget) => void }) {
  const { client, auth, run } = useLive();
  const [open, setOpen] = useState(false);
  const mine = myNudges(client.state, auth.actor);
  const defs = client.statics ? sensorsFor(client.statics) : [];
  const sensor = (id: string) =>
    sensorName(
      defs.find((d) => d.id === id),
      id,
    );
  // 新提醒到达时弹出一次（第一次载入时已有的不弹）
  const seen = useRef<Set<string> | undefined>(undefined);
  useEffect(() => {
    const ids = new Set(mine.map((n) => n.id));
    if (seen.current) for (const n of mine) if (!seen.current.has(n.id) && n.status === 'SENT') toast(nudgeText(n, sensor), n.urgent ? 'error' : 'info');
    seen.current = ids;
  });
  const unread = mine.filter((n) => n.status === 'SENT').length;
  // 直达那一条（决策记录 0026）：打开对应的子页、任务、建议、交付，不只是跳到标签页
  const go = (n: Nudge) => {
    if (n.status === 'SENT') void run({ type: 'ReadNudge', nudgeId: n.id }, { quiet: true });
    setOpen(false);
    const ref = n.refs[0] ?? '';
    const task = String(n.params?.task ?? '');
    if (n.kind === 'REC') navigate({ aiTab: 'recs', recId: ref });
    else if (n.kind === 'TASK') navigate(task === 'CHECK' ? { inventory: 'repl', checkId: ref } : task === 'PREPICK' ? { inventory: 'repl' } : { inventory: 'exception' });
    else if (n.kind === 'ARRIVAL') navigate({ sessionKey: sessionKeyFor(client.state, ref) });
    else if (n.kind === 'NOTICE' && n.params?.notice === 'TRIP_AT_RISK') navigate({ sessionKey: ref.replace(/^TRIP:/, '') });
    else if (n.kind === 'ALERT') navigate({ alert: true });
    onGo(nudgeTarget(n));
  };
  return (
    <>
      <button className={`bell${unread ? ' on' : ''}${mine.some((n) => n.urgent && n.status === 'SENT') ? ' urgent' : ''}`} aria-label={t('提醒（{0} 条未读）', unread)} onClick={() => setOpen(!open)}>
        <span aria-hidden>🔔</span>
        {unread > 0 && <em>{unread}</em>}
      </button>
      {/* 挂到 body 上：铃铛在顶栏里，顶栏（粘在顶部）自成一层，面板留在里面会被底部的标签栏盖住 */}
      {open &&
        createPortal(
          <div className="sheet" role="dialog" aria-label={t('提醒')}>
            <div className="sheet-body nudge-list">
              <h3>{t('提醒')}</h3>
              <p className="note">{t('AI 把建议、告警和任务合在一起：紧急的马上发；你正在交付时先不打扰；每小时最多 3 条非紧急提醒。')}</p>
              {mine.length === 0 && <p className="muted">{t('没有待处理的提醒')}</p>}
              <ul className="plain">
                {mine.map((n) => (
                  <li key={n.id} className={n.status === 'SENT' ? 'unread' : ''}>
                    <span className="mono">{clock(n.createdAt)}</span>
                    {n.urgent && <span className="tag warn-tag">{t('紧急')}</span>}
                    <span className="grow">{nudgeText(n, sensor)}</span>
                    <span className="nudge-actions">
                      {(nudgeTarget(n) !== 'none' || n.kind === 'ALERT') && (
                        <button className="chip" onClick={() => go(n)}>
                          {t('去处理')}
                        </button>
                      )}
                      {n.status === 'SENT' && (
                        <button className="link" onClick={() => void run({ type: 'ReadNudge', nudgeId: n.id }, { quiet: true })}>
                          {t('知道了')}
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <button className="link" onClick={() => setOpen(false)}>
                {t('关闭')}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
