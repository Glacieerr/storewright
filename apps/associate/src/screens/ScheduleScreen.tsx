import { useState } from 'react';
import { scoreSchedule } from '@storewright/ai';
import { dateInWeek, dateOf, myOffers, myWeek, ROLE_ORDER, scheduleAssociates, shiftsOn, weekOf, type AssociateRole, type StoreStatic } from '@storewright/ops';
import { ai, type ScheduleDraft } from '../api';
import { t } from '../i18n';
import { useLive } from '../live';
import { toast } from '../ui/Toasts';
import { ROLE_TEXT } from './AiScreen';

/**
 * 排班与补位（决策记录 0022 · D1、D2）。
 * - 带班负责人和控制台：AI 按订单量预测和名单生成一周排班草稿（硬约束全部满足，缺口写明原因），确认后发布；报告缺勤后 AI 找人补班；
 * - 每位员工：这一周自己的班次，补班 / 延长 / 提前下班的邀请（自己接受或拒绝）。
 * - 决策记录 0026：草稿发布前可以改（点格子改时间、岗位，删掉或加一个班）。
 */

const WEEKDAY = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const WHY_TEXT: Record<string, string> = { NO_ONE_AVAILABLE: '这段时间没有能上班的人', WEEKLY_LIMIT: '能上的人这周工时都满了', NO_SKILL: '没有人会这个岗位', EDITED: '改草稿后空出来的' };

/**
 * 改过的草稿重新打分（决策记录 0026）：缺口、多排、工时、规则检查都按改后的班表算（和生成草稿同一套）；
 * 缺口按新的覆盖重新找连续缺人的时段，和 AI 草稿的缺口重叠的沿用原来的原因，其余是改出来的。
 */
function rescore(d: ScheduleDraft, roster: StoreStatic['roster']): ScheduleDraft {
  const shifts = d.shifts.map((x) => ({ associateId: x.associateId, day: d.dates.indexOf(x.date), from: x.from, to: x.to, role: x.role })).filter((x) => x.day >= 0);
  const res = scoreSchedule(shifts, scheduleAssociates(roster), d.need, d.rules ?? {});
  const gaps: ScheduleDraft['gaps'] = [];
  for (const n of d.need) {
    const row = res.cover[n.day]?.[n.role] ?? [];
    for (let k = 0; k < n.slots.length; ) {
      if ((row[k] ?? 0) >= (n.slots[k] ?? 0)) {
        k++;
        continue;
      }
      const start = k;
      let short = 0;
      for (; k < n.slots.length && (row[k] ?? 0) < (n.slots[k] ?? 0); k++) short += (n.slots[k] ?? 0) - (row[k] ?? 0);
      const from = start * 30;
      const to = k * 30;
      const ai = d.gaps.find((g) => g.day === n.day && g.role === n.role && g.from < to && g.to > from && g.why !== 'EDITED');
      gaps.push({ day: n.day, role: n.role, from, to, heads: Math.round((short / (k - start)) * 10) / 10, why: ai?.why ?? 'EDITED' });
    }
  }
  return { ...d, metrics: res.metrics, cover: res.cover as unknown as ScheduleDraft['cover'], gaps };
}

/** 规则检查的结果换成人话（改草稿时改出来的问题） */
function violationText(v: string, nameOf: (id: string) => string): string {
  const [id = '', rest = ''] = v.split(': ');
  const who = nameOf(id);
  const day = /day (\d+)/.exec(rest)?.[1];
  const when = day !== undefined ? t(WEEKDAY[Number(day)] ?? '') : '';
  if (rest.startsWith('two shifts')) return t('{0}：{1}排了两个班', who, when);
  if (rest.startsWith('no skill')) return t('{0}：没有登记「{1}」这个岗位的技能', who, roleText(rest.slice('no skill '.length)));
  if (rest.startsWith('shift shorter')) return t('{0}：{1}的班太短', who, when);
  if (rest.startsWith('shift longer')) return t('{0}：{1}的班太长', who, when);
  if (rest.startsWith('outside availability')) return t('{0}：{1}不在能上班的时间里', who, when);
  if (rest.startsWith('rest under')) return t('{0}：两个班之间休息不够', who);
  if (rest.startsWith('more than')) return t('{0}：这周上班天数太多', who);
  if (rest.startsWith('over the weekly')) return t('{0}：这周工时超过上限', who);
  return v;
}
export const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const roleText = (r: string) => t(ROLE_TEXT[r] ?? r);

/** 自己这一周的班次和邀请（「更多」页） */
export function MyShifts() {
  const { client, auth, run } = useLive();
  const s = client.state;
  const today = dateOf(Date.now());
  const week = weekOf(today);
  const mine = myWeek(s, auth.actor, week);
  const offers = myOffers(s, auth.actor);
  const published = !!s.schedules?.[week];
  return (
    <section className="card">
      <h2 className="section-title">{t('我的班次')}</h2>
      {offers.map((o) => (
        <div key={o.id} className="offer">
          <p className="strong">
            {o.kind === 'EXTRA'
              ? t('补班邀请：{0} {1}–{2}（{3}）', o.date, hm(o.from), hm(o.to), roleText(o.role))
              : t('可以提前下班：{0} {1} 起（自愿）', o.date, hm(o.from))}
          </p>
          {o.replaces && <p className="note">{t('顶替 {0} 的班', client.statics?.roster.find((a) => a.id === o.replaces)?.name ?? o.replaces)}</p>}
          <div className="actions">
            <button className="primary" onClick={() => void run({ type: 'RespondShiftOffer', offerId: o.id, accept: true })}>
              {t('接受')}
            </button>
            <button onClick={() => void run({ type: 'RespondShiftOffer', offerId: o.id, accept: false })}>{t('不方便')}</button>
          </div>
        </div>
      ))}
      {!published && !mine.length ? (
        <p className="note">{t('这一周还没有发布排班。')}</p>
      ) : mine.length ? (
        <ul className="plain my-shifts">
          {mine.map((x) => (
            <li key={x.id} className={x.date === today ? 'today' : ''}>
              <span>{t(WEEKDAY[(new Date(`${x.date}T12:00:00`).getDay() + 6) % 7] ?? '')}</span>
              <span className="mono">{x.date.slice(5)}</span>
              <b className="mono">
                {hm(x.from)}–{hm(x.to)}
              </b>
              <span className="tag">{roleText(x.role)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">{t('这一周没有给你排班。')}</p>
      )}
    </section>
  );
}

/** 排班（带班负责人和控制台，AI 页的「排班」） */
export function ScheduleView() {
  const { client, auth, run } = useLive();
  const s = client.state;
  const st = client.statics as StoreStatic;
  const today = dateOf(Date.now());
  const [which, setWhich] = useState<'this' | 'next'>('next');
  const week = which === 'this' ? weekOf(today) : weekOf(dateOf(Date.now() + 7 * 86_400_000));
  const [draft, setDraft] = useState<ScheduleDraft | undefined>();
  const [busy, setBusy] = useState(false);
  const [day, setDay] = useState(0);
  const [edit, setEdit] = useState<{ associateId: string; date: string } | undefined>();
  const [edited, setEdited] = useState(0);
  const published = s.schedules?.[week];
  // 改草稿里的一个班（没有 next 就是删掉）；缺口、多排、工时和规则检查按改后的班表重新算（决策记录 0026）
  const saveShift = (associateId: string, date: string, next?: { from: number; to: number; role: string }) => {
    setDraft((d) => {
      if (!d) return d;
      const shifts = [...d.shifts.filter((x) => !(x.associateId === associateId && x.date === date)), ...(next ? [{ associateId, date, ...next }] : [])];
      return rescore({ ...d, shifts }, st.roster);
    });
    setEdited((n) => n + 1);
    setEdit(undefined);
  };
  const nameOf = (id: string) => st.roster.find((a) => a.id === id)?.name ?? id;
  const generate = async () => {
    setBusy(true);
    try {
      const d = await ai.scheduleDraft(auth, week);
      setDraft(d);
      setDay(0);
      setEdited(0);
      setEdit(undefined);
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const shown = draft?.week === week ? draft : undefined;
  return (
    <div className="list">
      <div className="segmented">
        <button className={which === 'this' ? 'on' : ''} onClick={() => setWhich('this')}>
          {t('本周（{0} 起）', weekOf(today).slice(5))}
        </button>
        <button className={which === 'next' ? 'on' : ''} onClick={() => setWhich('next')}>
          {t('下周（{0} 起）', weekOf(dateOf(Date.now() + 7 * 86_400_000)).slice(5))}
        </button>
      </div>
      <section className="card">
        <div className="card-head">
          <span className="strong">{published ? t('已发布排班') : t('还没有发布排班')}</span>
          {published && <span className="due">{t('{0} 发布 · {1} 个班', new Date(published.publishedAt).toLocaleString(), published.shifts.length)}</span>}
        </div>
        {!published && <p className="note">{t('没有发布排班时按名单判断谁在岗：学生按自己的时段，其他人整天在岗。')}</p>}
        <button className="primary block" disabled={busy} onClick={() => void generate()}>
          {busy ? t('正在生成…') : t('AI 生成这一周的排班草稿')}
        </button>
      </section>
      {shown && (
        <>
          <section className="card">
            <div className="card-head">
              <span className="tag">{t('排班草稿')}</span>
              <span className="strong">{t('总工时 {0} 小时', shown.metrics.totalHours)}</span>
              {edited > 0 && <span className="tag temp-tag">{t('已手动改了 {0} 处（缺口、多排、工时和规则检查已按改后的班表重算）', edited)}</span>}
            </div>
            <div className="facts">
              <span>
                {t('缺口')} <b>{t('{0} 人时', shown.metrics.underHours)}</b>
              </span>
              <span>
                {t('多排')} <b>{t('{0} 人时', shown.metrics.overHours)}</b>
              </span>
              <span>
                {t('违反规则')} <b className={shown.metrics.violations.length ? 'warn-text' : 'good-text'}>{shown.metrics.violations.length}</b>
              </span>
              <span>
                {t('周末班相差')} <b>{shown.metrics.weekendSpread}</b>
              </span>
            </div>
            {shown.metrics.violations.length > 0 && (
              <ul className="plain warn-text">
                {shown.metrics.violations.slice(0, 6).map((v) => (
                  <li key={v}>{violationText(v, nameOf)}</li>
                ))}
              </ul>
            )}
            <p className="note">{t('对照「每人从早上排满 8 小时」的固定班表：缺口 {0} 人时、多排 {1} 人时、总工时 {2} 小时。', shown.naive.underHours, shown.naive.overHours, shown.naive.totalHours)}</p>
            <p className="note">{t('需要的人数由订单量预测换算（每行拣货用时取自拣货时长模型）；后仓、补货、带班负责人按固定覆盖。只按岗位、技能和可上班时间排，不按个人效率；学生上学日只排放学后、每周不超过 20 小时。')}</p>
          </section>
          <div className="chips" role="group" aria-label={t('哪一天')}>
            {shown.dates.map((d, i) => (
              <button key={d} className={`chip${day === i ? ' on' : ''}`} onClick={() => setDay(i)}>
                {t(WEEKDAY[i] ?? '')} {d.slice(5)}
              </button>
            ))}
          </div>
          <CoverChart draft={shown} day={day} />
          {shown.gaps.filter((g) => g.day === day).length > 0 && (
            <section className="card">
              <h3 className="ai-sub">{t('排不上的缺口')}</h3>
              <ul className="plain">
                {shown.gaps
                  .filter((g) => g.day === day)
                  .map((g, i) => (
                    <li key={i}>
                      {t('{0} {1}–{2} 平均缺 {3} 人：{4}', roleText(g.role), hm(g.from), hm(g.to), g.heads, t(WHY_TEXT[g.why] ?? g.why))}
                    </li>
                  ))}
              </ul>
            </section>
          )}
          <p className="note">{t('点格子改这个人这一天的班：时间、岗位，或者删掉；没有班的格子可以加一个。')}</p>
          <section className="card plan-wrap">
            <table className="plan schedule">
              <thead>
                <tr>
                  <th />
                  {shown.dates.map((d, i) => (
                    <th key={d}>{t(WEEKDAY[i] ?? '')}</th>
                  ))}
                  <th>{t('工时')}</th>
                </tr>
              </thead>
              <tbody>
                {st.roster.map((a) => {
                  const mine = shown.shifts.filter((x) => x.associateId === a.id);
                  return (
                    <tr key={a.id}>
                      <th>
                        {a.name}
                        <small>{roleText(a.role)}</small>
                      </th>
                      {shown.dates.map((d) => {
                        const x = mine.find((y) => y.date === d);
                        return (
                          <td key={d} className={x ? (x.role !== a.role ? 'more' : '') : 'less'}>
                            <button className={`cell-btn${edit?.associateId === a.id && edit.date === d ? ' on' : ''}`} onClick={() => setEdit({ associateId: a.id, date: d })} aria-label={t('改 {0} {1} 的班', a.name, d.slice(5))}>
                              {x ? (
                                <>
                                  {hm(x.from)}–{hm(x.to)}
                                  {x.role !== a.role && <small>{roleText(x.role)}</small>}
                                </>
                              ) : (
                                '—'
                              )}
                            </button>
                          </td>
                        );
                      })}
                      <td className="mono">{shown.metrics.hoursBy[a.id] ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
          {edit && (
            <ShiftEditor
              key={`${edit.associateId}|${edit.date}`}
              name={nameOf(edit.associateId)}
              date={edit.date}
              shift={shown.shifts.find((x) => x.associateId === edit.associateId && x.date === edit.date)}
              defaultRole={st.roster.find((a) => a.id === edit.associateId)?.role ?? 'PICK'}
              onSave={(next) => saveShift(edit.associateId, edit.date, next)}
              onRemove={() => saveShift(edit.associateId, edit.date)}
              onCancel={() => setEdit(undefined)}
            />
          )}
          <button className="primary block" onClick={() => void run({ type: 'PublishSchedule', week: shown.week, shifts: shown.shifts.map((x) => ({ ...x, role: x.role as AssociateRole })) })}>
            {published ? t('用这份草稿替换已发布的排班') : t('发布这份排班')}
          </button>
        </>
      )}
      {published && !shown && <PublishedTable week={week} />}
      <AbsenceForm />
    </div>
  );
}

/** 改草稿里的一个班（决策记录 0026） */
function ShiftEditor({ name, date, shift, defaultRole, onSave, onRemove, onCancel }: { name: string; date: string; shift?: { from: number; to: number; role: string }; defaultRole: string; onSave: (x: { from: number; to: number; role: string }) => void; onRemove: () => void; onCancel: () => void }) {
  const [from, setFrom] = useState(hm(shift?.from ?? 9 * 60));
  const [to, setTo] = useState(hm(shift?.to ?? 17 * 60));
  const [role, setRole] = useState(shift?.role ?? defaultRole);
  const toMin = (v: string) => {
    const [h, m] = v.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const valid = /^\d{2}:\d{2}$/.test(from) && /^\d{2}:\d{2}$/.test(to) && toMin(to) > toMin(from);
  return (
    <section className="card shift-editor" aria-label={t('改 {0} {1} 的班', name, date.slice(5))}>
      <h3 className="ai-sub">
        {name} · {date.slice(5)}
      </h3>
      <div className="form-grid">
        <label>
          <span>{t('上班')}</span>
          <input type="time" value={from} step={900} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          <span>{t('下班')}</span>
          <input type="time" value={to} step={900} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          <span>{t('岗位')}</span>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLE_ORDER.map((r) => (
              <option key={r} value={r}>
                {roleText(r)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!valid && <p className="note warn-text">{t('下班时间要晚于上班时间')}</p>}
      <div className="actions">
        <button onClick={onCancel}>{t('取消')}</button>
        {shift && (
          <button className="link danger" onClick={onRemove}>
            {t('删掉这个班')}
          </button>
        )}
        <button className="primary" disabled={!valid} onClick={() => onSave({ from: toMin(from), to: toMin(to), role })}>
          {shift ? t('保存') : t('加这个班')}
        </button>
      </div>
    </section>
  );
}

/** 某一天各岗位需要几人、排了几人（每小时） */
function CoverChart({ draft, day }: { draft: ScheduleDraft; day: number }) {
  const roles = ['PICK', 'HANDOFF', 'STAGE'];
  return (
    <section className="card cover-chart">
      {roles.map((role) => {
        const need = draft.need.find((n) => n.day === day && n.role === role)?.slots ?? [];
        const cover = draft.cover[String(day)]?.[role] ?? [];
        const hours = Array.from({ length: 24 }, (_, h) => h).filter((h) => (need[h * 2] ?? 0) > 0 || (cover[h * 2] ?? 0) > 0);
        if (!hours.length) return null;
        const max = Math.max(1, ...hours.map((h) => Math.max(need[h * 2] ?? 0, cover[h * 2] ?? 0)));
        return (
          <div key={role}>
            <h4>{roleText(role)}</h4>
            <div className="cover-bars">
              {hours.map((h) => {
                const n = need[h * 2] ?? 0;
                const c = cover[h * 2] ?? 0;
                return (
                  <div key={h} title={t('{0} 点：需要 {1} 人，排了 {2} 人', h, n, c)}>
                    <i className={c < n ? 'short' : ''} style={{ height: `${(c / max) * 100}%` }} />
                    <em style={{ bottom: `${(n / max) * 100}%` }} />
                    <small>{h}</small>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <p className="note">{t('柱子是排了几人，横线是需要几人；红色的小时人不够。')}</p>
    </section>
  );
}

function PublishedTable({ week }: { week: string }) {
  const { client } = useLive();
  const st = client.statics as StoreStatic;
  const dates = Array.from({ length: 7 }, (_, d) => dateInWeek(week, d));
  const byDate = new Map(dates.map((d) => [d, shiftsOn(client.state, d)]));
  return (
    <section className="card plan-wrap">
      <table className="plan schedule">
        <thead>
          <tr>
            <th />
            {dates.map((d, i) => (
              <th key={d}>{t(WEEKDAY[i] ?? '')}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {st.roster.map((a) => (
            <tr key={a.id}>
              <th>
                {a.name}
                <small>{roleText(a.role)}</small>
              </th>
              {dates.map((d) => {
                const x = byDate.get(d)?.find((y) => y.associateId === a.id);
                return <td key={d}>{x ? `${hm(x.from)}–${hm(x.to)}` : '—'}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">{t('已经算上接受了的补班 / 延长，去掉了缺勤和提前下班。')}</p>
    </section>
  );
}

/** 报告缺勤：AI 随后在「建议」里给出谁能补这个班 */
function AbsenceForm() {
  const { client, run } = useLive();
  const st = client.statics as StoreStatic;
  const [who, setWho] = useState('');
  const [when, setWhen] = useState<'today' | 'tomorrow'>('today');
  const date = dateOf(Date.now() + (when === 'tomorrow' ? 86_400_000 : 0));
  return (
    <section className="card">
      <h3 className="ai-sub">{t('报告缺勤')}</h3>
      <div className="form-row">
        <select value={who} onChange={(e) => setWho(e.target.value)} aria-label={t('谁')}>
          <option value="">{t('选择员工')}</option>
          {st.roster.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {roleText(a.role)}
            </option>
          ))}
        </select>
        <div className="segmented">
          <button className={when === 'today' ? 'on' : ''} onClick={() => setWhen('today')}>
            {t('今天')}
          </button>
          <button className={when === 'tomorrow' ? 'on' : ''} onClick={() => setWhen('tomorrow')}>
            {t('明天')}
          </button>
        </div>
      </div>
      <button
        className="block"
        disabled={!who}
        onClick={async () => {
          if (await run({ type: 'ReportAbsence', associateId: who, date })) {
            toast(t('已报告缺勤，AI 会在「建议」里给出谁能补这个班'), 'ok');
            setWho('');
          }
        }}
      >
        {t('报告缺勤')}
      </button>
    </section>
  );
}
