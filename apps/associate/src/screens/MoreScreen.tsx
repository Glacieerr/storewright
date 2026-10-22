import { useState } from 'react';
import { labelUrl } from '../api';
import { AskPanel } from './AskPanel';
import { getLang, setLang, t, useLang } from '../i18n';
import { useLive } from '../live';

/** 更多：语言、连接状态、标签打印、退出 */
export function MoreScreen({ onSignOut }: { onSignOut: () => void }) {
  useLang();
  const { client, auth, nameOf } = useLive();
  const [asking, setAsking] = useState(false);
  // 带班负责人在「AI → 问答」里使用助手
  const isLead = client.statics?.roster.find((a) => a.id === auth.actor)?.role === 'LEAD';
  return (
    <div className="more">
      <section className="card">
        <h2 className="section-title">{t('我')}</h2>
        <p>
          {nameOf(auth.actor)} · <span className="mono">{auth.actor}</span>
        </p>
        <button onClick={onSignOut}>{t('退出登录')}</button>
      </section>
      {!isLead && (
        <section className="card">
          <h2 className="section-title">{t('问助手')}</h2>
          {asking ? (
            <AskPanel />
          ) : (
            <button className="block" onClick={() => setAsking(true)}>
              {t('打开本地助手与门店经验')}
            </button>
          )}
        </section>
      )}
      <section className="card">
        <h2 className="section-title">{t('语言')}</h2>
        <div className="segmented">
          <button className={getLang() === 'zh' ? 'on' : ''} onClick={() => setLang('zh')}>
            中文
          </button>
          <button className={getLang() === 'en' ? 'on' : ''} onClick={() => setLang('en')}>
            English
          </button>
        </div>
      </section>
      <section className="card">
        <h2 className="section-title">{t('连接')}</h2>
        <ul className="plain">
          <li>{t('状态：{0}', client.status === 'live' ? t('在线') : client.status === 'connecting' ? t('连接中') : t('离线'))}</li>
          <li>{t('往返延迟：{0} ms', Math.round(client.rtt))}</li>
          <li>{t('事件序号：{0}', client.state.seq)}</li>
          <li>{t('待提交的离线操作：{0}', client.outbox.length)}</li>
        </ul>
      </section>
      <section className="card">
        <h2 className="section-title">{t('标签')}</h2>
        <a className="button" href={labelUrl(auth, 'slots')} target="_blank" rel="noreferrer">
          {t('打印暂存格位标签')}
        </a>
      </section>
    </div>
  );
}
