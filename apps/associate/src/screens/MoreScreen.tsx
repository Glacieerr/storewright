import { useState } from 'react';
import { labelUrl } from '../api';
import { AskPanel } from './AskPanel';
import { MyShifts } from './ScheduleScreen';
import { setSopTipsPref, sopTipsOn } from '../ui/SopTip';
import { getLang, setLang, t, useLang } from '../i18n';
import { StoreSettingsCard } from '../ui/StoreSettings';
import { useLive } from '../live';

/** 更多：语言、连接状态、标签打印、退出 */
export function MoreScreen({ onSignOut }: { onSignOut?: () => void }) {
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
        {onSignOut ? <button onClick={onSignOut}>{t('退出登录')}</button> : <p className="note">{t('在展示页里，用手机上方的选择框切换员工。')}</p>}
      </section>
      {/* 排班与补位（决策记录 0022）：这一周自己的班次、补班 / 提前下班的邀请 */}
      <MyShifts />
      {/* 现场操作提示（决策记录 0024 · D4） */}
      <SopTipsToggle />
      {/* 门店设置（决策记录 0026）：带班负责人可以改 */}
      {isLead && <StoreSettingsCard />}
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

/** 现场操作提示的开关：入职两周内默认打开；看过的提示数和小测验成绩只给本人看 */
function SopTipsToggle() {
  const { client, auth } = useLive();
  const me = client.statics?.roster.find((a) => a.id === auth.actor);
  const [on, setOn] = useState(() => sopTipsOn(me?.hiredAt));
  const acks = Object.values(client.state.sopAcks?.[auth.actor] ?? {});
  const quiz = acks.filter((x) => x.total);
  return (
    <section className="card">
      <h2 className="section-title">{t('现场操作提示')}</h2>
      <label className="toggle">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked);
            setSopTipsPref(e.target.checked ? 'on' : 'off');
          }}
        />
        {t('第一次遇到某种情况时弹出操作要点（入职两周内默认打开）')}
      </label>
      {acks.length > 0 && <p className="note">{t('看过 {0} 条提示{1}', acks.length, quiz.length ? t('，小测验答对 {0} / {1}', quiz.reduce((a, x) => a + (x.correct ?? 0), 0), quiz.reduce((a, x) => a + (x.total ?? 0), 0)) : '')}</p>}
    </section>
  );
}
