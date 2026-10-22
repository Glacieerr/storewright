import { useMemo } from 'react';
import { useApp } from '../state/store';
import { clock, setPlaying, setSpeed, setTime, useClock, useClockState } from '../state/clock';
import { clockText } from './format';
import { t } from '../i18n';

const SPEEDS = [1, 10, 60, 300, 900];

/** 底部时间轴：播放控制、倍速、拖动定位，背景是全天等待车辆数曲线 */
export function TimelineBar() {
  const tm = useClock(10);
  const { playing, speed } = useClockState();
  const timeline = useApp((s) => s.timeline);

  const spark = useMemo(() => {
    if (!timeline) return '';
    const w = timeline.series.waiting;
    const max = Math.max(1, ...w);
    return w.map((v, i) => `${((i / (w.length - 1)) * 100).toFixed(2)},${(100 - (v / max) * 100).toFixed(1)}`).join(' ');
  }, [timeline]);

  if (!timeline) return <footer className="timeline" />;
  const toggle = () => {
    if (!playing && clock.time >= clock.end) setTime(clock.start);
    setPlaying(!playing);
  };

  return (
    <footer className="timeline">
      <button className="play" onClick={toggle} aria-label={playing ? t('暂停') : t('播放')}>
        {playing ? '❚❚' : '▶'}
      </button>
      <div className="speeds" role="group" aria-label={t('倍速')}>
        {SPEEDS.map((s) => (
          <button key={s} className={speed === s ? 'active' : ''} onClick={() => setSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>
      <span className="mono now">{clockText(tm)}</span>
      <div className="track">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          <polyline points={spark} fill="none" vectorEffect="non-scaling-stroke" />
        </svg>
        <input
          type="range"
          min={timeline.start}
          max={timeline.end}
          step={30}
          value={tm}
          aria-label={t('时间轴')}
          onChange={(e) => setTime(Number(e.target.value))}
        />
      </div>
      <span className="mono muted">{clockText(timeline.end)}</span>
    </footer>
  );
}
