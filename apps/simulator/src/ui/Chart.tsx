import { useEffect, useMemo, useRef, useState } from 'react';
import { clockText } from './format';
import { translate } from '../i18n';

export interface ChartSeries {
  label: string;
  values: readonly number[];
  color: string;
  dashed?: boolean;
}

interface Props {
  title: string;
  series: ChartSeries[];
  t0: number;
  step: number;
  now: number;
  yMax?: number;
  format?: (v: number) => string;
  height?: number;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setW(Math.max(160, entries[0]?.contentRect.width ?? 320)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/**
 * 实时折线图：全天曲线淡色显示，当前时刻之前的部分实线显示，竖线标出当前时刻。
 * 虚线系列用于叠加其他策略作对比。
 */
export function LineChart({ title, series, t0, step, now, yMax, format = (v) => v.toFixed(0), height = 116 }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const padL = 34;
  const padR = 8;
  const padT = 8;
  const padB = 18;
  const w = width - padL - padR;
  const h = height - padT - padB;
  const n = Math.max(...series.map((s) => s.values.length), 2);
  const max = useMemo(() => {
    if (yMax !== undefined) return yMax;
    let m = 0;
    for (const s of series) for (const v of s.values) m = Math.max(m, v);
    return m > 0 ? m * 1.1 : 1;
  }, [series, yMax]);
  const x = (i: number) => padL + (i / (n - 1)) * w;
  const y = (v: number) => padT + h - (Math.min(v, max) / max) * h;
  const nowIdx = Math.min(n - 1, Math.max(0, (now - t0) / step));
  const paths = useMemo(
    () =>
      series.map((s) => {
        let d = '';
        const stride = Math.max(1, Math.floor(s.values.length / Math.max(60, w / 2)));
        for (let i = 0; i < s.values.length; i += stride) d += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(s.values[i] ?? 0).toFixed(1)}`;
        return d;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, width, max],
  );
  const clipId = useMemo(() => `clip-${Math.random().toString(36).slice(2)}`, []);
  const hours: number[] = [];
  for (let hh = Math.ceil(t0 / 3600 / 3) * 3; hh * 3600 <= t0 + (n - 1) * step; hh += 3) hours.push(hh);
  const current = series.map((s) => s.values[Math.floor(nowIdx)] ?? 0);

  return (
    <figure className="chart" ref={ref}>
      <figcaption>
        <span>{title}</span>
        <span className="chart-values">
          {series.map((s, i) => (
            <span key={s.label} className="chart-value" style={{ color: s.color }}>
              <i style={{ background: s.color, opacity: s.dashed ? 0.5 : 1 }} />
              {translate(s.label)} <b className="mono">{format(current[i] ?? 0)}</b>
            </span>
          ))}
        </span>
      </figcaption>
      <svg width={width} height={height} role="img" aria-label={title}>
        <defs>
          <clipPath id={clipId}>
            <rect x={0} y={0} width={x(nowIdx)} height={height} />
          </clipPath>
        </defs>
        {[0, 0.5, 1].map((k) => (
          <g key={k}>
            <line x1={padL} x2={width - padR} y1={padT + h * (1 - k)} y2={padT + h * (1 - k)} className="grid" />
            <text x={padL - 4} y={padT + h * (1 - k) + 3} className="axis" textAnchor="end">
              {format(max * k)}
            </text>
          </g>
        ))}
        {hours.map((hh) => {
          const i = (hh * 3600 - t0) / step;
          return (
            <text key={hh} x={x(i)} y={height - 4} className="axis" textAnchor="middle">
              {String(hh % 24).padStart(2, '0')}
            </text>
          );
        })}
        {paths.map((d, i) => {
          const s = series[i] as ChartSeries;
          return <path key={`f${i}`} d={d} fill="none" stroke={s.color} strokeWidth={1.2} opacity={0.22} strokeDasharray={s.dashed ? '4 3' : undefined} />;
        })}
        <g clipPath={`url(#${clipId})`}>
          {paths.map((d, i) => {
            const s = series[i] as ChartSeries;
            return <path key={`s${i}`} d={d} fill="none" stroke={s.color} strokeWidth={s.dashed ? 1.4 : 2} strokeDasharray={s.dashed ? '4 3' : undefined} />;
          })}
        </g>
        <line x1={x(nowIdx)} x2={x(nowIdx)} y1={padT} y2={padT + h} className="cursor" />
        <text x={Math.min(width - padR - 20, x(nowIdx) + 3)} y={padT + 9} className="axis now">
          {clockText(now)}
        </text>
      </svg>
    </figure>
  );
}
