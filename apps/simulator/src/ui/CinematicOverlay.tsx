import { useApp } from '../state/store';
import { t } from '../i18n';

/** 自动巡游时的画面：上下黑边、字幕、镜头进度和退出提示；点击任意处退出 */
export function CinematicOverlay() {
  const on = useApp((s) => s.cinematic);
  const cap = useApp((s) => s.cinematicCaption);
  if (!on) return null;
  return (
    <div className="cinematic-overlay" onClick={() => useApp.getState().setCinematic(false)} role="dialog" aria-label={t('自动巡游')}>
      <div className="letterbox top" />
      <div className="letterbox bottom">
        {cap && (
          <p key={cap.i} className="cine-caption">
            {cap.text}
          </p>
        )}
        {cap && (
          <div className="cine-dots" aria-hidden>
            {Array.from({ length: cap.n }, (_, i) => (
              <span key={i} className={i === cap.i ? 'on' : ''} />
            ))}
          </div>
        )}
      </div>
      <div className="cine-brand">Storewright</div>
      <div className="cine-hint">{t('Esc 或点击画面退出巡游')}</div>
    </div>
  );
}
