import { useEffect, useState } from 'react';
import { activeWalkOf, handoffBoard, openRecs, roleOf } from '@storewright/ops';
import { saveAuth, loadAuth, LiveProvider, useLive, useNow, type Auth } from './live';
import { signIn } from './api';
import { DEMO, link } from './demo/transport';
import { t, useLang } from './i18n';
import { AiScreen } from './screens/AiScreen';
import { ConsoleScreen } from './screens/ConsoleScreen';
import { ExtScreen, extBadge } from './screens/ext/ExtScreen';
import { HandoffScreen } from './screens/HandoffScreen';
import { InventoryScreen } from './screens/InventoryScreen';
import { MoreScreen } from './screens/MoreScreen';
import { PickScreen } from './screens/PickScreen';
import { Logo, SignIn } from './screens/SignIn';
import { StageScreen } from './screens/StageScreen';
import { toast, Toasts } from './ui/Toasts';
import { ROLE_TEXT } from './screens/AiScreen';

type Tab = 'pick' | 'stage' | 'handoff' | 'inventory' | 'ext' | 'ai' | 'more';

/** 演示模式下地址栏的 ?as=A01（或 console）与 ?store=hardware：展示页的 iframe 直接以某个身份打开 */
const QUERY = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const AUTO_AS = DEMO ? QUERY.get('as') : null;
const AUTO_STORE = QUERY.get('store') || 'demo';

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
  useEffect(() => {
    if (auth || !AUTO_AS) return;
    void signIn(AUTO_STORE, AUTO_AS === 'console' ? { role: 'console' } : { associateId: AUTO_AS })
      .then((a) => {
        saveAuth(a);
        setAuth(a);
      })
      .catch(() => toast(t('登录失败'), 'error'));
  }, []);
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
          {auth.role === 'console' ? <ConsoleShell onSignOut={signOut} /> : <AssociateShell onSignOut={signOut} />}
        </LiveProvider>
      )}
      <Toasts />
    </>
  );
}

/** 演示模式：第一次打开某家店时，中枢要建店并用本店的仿真历史训练 AI 模型 */
function DemoBanner() {
  const [training, setTraining] = useState(false);
  useEffect(() => link.onStatus((x) => setTraining(x === 'training')), []);
  if (!training) return null;
  return <div className="demo-banner">{t('正在浏览器里建店，并用本店的仿真历史训练 AI 模型（第一次需要几秒）…')}</div>;
}

function StatusBar({ onSignOut }: { onSignOut?: () => void }) {
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
      {onSignOut && (
        <button className="link" onClick={onSignOut}>
          {t('退出')}
        </button>
      )}
    </header>
  );
}

function ConsoleShell({ onSignOut }: { onSignOut: () => void }) {
  const { client } = useLive();
  const [view, setView] = useState<'console' | 'ai'>('console');
  const open = openRecs(client.state).length;
  return (
    <div className="shell console-shell">
      <StatusBar onSignOut={onSignOut} />
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
        {view === 'console' ? <ConsoleScreen /> : <AiScreen />}
      </main>
    </div>
  );
}

const DEFAULT_TAB: Record<string, Tab> = { PICK: 'pick', STAGE: 'stage', HANDOFF: 'handoff', LEAD: 'handoff', BACKROOM: 'inventory', RESTOCK: 'inventory', DELI: 'ext' };

function AssociateShell({ onSignOut }: { onSignOut: () => void }) {
  const { client, auth } = useLive();
  // 权限看名单上的岗位（带班负责人）；默认页面看当前岗位（可能被临时调动）
  const rosterRole = client.statics?.roster.find((a) => a.id === auth.actor)?.role;
  const role = roleOf(client.statics, client.state, auth.actor);
  const [tab, setTab] = useState<Tab | undefined>();
  const [seenRole, setSeenRole] = useState<string | undefined>();
  useEffect(() => {
    if (!role) return;
    if (!tab) setTab(DEFAULT_TAB[role] ?? 'pick');
    else if (seenRole && seenRole !== role) {
      // 被调到别的岗位：切换到新岗位的页面并提示
      setTab(DEFAULT_TAB[role] ?? 'pick');
      toast(t('你已被调到{0}', t(ROLE_TEXT[role] ?? role)), 'ok');
    }
    setSeenRole(role);
  }, [role, tab, seenRole]);
  const now = useNow(5000);
  const current = tab ?? 'pick';
  const picking = !!activeWalkOf(client.state, auth.actor);
  const toStage = Object.values(client.state.totes).filter((x) => x.status === 'PICKED').length;
  const arrived = client.statics ? handoffBoard(client.state, client.statics, now).filter((r) => r.arrivedAt !== undefined && !r.session).length : 0;
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
      <StatusBar />
      <main className="content">
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
          <MoreScreen onSignOut={onSignOut} />
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
