import { t } from '../i18n';

/**
 * 数量：加减按钮，也可以直接输入数字（决策记录 0026：数 24 件不用点 24 下）。
 * 点进输入框会全选，直接打数字就行。
 */
export function QtyInput({ value, onChange, min = 0, max, label, id }: { value: number; onChange: (v: number) => void; min?: number; max?: number; label?: string; id?: string }) {
  const clamp = (v: number) => Math.max(min, max !== undefined ? Math.min(max, v) : v);
  return (
    <div className="stepper qty-input">
      <button type="button" aria-label={t('减少')} onClick={() => onChange(clamp(value - 1))}>
        −
      </button>
      <input
        {...(id ? { id } : {})}
        type="number"
        inputMode="numeric"
        min={min}
        {...(max !== undefined ? { max } : {})}
        value={value}
        aria-label={label ?? t('数量')}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          const v = Number(e.currentTarget.value);
          if (Number.isFinite(v)) onChange(clamp(Math.round(v)));
        }}
      />
      <button type="button" aria-label={t('增加')} onClick={() => onChange(clamp(value + 1))}>
        +
      </button>
    </div>
  );
}
