import { useEffect, useState } from 'react';
import { recentNotes } from '@storewright/ops';
import { assistant, type AskResponse } from '../api';
import { clock, getLang, t } from '../i18n';
import { useLive } from '../live';
import { toast } from '../ui/Toasts';

/**
 * 本地助手（Phase 5d）：用一句话提问，助手调用查询工具回答，并给出数据出处。
 * 没有配置本地语言模型时用模板模式（关键词规则 + 本地意图分类器）；两种模式都只用门店数据回答。
 */

const SUGGESTIONS = ['现在有几位顾客在等？', '接下来几个小时预计多少单？', '为什么顾客等这么久？', '如果 16 到 19 点多一个交付员会怎样？', '冷冻暂存格位满了怎么办？', '帮我做一个交接班摘要', '今天要注意什么？', '今天每小时的单量和迟到', '做一下打烊复盘', '给我这周的周报'];

interface Turn {
  q: string;
  at: number;
  r?: AskResponse;
  error?: string;
}

export function AskPanel() {
  const { auth, client, run } = useLive();
  const [status, setStatus] = useState<{ llm: boolean; model?: string } | undefined>();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  useEffect(() => {
    void assistant
      .status(auth)
      .then(setStatus)
      .catch(() => undefined);
  }, [auth]);
  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setQ('');
    const turn: Turn = { q: text, at: Date.now() };
    setTurns((xs) => [turn, ...xs].slice(0, 20));
    try {
      const r = await assistant.ask(auth, text, getLang());
      setTurns((xs) => xs.map((x) => (x === turn ? { ...x, r } : x)));
    } catch (e) {
      setTurns((xs) => xs.map((x) => (x === turn ? { ...x, error: String(e) } : x)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="list ask">
      <p className="note">
        {status?.llm ? t('本地语言模型：{0}（数据不出店）', status.model ?? '') : t('模板模式：关键词规则 + 本地意图分类器（未连接本地语言模型）')}
      </p>
      <div className="chips ask-suggest">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="chip" disabled={busy} onClick={() => void ask(t(s))}>
            {t(s)}
          </button>
        ))}
      </div>
      <form
        className="ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(q);
        }}
      >
        <input className="ai-note" value={q} maxLength={300} placeholder={t('问门店的情况、商品、人员、操作规范，或「如果……会怎样」')} onChange={(e) => setQ(e.target.value)} />
        <button className="primary" disabled={busy || !q.trim()}>
          {busy ? t('思考中…') : t('提问')}
        </button>
      </form>
      {turns.map((x, i) => (
        <article key={`${x.at}-${i}`} className="card ask-turn">
          <p className="ask-q">
            <span className="mono">{clock(x.at)}</span> {x.q}
          </p>
          {x.r ? (
            <>
              <p className="ask-a">{x.r.answer}</p>
              <p className="note">
                {t('数据来自：{0}', x.r.citations.join(' · ') || '—')} · {x.r.source === 'LLM' ? t('本地语言模型') : t('模板')} · {x.r.ms} ms
                {x.r.fallback ? ` · ${t('本地模型不可用，已改用模板')}` : ''}
              </p>
              {x.r.answerId && (
                <div className="chips" role="group" aria-label={t('这个回答有用吗')}>
                  {[true, false].map((h) => (
                    <button key={String(h)} className={`chip${client.state.answers?.[x.r?.answerId ?? '']?.helpful === h ? ' on' : ''}`} onClick={() => void run({ type: 'RateAnswer', answerId: x.r?.answerId ?? '', helpful: h }, { quiet: true })}>
                      {h ? t('有用') : t('没用')}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : x.error ? (
            <p className="banner error">{x.error}</p>
          ) : (
            <p className="muted">{t('思考中…')}</p>
          )}
        </article>
      ))}
      {client.state.answerStats && client.state.answerStats.answered > 0 && (
        <p className="note">{t('问答 {0} 次，标了有用 {1} 次、没用 {2} 次（用来改进回答和评测集）', client.state.answerStats.answered, client.state.answerStats.helpful, client.state.answerStats.unhelpful)}</p>
      )}
      <NotesPanel />
    </div>
  );
}

/** 门店经验库：记下现场经验，助手回答问题时会检索 */
function NotesPanel() {
  const { client, auth, run, nameOf } = useLive();
  const [text, setText] = useState('');
  const [tags, setTags] = useState('');
  const notes = recentNotes(client.state, 20);
  const canRemove = (author: string) => author === auth.actor || auth.role === 'console' || client.statics?.roster.find((a) => a.id === auth.actor)?.role === 'LEAD';
  return (
    <>
      <h2 className="section-title">{t('门店经验')}</h2>
      <p className="note">{t('人会走，经验留在系统里：记下「这个商品其实在端架」「冷冻满了先放哪」之类的做法，助手回答问题时会用到。')}</p>
      <section className="card">
        <textarea className="ai-note note-text" value={text} maxLength={300} rows={2} placeholder={t('例如：周末烤鸡放在熟食柜旁边的冷柜，不在原货位')} onChange={(e) => setText(e.target.value)} />
        <input className="ai-note" value={tags} maxLength={60} placeholder={t('标签（可选，用逗号分隔）')} onChange={(e) => setTags(e.target.value)} />
        <button
          className="primary block"
          disabled={text.trim().length < 2}
          onClick={async () => {
            const list = tags
              .split(/[,，、]/)
              .map((x) => x.trim())
              .filter(Boolean);
            if (await run({ type: 'AddNote', text: text.trim(), ...(list.length ? { tags: list } : {}) })) {
              setText('');
              setTags('');
              toast(t('已记下'), 'ok');
            }
          }}
        >
          {t('记下这条经验')}
        </button>
      </section>
      {notes.length > 0 && (
        <section className="card">
          <ul className="plain ai-history">
            {notes.map((n) => (
              <li key={n.id}>
                <span>{n.text}</span>
                {n.tags.map((g) => (
                  <span key={g} className="tag">
                    {g}
                  </span>
                ))}
                <span className="muted">
                  {nameOf(n.author)} · {clock(n.at)}
                </span>
                {canRemove(n.author) && (
                  <button className="link danger" onClick={() => void run({ type: 'RemoveNote', noteId: n.id }, { quiet: true })}>
                    {t('删除')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
