import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';

interface Detector {
  detect(src: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

/**
 * 摄像头扫码：浏览器支持 BarcodeDetector 时用它（二维码和商品条码），否则用 jsQR 解二维码。
 * 摄像头需要 HTTPS 或 localhost。
 */
export function CameraScanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  // 父组件每次渲染都会传新的回调；用 ref 保存，避免反复重开摄像头
  const cb = useRef(onCode);
  cb.current = onCode;
  useEffect(() => {
    let stream: MediaStream | undefined;
    let raf = 0;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d', { willReadFrequently: true });
    const Ctor = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    const detector = Ctor ? new Ctor({ formats: ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] }) : undefined;
    // 不支持 BarcodeDetector 时才下载 jsQR
    let jsQR: typeof import('jsqr').default | undefined;
    if (!detector) void import('jsqr').then((m) => (jsQR = m.default));
    const loop = async () => {
      if (stopped) return;
      const v = video.current;
      if (v && v.readyState >= 2) {
        try {
          if (detector) {
            const hits = await detector.detect(v);
            if (hits[0]?.rawValue) return cb.current(hits[0].rawValue);
          } else if (g && jsQR) {
            const w = (canvas.width = Math.min(640, v.videoWidth));
            const h = (canvas.height = Math.round((v.videoHeight / v.videoWidth) * w));
            g.drawImage(v, 0, 0, w, h);
            const hit = jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
            if (hit?.data) return cb.current(hit.data);
          }
        } catch {
          // 单帧失败继续
        }
      }
      raf = requestAnimationFrame(() => void loop());
    };
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError(t('摄像头需要 HTTPS 或 localhost，请用扫码枪或手动输入'));
    } else {
      navigator.mediaDevices
        .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
        .then((s) => {
          stream = s;
          if (video.current) {
            video.current.srcObject = s;
            void video.current.play();
          }
          void loop();
        })
        .catch(() => setError(t('无法打开摄像头')));
    }
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      for (const tr of stream?.getTracks() ?? []) tr.stop();
    };
  }, []);
  return (
    <div className="camera" role="dialog" aria-label={t('摄像头扫码')}>
      {error ? <p className="camera-error">{error}</p> : <video ref={video} playsInline muted />}
      <div className="camera-frame" aria-hidden />
      <button className="camera-close" onClick={onClose}>
        {t('关闭')}
      </button>
    </div>
  );
}
