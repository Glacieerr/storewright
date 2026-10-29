import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { CameraScanner } from './CameraScanner';

/**
 * 扫码框：硬件扫码枪（模拟键盘输入 + 回车）、摄像头、手动输入三种方式。
 * 默认不弹出软键盘（扫码枪照样能输入），点键盘按钮再手动输入。
 * 摄像头连续扫（决策记录 0026）：onScan 返回 false 时关掉摄像头（例如扫完要在弹出的面板里填数量）。
 */
export function ScanBox({ onScan, label, hint }: { onScan: (code: string) => void | boolean | Promise<unknown>; label: string; hint?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [keyboard, setKeyboard] = useState(false);
  const [camera, setCamera] = useState(false);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [keyboard]);
  const submit = (raw: string): boolean => {
    const code = raw.trim();
    if (!code) return true;
    setValue('');
    const r = onScan(code);
    window.setTimeout(() => ref.current?.focus({ preventScroll: true }), 0);
    return r !== false;
  };
  return (
    <div className="scanbox">
      <label className="scan-label">{label}</label>
      <div className="scan-row">
        <input
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit(value);
          }}
          inputMode={keyboard ? 'text' : 'none'}
          enterKeyHint="go"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder={hint ?? t('扫码或输入')}
          aria-label={label}
        />
        <button type="button" className="icon-btn" onClick={() => setKeyboard((k) => !k)} aria-pressed={keyboard} title={t('手动输入')}>
          ⌨
        </button>
        <button type="button" className="icon-btn primary" onClick={() => setCamera(true)} title={t('摄像头扫码')}>
          ◎
        </button>
      </div>
      {camera && (
        <CameraScanner
          onClose={() => setCamera(false)}
          onManual={() => {
            setCamera(false);
            setKeyboard(true);
          }}
          onCode={(c) => {
            if (!submit(c)) setCamera(false);
          }}
        />
      )}
    </div>
  );
}
