import { useEffect, useState } from 'react';
import { getLang, t } from '../i18n';
import { useLive } from '../live';

/**
 * 现场操作提示（决策记录 0024 · D4）：第一次遇到某种情况时，弹出对应操作规范的要点（和门店助手用的是同一份），
 * 有的附两三道小测验；看过（或答完）就不再弹。入职两周内的新员工默认打开，其他人可以在「更多」里打开。
 */

const PREF = 'storewright.sopTips';

export function sopTipsPref(): 'on' | 'off' | undefined {
  try {
    const v = localStorage.getItem(PREF);
    return v === 'on' || v === 'off' ? v : undefined;
  } catch {
    return undefined;
  }
}

export function setSopTipsPref(v: 'on' | 'off'): void {
  try {
    localStorage.setItem(PREF, v);
  } catch {
    /* 隐私模式：只在这一次有效 */
  }
}

/** 这个人要不要看提示：自己设过的按设置；没设过时入职两周内的新员工打开 */
export function sopTipsOn(hiredAt: string | undefined, now = Date.now()): boolean {
  const pref = sopTipsPref();
  if (pref) return pref === 'on';
  return !!hiredAt && now - Date.parse(hiredAt) <= 14 * 86_400_000;
}

interface Sop {
  id: string;
  title: string;
  text: string;
  quiz: Array<{ q: string; options: string[]; answer: number }>;
}

/** 这次打开里点了「稍后再看」的提示（不记进事件流，下次登录还会出现） */
const later = new Set<string>();

export function SopTip({ sopId, when = true }: { sopId: string; when?: boolean }) {
  const { client, auth, run } = useLive();
  const [, setLater] = useState(0);
  const me = client.statics?.roster.find((a) => a.id === auth.actor);
  const seen = !!client.state.sopAcks?.[auth.actor]?.[sopId];
  const show = when && auth.role !== 'console' && !seen && sopTipsOn(me?.hiredAt);
  const [sop, setSop] = useState<Sop | undefined>();
  const [picked, setPicked] = useState<Record<number, number>>({});
  useEffect(() => {
    if (!show || sop) return;
    void fetch(`/api/stores/${auth.storeId}/sop/${sopId}?lang=${getLang()}`, { headers: { authorization: `Bearer ${auth.token}` } })
      .then((r) => (r.ok ? (r.json() as Promise<Sop>) : undefined))
      .then((x) => x && setSop(x))
      .catch(() => undefined);
  }, [show, sop, sopId, auth]);
  if (!show || !sop || later.has(sopId)) return null;
  const answered = Object.keys(picked).length;
  const correct = sop.quiz.filter((q, i) => picked[i] === q.answer).length;
  return (
    <aside className="card sop-tip" aria-label={t('操作提示')}>
      <div className="card-head">
        <span className="tag ok">{t('操作提示')}</span>
        <span className="strong">{sop.title}</span>
      </div>
      <p>{sop.text}</p>
      {sop.quiz.map((q, i) => (
        <div key={i} className="sop-quiz">
          <p className="strong">{q.q}</p>
          <div className="chips" role="radiogroup" aria-label={q.q}>
            {q.options.map((o, k) => (
              <button key={k} role="radio" aria-checked={picked[i] === k} className={`chip${picked[i] === k ? (k === q.answer ? ' on' : ' wrong') : ''}`} disabled={picked[i] !== undefined} onClick={() => setPicked({ ...picked, [i]: k })}>
                {o}
              </button>
            ))}
          </div>
          {picked[i] !== undefined && <p className="note">{picked[i] === q.answer ? t('对了') : t('正确答案：{0}', q.options[q.answer] ?? '')}</p>}
        </div>
      ))}
      <button className="primary block" disabled={sop.quiz.length > 0 && answered < sop.quiz.length} onClick={() => void run({ type: 'AckSop', sopId, ...(sop.quiz.length ? { correct, total: sop.quiz.length } : {}) }, { quiet: true })}>
        {sop.quiz.length ? t('知道了（答对 {0} / {1}）', correct, sop.quiz.length) : t('知道了')}
      </button>
      <button
        className="link"
        onClick={() => {
          later.add(sopId);
          setLater((n) => n + 1);
        }}
      >
        {t('稍后再看')}
      </button>
    </aside>
  );
}
