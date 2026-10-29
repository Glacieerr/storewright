import { useEffect, useState } from 'react';
import { activeWalkOf, currentRole, handoffBoard, openRecs, taskOf, toStageTotes } from '@storewright/ops';
import { saveAuth, loadAuth, LiveProvider, useLive, useNow, type Auth } from './live';
import { signIn } from './api';
import { DEMO, link } from './demo/transport';
import { clock, t, useLang } from './i18n';
import { AiScreen } from './screens/AiScreen';
import { IncidentBanner } from './screens/FieldScreen';
import { NextTaskCard } from './ui/NextTask';
import { ConsoleScreen } from './screens/ConsoleScreen';
import { ExtScreen, extBadge } from './screens/ext/ExtScreen';
import { HandoffScreen } from './screens/HandoffScreen';
import { InventoryScreen } from './screens/InventoryScreen';
import { MoreScreen } from './screens/MoreScreen';
import { PickScreen } from './screens/PickScreen';
import { Logo, SignIn } from './screens/SignIn';
import { StageScreen } from './screens/StageScreen';
import { AlertBanner } from './screens/TwinCard';
import { toast, Toasts } from './ui/Toasts';
import { ROLE_TEXT } from './screens/AiScreen';
import { NudgeBell, type NudgeTarget } from './ui/Nudges';
import { TeamButton } from './ui/Team';

type Tab = 'pick' | 'stage' | 'handoff' | 'inventory' | 'ext' | 'ai' | 'more';

/** 演示模式下地址栏的 ?as=A01（或 console）与 ?store=hardware：展示页的 iframe 直接以某个身份打开 */
const QUERY = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const AUTO_AS = DEMO ? QUERY.get('as') : null;
const AUTO_STORE = QUERY.get('store') || 'demo';
/** 嵌在展示页里的手机和控制台（iframe + ?as=）：身份由展示页决定，不显示退出；丢了会话（例如重置演示门店）时自动重新登录 */
const EMBEDDED = !!AUTO_AS && typeof window !== 'undefined' && window.top !== window;

function initialAuth(): Auth | undefined {
  const a = loadAuth();
  if (!AUTO_AS) return a;
  const same = a && a.storeId === AUTO_STORE && (AUTO_AS === 'console' ? a.role === 'console' : a.actor === AUTO_AS);
  return same ? a : undefined;
}

export function App() {
  useLang();
  const [auth, setAuth] = useState<Auth | undefined>(initialAuth);
  const signOut = () => {
    saveAuth(undefined);
    setAuth(undefined);
  };
  const [autoTried, setAutoTried] = useState(false);
  useEffect(() => {
    // 第一次打开时按 ?as= 登录；嵌在展示页里时，会话丢了也重新登录（不是嵌入的页面里，退出后留在登录页）
    if (auth || !AUTO_AS || (autoTried && !EMBEDDED)) return;
    setAutoTried(true);
    void signIn(AUTO_STORE, AUTO_AS === 'console' ? { role: 'console' } : { associateId: AUTO_AS })
      .then((a) => {
        saveAuth(a);
        setAuth(a);
      })
      .catch(() => toast(t('登录失败'), 'error'));
  }, [auth]);
  return (
    <>
      {DEMO && <DemoBanner />}
      {!auth ? (
        <SignIn
          onSignedIn={(a) => {
            saveAuth(a);
            setAuth(a);
          }}
        />
      ) : (
        <LiveProvider key={auth.token} auth={auth} onAuthError={signOut}>
          {auth.role === 'console' ? <ConsoleShell {...(EMBEDDED ? {} : { onSignOut: signOut })} /> : <AssociateShell {...(EMBEDDED ? {} : { onSignOut: signOut })} />}
        </LiveProvider>
      )}
      <Toasts />
    </>
  );
}

/** 演示模式：第一次打开某家店时，中枢要建店并用本店的仿真历史训练 AI 模型 */
function DemoBanner() {
  const [training, setTraining] = useState(false);
  // 不支持 SharedWorker 的浏览器、并且另一个标签页已经在用演示门店：这个标签页的门店是单独的（决策记录 0015）
  const [isolated, setIsolated] = useState(false);
  useEffect(
    () =>
      link.onStatus((x) => {
        if (x === 'isolated') setIsolated(true);
        else setTraining(x === 'training');
      }),
    [],
  );
  if (training) return <div className="demo-banner">{t('正在浏览器里建店，并用本店的仿真历史训练 AI 模型（第一次需要几秒）…')}</div>;
  if (isolated) return <div className="demo-banner isolated">{t('这个浏览器不能让多个标签页共用演示门店：这个标签页里的门店是单独的，关闭后不保存。想看多部设备同步，请用展示页（一个页面里同时有控制台、手机和模拟器）。')}</div>;
  return null;
}

function StatusBar({ onSignOut, onNudge }: { onSignOut?: () => void; onNudge?: (to: NudgeTarget) => void }) {
  const { client, auth, nameOf } = useLive();
  const now = useNow(10_000);
  const label = client.status === 'live' ? t('在线') : client.status === 'connecting' ? t('连接中') : t('离线');
  return (
    <header className="statusbar">
      <Logo />
      <div className="who">
        <b>{auth.role === 'console' ? t('演示控制台') : nameOf(auth.actor)}</b>
        <small>{client.statics?.name ?? ''}</small>
      </div>
      <span className={`link-state ${client.status}`} title={label}>
        <i />
        {label}
        {client.outbox.length > 0 && <em>{t('{0} 待提交', client.outbox.length)}</em>}
      </span>
      <span className="mono clock">{new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
      {/* 在岗人员（决策记录 0025）：所有设备都能看谁在哪个岗位；带班负责人和控制台在这里调配 */}
      {client.statics && <TeamButton />}
      {/* 提醒（建议中枢，决策记录 0021） */}
      {onNudge && client.statics && <NudgeBell onGo={onNudge} />}
      {onSignOut && (
        <button className="link" onClick={onSignOut}>
          {t('退出')}
        </button>
      )}
    </header>
  );
}

function ConsoleShell({ onSignOut }: { onSignOut?: () => void }) {
  const { client } = useLive();
  const [view, setView] = useState<'console' | 'ai'>('console');
  const open = openRecs(client.state).length;
  return (
    <div className="shell console-shell">
      <StatusBar {...(onSignOut ? { onSignOut } : {})} onNudge={(to) => setView(to === 'ai' ? 'ai' : 'console')} />
      <main className="content wide">
        <div className="segmented console-views" role="tablist">
          <button role="tab" aria-selected={view === 'console'} className={view === 'console' ? 'on' : ''} onClick={() => setView('console')}>
            {t('演示控制台')}
          </button>
          <button role="tab" aria-selected={view === 'ai'} className={view === 'ai' ? 'on' : ''} onClick={() => setView('ai')}>
            {t('AI')}
            {open > 0 && <em>{open}</em>}
          </button>
        </div>
        <IncidentBanner />
        {view === 'console' ? <ConsoleScreen /> : <AiScreen />}
      </main>
    </div>
  );
}

const DEFAULT_TAB: Record<string, Tab> = { PICK: 'pick', STAGE: 'stage', HANDOFF: 'handoff', LEAD: 'handoff', BACKROOM: 'inventory', RESTOCK: 'inventory', DELI: 'ext' };

function AssociateShell({ onSignOut }: { onSignOut?: () => void }) {
  const { client, auth } = useLive();
  const now = useNow(5000);
  // 权限看名单上的岗位（带班负责人）；默认页面看此刻的岗位（临时调动 > 当天排班 > 名单）
  const rosterRole = client.statics?.roster.find((a) => a.id === auth.actor)?.role;
  const role = currentRole(client.statics, client.state, auth.actor, now);
  const [tab, setTab] = useState<Tab | undefined>();
  const [seenRole, setSeenRole] = useState<string | undefined>();
  useEffect(() => {
    if (!role) return;
    if (!tab) setTab(DEFAULT_TAB[role] ?? 'pick');
    else if (seenRole && seenRole !== role) {
      // 被调到别的岗位（或到时间调回来）：切换到新岗位的页面并提示；手上有任务时先不切页，免得丢掉做到一半的步骤
      const busy = !!taskOf(client.state, auth.actor);
      if (!busy) setTab(DEFAULT_TAB[role] ?? 'pick');
      const name = t(ROLE_TEXT[role] ?? role);
      const until = client.state.roleChanges?.[auth.actor]?.until;
      const text = !client.state.roles[auth.actor] ? t('你已回到{0}', name) : until !== undefined ? t('你已被调到{0}，{1} 回原岗位', name, clock(until)) : t('你已被调到{0}', name);
      toast(busy ? `${text}${t('（手上的任务做完后再去）')}` : text, 'ok');
    }
    setSeenRole(role);
  }, [role, tab, seenRole]);
  // 排队中的调动（决策记录 0026）：带班负责人安排做完手上的再去
  const queuedRole = client.state.pendingMoves?.[auth.actor]?.role;
  const [seenQueued, setSeenQueued] = useState<string | undefined>();
  useEffect(() => {
    if (queuedRole && queuedRole !== seenQueued) toast(t('带班负责人安排你做完手上的就去{0}', t(ROLE_TEXT[queuedRole] ?? queuedRole)), 'info');
    setSeenQueued(queuedRole);
  }, [queuedRole, seenQueued]);
  const current = tab ?? 'pick';
  const picking = !!activeWalkOf(client.state, auth.actor);
  // 角标不含自动运营的订单（和拣货、交付页一致）
  const toStage = toStageTotes(client.state).length;
  const arrived = client.statics ? handoffBoard(client.state, client.statics, now).filter((r) => r.arrivedAt !== undefined && !r.session && r.orderIds.some((id) => client.state.orders[id]?.track !== 'AUTO')).length : 0;
  const invBadge =
    Object.values(client.state.repl).filter((x) => x.status === 'OPEN').length +
    Object.values(client.state.exceptions).filter((x) => x.status === 'OPEN').length +
    Object.values(client.state.checks).filter((x) => x.status === 'OPEN').length;
  const recBadge = rosterRole === 'LEAD' ? openRecs(client.state).length : 0;
  const mods = client.statics?.modules;
  const hasExt = !!mods && (mods.mto || mods.returns || mods.oversized || mods.parcel);
  const ext = hasExt ? extBadge(client.state) : 0;
  const tabs: Array<{ id: Tab; label: string; badge?: number | string }> = [
    { id: 'pick', label: t('拣货'), ...(picking ? { badge: '●' } : {}) },
    { id: 'stage', label: t('暂存'), ...(toStage ? { badge: toStage } : {}) },
    { id: 'handoff', label: t('交付'), ...(arrived ? { badge: arrived } : {}) },
    { id: 'inventory', label: t('库存'), ...(invBadge ? { badge: invBadge } : {}) },
    // 扩展模块（决策记录 0011）：门店启用了才显示
    ...(hasExt ? [{ id: 'ext' as const, label: t('扩展'), ...(ext ? { badge: ext } : {}) }] : []),
    // 带班负责人处理 AI 建议（决策记录 0010）
    ...(rosterRole === 'LEAD' ? [{ id: 'ai' as const, label: t('AI'), ...(recBadge ? { badge: recBadge } : {}) }] : []),
    { id: 'more', label: t('更多') },
  ];
  return (
    <div className="shell">
      <StatusBar onNudge={(to) => to !== 'none' && to !== 'console' && (to !== 'ai' || rosterRole === 'LEAD') && setTab(to)} />
      <main className="content">
        {/* 数字孪生的设备告警（决策记录 0016）：按岗位显示，带班负责人可以确认 */}
        {client.statics && <AlertBanner {...(rosterRole ? { rosterRole } : {})} {...(role ? { role } : {})} />}
        {/* 突发状况进行中（决策记录 0024 · E4）：每个人看到自己岗位的清单 */}
        {client.statics && <IncidentBanner />}
        {/* 手上没活时的「下一步」（决策记录 0024 · D3）；带班负责人不显示 */}
        {client.statics && rosterRole !== 'LEAD' && current !== 'more' && <NextTaskCard current={current} onGo={(to) => setTab(to)} />}
        {!client.statics ? (
          <p className="muted center">{t('正在同步门店数据…')}</p>
        ) : current === 'pick' ? (
          <PickScreen onDone={() => setTab('stage')} />
        ) : current === 'stage' ? (
          <StageScreen />
        ) : current === 'handoff' ? (
          <HandoffScreen />
        ) : current === 'inventory' ? (
          <InventoryScreen />
        ) : current === 'ext' ? (
          <ExtScreen />
        ) : current === 'ai' ? (
          <AiScreen />
        ) : (
          <MoreScreen {...(onSignOut ? { onSignOut } : {})} />
        )}
      </main>
      <nav className="tabbar" aria-label={t('功能')}>
        {tabs.map((x) => (
          <button key={x.id} className={current === x.id ? 'on' : ''} onClick={() => setTab(x.id)} aria-current={current === x.id ? 'page' : undefined}>
            <span className={`tab-icon icon-${x.id}`} aria-hidden />
            {x.label}
            {x.badge !== undefined && <em>{x.badge}</em>}
          </button>
        ))}
      </nav>
    </div>
  );
}
