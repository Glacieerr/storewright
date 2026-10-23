import { useEffect, useState } from 'react';
import { signIn, storeInfo } from '../api';
import { getLang, setLang, t, useLang } from '../i18n';
import type { Auth } from '../live';
import { DEMO } from '../demo/transport';

const ROLE_TEXT: Record<string, string> = { PICK: '拣货', STAGE: '暂存', HANDOFF: '交付', LEAD: '班组长', BACKROOM: '后仓收货', RESTOCK: '补货', DELI: '熟食' };

/** 登录：演示阶段从员工名单中选择身份（不使用密码）；控制台代替订单平台、顾客和司机 */
export function SignIn({ onSignedIn }: { onSignedIn: (a: Auth) => void }) {
  useLang();
  const [storeId, setStoreId] = useState(() => new URLSearchParams(location.search).get('store') || 'demo');
  const [roster, setRoster] = useState<Array<{ id: string; name: string; role: string }> | null>(null);
  const [error, setError] = useState('');
  // 大型店有几百名员工（决策记录 0014）：名单多时先搜索（名字或员工编号）、按岗位筛选，只显示前 60 个
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  useEffect(() => {
    setRoster(null);
    setError('');
    storeInfo(storeId)
      .then((s) => setRoster(s.roster))
      .catch((e: unknown) => setError(DEMO ? t('找不到这家演示门店（可以用 demo 或 hardware）') : String(e).includes('store_not_found') ? t('找不到这家门店，请检查门店编号') : t('连不上服务器，请确认后端已经启动')));
  }, [storeId]);
  const go = async (body: { associateId: string } | { role: 'console' }) => {
    try {
      onSignedIn(await signIn(storeId, body));
    } catch {
      setError(t('登录失败'));
    }
  };
  const big = (roster?.length ?? 0) > 24;
  const needle = query.trim().toLowerCase();
  const matches = (roster ?? []).filter((a) => (!role || a.role === role) && (!needle || a.name.toLowerCase().includes(needle) || a.id.toLowerCase().includes(needle)));
  const shown = big ? matches.slice(0, 60) : matches;
  return (
    <div className="signin">
      <header className="signin-head">
        <Logo />
        <div>
          <h1>Storewright</h1>
          <p className="muted">{t('员工作业端')}</p>
        </div>
        <button className="lang" onClick={() => setLang(getLang() === 'zh' ? 'en' : 'zh')}>
          {getLang() === 'zh' ? 'EN' : '中文'}
        </button>
      </header>
      <label className="field">
        {t('门店')}
        <input value={storeId} onChange={(e) => setStoreId(e.target.value.trim())} />
      </label>
      {error && <p className="banner error">{error}</p>}
      <h2 className="section-title">{t('选择你的身份')}</h2>
      {big && (
        <div className="roster-search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const exact = (roster ?? []).find((a) => a.id.toLowerCase() === query.trim().toLowerCase());
              if (exact) void go({ associateId: exact.id });
            }}
            placeholder={t('搜索名字或员工编号（输入编号后按回车直接登录）')}
            aria-label={t('搜索员工')}
          />
          <div className="chips">
            <button className={role === '' ? 'chip on' : 'chip'} onClick={() => setRole('')}>
              {t('全部 {0}', roster?.length ?? 0)}
            </button>
            {Object.keys(ROLE_TEXT)
              .filter((r) => roster?.some((a) => a.role === r))
              .map((r) => (
                <button key={r} className={role === r ? 'chip on' : 'chip'} onClick={() => setRole(role === r ? '' : r)}>
                  {t(ROLE_TEXT[r] ?? r)} {roster?.filter((a) => a.role === r).length}
                </button>
              ))}
          </div>
          {matches.length > shown.length && <p className="muted">{t('共 {0} 人符合，显示前 {1} 个；输入名字或编号缩小范围', matches.length, shown.length)}</p>}
        </div>
      )}
      <div className="roster">
        {shown.map((a) => (
          <button key={a.id} className="person" onClick={() => void go({ associateId: a.id })}>
            <span className="avatar" aria-hidden>
              {a.name.slice(0, 1)}
            </span>
            <b>{a.name}</b>
            <small>{t(ROLE_TEXT[a.role] ?? a.role)}</small>
          </button>
        ))}
        {roster === null && !error && <p className="muted">{t('加载中…')}</p>}
      </div>
      <button className="block console-btn" onClick={() => void go({ role: 'console' })}>
        {t('演示控制台（订单平台 / 顾客 / 司机）')}
      </button>
      {DEMO && <p className="note">{t('浏览器内演示：整个后端在你的浏览器里运行，数据保存在本机浏览器里；同一个网站打开的其他标签页会实时同步。门店 demo 是中型超市，hardware 是家居建材店。')}</p>}
      <p className="note">{t('演示版本：不使用密码，身份只用于记录是谁做的操作。本项目与任何零售商、企业无隶属关系。')}</p>
    </div>
  );
}

export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 40 40" aria-hidden>
      <rect x="2" y="2" width="36" height="36" rx="10" fill="var(--brand)" />
      <path d="M11 25.5c2.2 2 4.9 3 8.2 3 4.3 0 7.3-2 7.3-5.3 0-2.9-2-4.2-6.1-5.1-2.9-.6-3.9-1.1-3.9-2.2s1.1-1.8 3-1.8c2 0 3.8.7 5.3 1.9l2-3c-1.9-1.6-4.3-2.4-7.2-2.4-4.1 0-6.9 2.2-6.9 5.4 0 3 2.1 4.3 6 5.1 2.9.6 4 1.1 4 2.3 0 1.2-1.3 1.9-3.3 1.9-2.4 0-4.4-.9-6.2-2.5L11 25.5Z" fill="#fff" />
    </svg>
  );
}
