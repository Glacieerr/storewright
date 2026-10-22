import { useSyncExternalStore } from 'react';

/** 屏幕底部的提示条 */
interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'ok';
}

let list: Toast[] = [];
let seq = 0;
const subs = new Set<() => void>();
const emit = () => {
  for (const f of subs) f();
};

/** 成功提示短一些，错误提示留久一些；最多同时显示两条，避免挡住内容（全流程走查发现连续收货时提示叠住了收货差异） */
const DEFAULT_MS: Record<Toast['kind'], number> = { ok: 2200, info: 3000, error: 4500 };

function dismiss(id: number): void {
  list = list.filter((x) => x.id !== id);
  emit();
}

export function toast(text: string, kind: Toast['kind'] = 'info', ms = DEFAULT_MS[kind]): void {
  const id = ++seq;
  list = [...list.slice(-1), { id, text, kind }];
  emit();
  window.setTimeout(() => dismiss(id), ms);
}

export function Toasts() {
  const items = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => list,
  );
  return (
    <div className="toasts" role="status" aria-live="assertive">
      {items.map((x) => (
        <div key={x.id} className={`toast ${x.kind}`} onClick={() => dismiss(x.id)}>
          {x.text}
        </div>
      ))}
    </div>
  );
}
