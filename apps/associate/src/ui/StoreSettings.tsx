import { useLive } from '../live';
import { t } from '../i18n';

/**
 * 门店设置（决策记录 0026）：要不要求扫码、交付准备什么时候能开始。控制台和带班负责人可以改，所有设备马上生效。
 */
export function StoreSettingsCard() {
  const { client, run } = useLive();
  const st = client.state.settings ?? {};
  const gate = st.prepGate ?? 'ANY';
  return (
    <section className="card store-settings">
      <h2 className="section-title">{t('门店设置')}</h2>
      <label className="toggle">
        <input id="set-require-scan" type="checkbox" checked={!!st.requireScan} onChange={(e) => void run({ type: 'SetStoreSettings', requireScan: e.target.checked })} />
        <span>{t('要求扫码：拣货必须扫到商品条码，框、格位、货位都要扫，不能点选代替（演示和培训时关掉）')}</span>
      </label>
      <fieldset className="radio-set">
        <legend>{t('交付准备什么时候能开始')}</legend>
        <label className="toggle">
          <input id="set-prep-any" type="radio" name="prep-gate" checked={gate === 'ANY'} onChange={() => void run({ type: 'SetStoreSettings', prepGate: 'ANY' })} />
          <span>{t('顾客到店前也可以开始（常温先取，冷藏冷冻最后取）；顾客到了可以先核验取货码')}</span>
        </label>
        <label className="toggle">
          <input id="set-prep-arrived" type="radio" name="prep-gate" checked={gate === 'ARRIVED'} onChange={() => void run({ type: 'SetStoreSettings', prepGate: 'ARRIVED' })} />
          <span>{t('顾客到了才能开始（冷链框不提前离开暂存区）')}</span>
        </label>
      </fieldset>
    </section>
  );
}
