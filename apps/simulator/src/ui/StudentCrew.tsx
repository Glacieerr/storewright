import { isSchoolDay, ROLES, STUDENT_RULES, type Role } from '@storewright/sim-engine';
import { useApp } from '../state/store';
import { ROLE_LABEL } from '../scene/palette';
import { clockText } from './format';
import { t } from '../i18n';

/**
 * 学生兼职工（决策记录 0020）：启用、名单人数、可以做的岗位；列出当天来上班的人和班次。
 * 上学日放学后才能来、每天最多 4 小时，周末和暑假每天最多 6 小时，每周不超过 20 小时。
 */
export function StudentCrew() {
  const students = useApp((s) => s.students);
  const count = useApp((s) => s.studentCount());
  const weekday = useApp((s) => s.weekday);
  const season = useApp((s) => s.site.season ?? 'autumn');
  const shifts = useApp((s) => s.timeline?.students ?? []);
  const app = useApp.getState;
  const school = isSchoolDay(weekday, season);
  const rule = school ? STUDENT_RULES.schoolDay : STUDENT_RULES.freeDay;
  const toggleRole = (r: Role) => {
    const has = students.roles.includes(r);
    const roles = has ? students.roles.filter((x) => x !== r) : ROLES.filter((x) => x === r || students.roles.includes(x));
    if (roles.length) app().setStudents({ roles });
  };
  return (
    <>
      <div className="chips gap-top" role="group" aria-label={t('学生兼职工')}>
        <button className={students.enabled ? 'chip active' : 'chip'} onClick={() => app().setStudents({ enabled: !students.enabled })}>
          {students.enabled ? t('学生兼职 开') : t('学生兼职 关')}
        </button>
        {students.enabled && (
          <span className="staff-adjust">
            <button aria-label={t('减少学生人数')} onClick={() => app().setStudents({ count: Math.max(1, count - 1) })}>
              −
            </button>
            <span className="mono">{count}</span>
            <button aria-label={t('增加学生人数')} onClick={() => app().setStudents({ count: Math.min(40, count + 1) })}>
              ＋
            </button>
            <span className="muted"> {t('人（名单）')}</span>
          </span>
        )}
      </div>
      {students.enabled && (
        <>
          <div className="chips gap-top" role="group" aria-label={t('学生可以做的岗位')}>
            <span className="chips-label">{t('岗位')}</span>
            {ROLES.map((r) => (
              <button key={r} className={students.roles.includes(r) ? 'chip active' : 'chip'} aria-pressed={students.roles.includes(r)} onClick={() => toggleRole(r)}>
                {ROLE_LABEL[r]}
              </button>
            ))}
          </div>
          <p className="hint">
            {shifts.length
              ? t('今天来 {0} 人：{1}', shifts.length, shifts.map((s) => `${s.id} ${ROLE_LABEL[s.role]} ${clockText(s.start)}–${clockText(s.end)}`).join('、'))
              : t('今天没有学生能来（营业时间里排不出至少 1 小时的班）。')}
          </p>
        </>
      )}
      <p className="hint">
        {t(school ? '今天是上学日：学生放学后才能来，{0}:00–{1}:00 之间每人最多 {2} 小时。' : '今天不上学（周末或暑假）：{0}:00–{1}:00 之间每人最多 {2} 小时。', rule.from, rule.to, rule.maxHours)}{' '}
        {t('每人每周不超过 {0} 小时，所以不是每天都来（学期里每周 4 天，暑假每周 3 天）；不排夜班。学生在全职排班之外加人，工时按学生时薪计入经营账。', STUDENT_RULES.weeklyMaxHours)}
      </p>
    </>
  );
}
