import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';

interface Detector {
  detect(src: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

/**
 * 摄像头扫码：浏览器支持 BarcodeDetector 时用它（二维码和商品条码），否则用 jsQR 解二维码。
 * 摄像头需要 HTTPS 或 localhost；嵌在展示页里时，iframe 要允许摄像头（allow="camera"）。
 * 关掉时一定停掉摄像头：打开摄像头是异步的，用户可能在摄像头打开之前就点了「关闭」。
 * 连续扫（决策记录 0026）：读到一个码后不关，停一下接着扫下一个；同一个码 2 秒内只算一次；点「完成」再关。
 */
export function CameraScanner({ onCode, onClose, onManual }: { onCode: (code: string) => void; onClose: () => void; onManual?: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState('');
  const [last, setLast] = useState<string | undefined>();
  // 父组件每次渲染都会传新的回调；用 ref 保存，避免反复重开摄像头
  const cb = useRef(onCode);
  cb.current = onCode;
  const closeCb = useRef(onClose);
  closeCb.current = onClose;
  useEffect(() => {
    let stream: MediaStream | undefined;
    let raf = 0;
    let stopped = false;
    const stop = (s: MediaStream | undefined) => {
      for (const tr of s?.getTracks() ?? []) tr.stop();
    };
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d', { willReadFrequently: true });
    const Ctor = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    let detector: Detector | undefined;
    try {
      detector = Ctor ? new Ctor({ formats: ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] }) : undefined;
    } catch {
      // 有的浏览器有 BarcodeDetector 但不支持这些格式
      detector = undefined;
    }
    // 不支持 BarcodeDetector 时才下载 jsQR
    let jsQR: typeof import('jsqr').default | undefined;
    if (!detector) void import('jsqr').then((m) => (jsQR = m.default)).catch(() => undefined);
    let prev: { code: string; at: number } | undefined;
    let pauseUntil = 0;
    const hit = (code: string) => {
      const now = performance.now();
      if (prev && prev.code === code && now - prev.at < 2000) return;
      prev = { code, at: now };
      pauseUntil = now + 900;
      setLast(code);
      cb.current(code);
    };
    const loop = async () => {
      if (stopped) return;
      const v = video.current;
      if (v && v.readyState >= 2 && v.videoWidth > 0 && performance.now() >= pauseUntil) {
        try {
          if (detector) {
            const hits = await detector.detect(v);
            if (!stopped && hits[0]?.rawValue) hit(hits[0].rawValue);
          } else if (g && jsQR) {
            const w = (canvas.width = Math.min(640, v.videoWidth));
            const h = (canvas.height = Math.round((v.videoHeight / v.videoWidth) * w));
            g.drawImage(v, 0, 0, w, h);
            const found = jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
            if (!stopped && found?.data) hit(found.data);
          }
        } catch {
          // 单帧失败继续
        }
      }
      if (!stopped) raf = requestAnimationFrame(() => void loop());
    };
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError(t('摄像头需要 HTTPS 或 localhost，请用扫码枪或手动输入'));
    } else {
      navigator.mediaDevices
        .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
        .then((s) => {
          // 摄像头打开之前就关掉了：马上停掉，不然摄像头一直开着
          if (stopped) return stop(s);
          stream = s;
          const v = video.current;
          if (v) {
            v.srcObject = s;
            void v.play().catch(() => undefined);
          }
          void loop();
        })
        .catch((e: unknown) => {
          if (stopped) return;
          const name = (e as { name?: string } | null)?.name;
          setError(name === 'NotAllowedError' || name === 'SecurityError' ? t('没有摄像头权限：请在浏览器里允许使用摄像头，或用扫码枪、手动输入') : name === 'NotFoundError' || name === 'OverconstrainedError' ? t('没有找到摄像头，请用扫码枪或手动输入') : t('无法打开摄像头'));
        });
    }
    // Esc 关闭（键盘和扫码枪用户）
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeCb.current();
    };
    window.addEventListener('keydown', onKey);
    close.current?.focus({ preventScroll: true });
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      stop(stream);
      if (video.current) video.current.srcObject = null;
    };
  }, []);
  return (
    <div className="camera" role="dialog" aria-modal="true" aria-label={t('摄像头扫码')}>
      {error ? <p className="camera-error">{error}</p> : <video ref={video} playsInline muted />}
      {!error && <div className="camera-frame" aria-hidden />}
      {last && <p className="camera-last" role="status">{t('已读到 {0}，接着扫下一个', last)}</p>}
      <div className="camera-actions">
        {error && onManual && <button onClick={onManual}>{t('手动输入')}</button>}
        <button ref={close} className="camera-close" onClick={onClose}>
          {last ? t('完成') : t('关闭')}
        </button>
      </div>
    </div>
  );
}
