import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { CameraScanner } from './CameraScanner';

/**
 * 扫码框：硬件扫码枪（模拟键盘输入 + 回车）、摄像头、手动输入三种方式。
 * 默认不弹出软键盘（扫码枪照样能输入），点键盘按钮再手动输入。
 */
export function ScanBox({ onScan, label, hint }: { onScan: (code: string) => void; label: string; hint?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [keyboard, setKeyboard] = useState(false);
  const [camera, setCamera] = useState(false);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [keyboard]);
  const submit = (raw: string) => {
    const code = raw.trim();
    if (!code) return;
    setValue('');
    onScan(code);
    window.setTimeout(() => ref.current?.focus({ preventScroll: true }), 0);
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
          onCode={(c) => {
            setCamera(false);
            submit(c);
          }}
        />
      )}
    </div>
  );
}
