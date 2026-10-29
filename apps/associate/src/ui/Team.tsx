import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { canManageAi, MOVABLE_ROLES, onDuty, ROLE_ORDER, teamBoard, type AssociateRole, type StoreStatic, type TeamMember, type TeamTask } from '@storewright/ops';
import { clock, t } from '../i18n';
import { useLive, useNow } from '../live';
import { ROLE_TEXT } from '../screens/AiScreen';
import { toast } from './Toasts';

/**
 * 在岗人员（决策记录 0025）：每台设备的顶栏都有「在岗」按钮，看谁此刻在哪个岗位、在做什么、各岗位排着多少活。
 * 带班负责人和控制台在这里调配：选「调多久」，再点「调到……」；到时间由门店的定时节拍自动调回原岗位。
 * 决策记录 0026：手上有任务的人默认「做完这一单再去」（排队）；熟食也可以调；调到后仓时提示有没有后仓补取的授权。
 */

const DURATIONS: ReadonlyArray<{ min?: number; label: string }> = [{ min: 30, label: '30 分钟' }, { min: 60, label: '1 小时' }, { min: 120, label: '2 小时' }, { label: '不限时' }];

const roleName = (r: string) => t(ROLE_TEXT[r] ?? r);
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function taskText(x: TeamTask): string {
  switch (x.kind) {
    case 'WALK':
      return t('拣货中 · {0}', x.ref);
    case 'HANDOFF':
      return t('交付中 · {0}', x.ref);
    case 'EXCEPTION':
      return t('后仓补取中');
    case 'RESTOCK':
      return t('补货中');
    case 'COUNT':
      return t('盘点中');
  }
}

function queueText(role: AssociateRole, n: number): string {
  if (role === 'PICK') return t('待领批次 {0}', n);
  if (role === 'STAGE') return t('待暂存 {0} 框', n);
  if (role === 'HANDOFF') return t('到店等候 {0}', n);
  if (role === 'RESTOCK') return t('补货任务 {0}', n);
  if (role === 'BACKROOM') return t('后仓补取 {0}', n);
  return '';
}

/** 临时调动：「临时 · 14:30 回拣货」，不限时的是「临时 · 原岗位拣货」 */
export function movedText(m: TeamMember): string {
  if (!m.moved) return '';
  return m.moved.until !== undefined ? t('临时 · {0} 回{1}', clock(m.moved.until), roleName(m.base)) : t('临时 · 原岗位{0}', roleName(m.base));
}

function offText(m: TeamMember, now: number): string {
  if (m.absent) return t('请假');
  const d = new Date(now);
  const minute = d.getHours() * 60 + d.getMinutes();
  if (m.shift && m.shift.from > minute) return t('{0} 上班', hm(m.shift.from));
  if (m.shift) return t('已下班');
  return t('今天不上班');
}

export function TeamBoardView() {
  const { client, auth, run } = useLive();
  const now = useNow(15_000);
  const st = client.statics as StoreStatic;
  const can = canManageAi(st, auth.actor);
  const [open, setOpen] = useState<string | undefined>();
  const [minutes, setMinutes] = useState<number | undefined>(60);
  const [whenFree, setWhenFree] = useState(true);
  const [showOff, setShowOff] = useState(false);
  const board = teamBoard(st, client.state, now);
  const on = board.members.filter((m) => m.on);
  const off = board.members.filter((m) => !m.on);
  // 有人或有活排着的岗位才列出来；有活没人的岗位标出来
  const groups = ROLE_ORDER.map((role) => ({ role, people: on.filter((m) => m.role === role), queue: board.queue[role] ?? 0 })).filter((g) => g.people.length > 0 || g.queue > 0);
  const moved = on.filter((m) => m.moved).length;

  const move = async (m: TeamMember, to: AssociateRole) => {
    const back = to === m.base;
    const queue = !!m.task && whenFree && !back;
    const ok = await run({ type: 'ChangeRole', associateId: m.id, role: to, ...(!back && minutes ? { minutes } : {}), ...(queue ? { whenFree: true } : {}) }, { quiet: true });
    if (!ok) return;
    setOpen(undefined);
    if (queue && m.task) toast(t('{0} 做完手上的（{1}）就去{2}', m.name, taskText(m.task), roleName(to)), 'ok');
    else if (back) toast(t('{0} 已回到{1}', m.name, roleName(to)), 'ok');
    else if (minutes) toast(t('已把 {0} 调到{1}，{2} 自动回{3}', m.name, roleName(to), clock(client.now() + minutes * 60_000), roleName(m.base)), 'ok');
    else toast(t('已把 {0} 调到{1}', m.name, roleName(to)), 'ok');
  };

  const row = (m: TeamMember) => {
    const info = st.roster.find((a) => a.id === m.id);
    const movable = can && info?.role !== 'LEAD';
    const expanded = open === m.id;
    // 会做的岗位：名单上的岗位和登记的技能
    const knows = (r: AssociateRole) => info?.role === r || !!info?.skills?.includes(r);
    return (
      <li key={m.id} className={`team-row${m.id === auth.actor ? ' me' : ''}`}>
        <div className="team-line">
          <span className="strong">{m.name}</span>
          {m.id === auth.actor && <span className="tag">{t('你')}</span>}
          {!m.on ? <span className="muted small">{offText(m, now)}</span> : m.task ? <span className="tag busy-tag">{taskText(m.task)}</span> : m.role !== 'LEAD' && <span className="muted small">{t('空闲')}</span>}
          {m.moved && <span className="tag temp-tag">{movedText(m)}</span>}
          {m.queued && <span className="tag temp-tag">{t('做完后去{0}', roleName(m.queued.role))}</span>}
          {m.locked && <span className="tag">{t('固定')}</span>}
          {movable && (
            <button className="chip team-toggle" aria-expanded={expanded} onClick={() => setOpen(expanded ? undefined : m.id)}>
              {expanded ? t('收起') : t('调配')}
            </button>
          )}
        </div>
        {expanded && (
          <div className="team-move">
            {m.queued && (
              <p className="note">
                {t('排着：做完手上的去{0}', roleName(m.queued.role))}{' '}
                <button className="link" onClick={() => void run({ type: 'ChangeRole', associateId: m.id, role: m.role }, { quiet: true })}>
                  {t('取消排队')}
                </button>
              </p>
            )}
            {m.task && (
              <div className="team-dur" role="radiogroup" aria-label={t('手上还有任务（{0}）', taskText(m.task))}>
                <span className="muted small">{t('手上还有任务（{0}）', taskText(m.task))}</span>
                <button role="radio" aria-checked={whenFree} className={`chip${whenFree ? ' on' : ''}`} onClick={() => setWhenFree(true)}>
                  {t('做完这一单再去')}
                </button>
                <button role="radio" aria-checked={!whenFree} className={`chip${!whenFree ? ' on' : ''}`} onClick={() => setWhenFree(false)}>
                  {t('马上调（手上的仍由本人做完）')}
                </button>
              </div>
            )}
            {!info?.exceptionAuthorized && m.role !== 'BACKROOM' && <p className="note">{t('调到后仓：{0} 没有后仓补取的授权，只做收货、上架和盘点。', m.name)}</p>}
            <div className="team-dur" role="radiogroup" aria-label={t('调多久')}>
              <span className="muted small">{t('调多久')}</span>
              {DURATIONS.map((d) => (
                <button key={d.label} role="radio" aria-checked={minutes === d.min} className={`chip${minutes === d.min ? ' on' : ''}`} onClick={() => setMinutes(d.min)}>
                  {t(d.label)}
                </button>
              ))}
            </div>
            <div className="team-targets">
              {m.moved && (
                <button className="chip on" onClick={() => void move(m, m.base)}>
                  {t('回到{0}', roleName(m.base))}
                </button>
              )}
              {MOVABLE_ROLES.filter((r) => r !== m.role && r !== m.base).map((r) => (
                <button key={r} className={`chip${knows(r) ? ' knows' : ''}`} title={knows(r) ? t('会做这个岗位') : t('没有登记这个岗位的技能')} onClick={() => void move(m, r)}>
                  {t('调到{0}', roleName(r))}
                  {knows(r) && <small aria-hidden> ✓</small>}
                </button>
              ))}
            </div>
            <button className="link" onClick={() => void run({ type: 'LockAssociate', associateId: m.id, locked: !m.locked }, { quiet: true })}>
              {m.locked ? t('取消固定') : t('固定')}
            </button>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="team">
      <p className="note">
        {t('在岗 {0} 人', on.length)}
        {moved > 0 && ` · ${t('临时调动 {0} 人', moved)}`}
        {' · '}
        {can ? t('点「调配」选调多久和调到哪个岗位，到时间自动回原岗位；固定的人 AI 不会建议调动。✓ 表示会做这个岗位。') : t('调配由带班负责人操作。')}
      </p>
      {groups.map((g) => (
        <section key={g.role} className={`team-group${g.queue > 0 && g.people.length === 0 ? ' short' : ''}`} aria-label={roleName(g.role)}>
          <h4>
            <span>{roleName(g.role)}</span>
            <span className="muted">{t('{0} 人', g.people.length)}</span>
            {g.queue > 0 && <span className={`tag${g.people.length === 0 ? ' warn-tag' : ''}`}>{queueText(g.role, g.queue)}</span>}
          </h4>
          {g.people.length > 0 && <ul className="plain team-list">{g.people.map(row)}</ul>}
        </section>
      ))}
      {off.length > 0 && (
        <section className="team-group off">
          <button className="link" aria-expanded={showOff} onClick={() => setShowOff(!showOff)}>
            {showOff ? t('收起不在岗的人') : t('不在岗（{0}）', off.length)}
          </button>
          {showOff && <ul className="plain team-list">{off.map(row)}</ul>}
        </section>
      )}
    </div>
  );
}

/** 顶栏的「在岗」按钮：点开是在岗人员面板（挂到 body 上，不被标签栏盖住） */
export function TeamButton() {
  const { client } = useLive();
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const st = client.statics;
  if (!st) return null;
  const n = st.roster.filter((a) => onDuty(st, client.state, a.id, now)).length;
  return (
    <>
      <button className="team-btn" aria-label={t('在岗人员（{0} 人）', n)} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span aria-hidden>👥</span>
        <em>{n}</em>
      </button>
      {open &&
        createPortal(
          <div className="sheet" role="dialog" aria-label={t('在岗人员')} onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
            <div className="sheet-body team-sheet">
              <h3>{t('在岗人员')}</h3>
              <TeamBoardView />
              <div className="sheet-foot">
                <button className="link" onClick={() => setOpen(false)}>
                  {t('关闭')}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
