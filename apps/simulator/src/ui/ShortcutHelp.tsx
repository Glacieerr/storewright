import { useApp } from '../state/store';
import { t } from '../i18n';

const ROWS: Array<[string, string]> = [
  ['拖动左键', '2.5D / 俯视：平移；3D：旋转'],
  ['拖动右键', '2.5D：旋转；3D：平移'],
  ['滚轮', '朝光标位置缩放'],
  ['W A S D / 方向键', '平移镜头'],
  ['Q / E', '左右旋转'],
  ['R / F', '抬高 / 压低视角（3D）'],
  ['+ / −', '缩放'],
  ['H', '复位镜头'],
  ['1 / 2 / 3', '2.5D / 3D / 俯视'],
  ['B', '切换建筑：内部 → 半剖 → 外观'],
  ['G', '跟随选中的员工或车辆'],
  ['M', '小地图'],
  ['空格', '播放 / 暂停'],
  ['[ / ]', '降低 / 提高倍速'],
  ['右键单击', '对象菜单（改派、跟随、编辑通道……）'],
  ['Esc', '取消选中 / 关闭'],
  ['编辑：Shift / ⌘ 点选', '多选通道（按住选中的通道拖动一起移动）'],
  ['编辑：N', '画通道（拖出一条，两端吸附到走廊）'],
  ['编辑：方向键', '微调选中通道 0.1 米（Shift 1 米）'],
  ['编辑：T / Delete', '旋转 90° / 删除'],
  ['编辑：⌘C ⌘V ⌘D ⌘A', '复制 / 粘贴到指针处 / 复制到旁边 / 全选本层'],
  ['编辑：⌘Z / ⇧⌘Z', '撤销 / 重做'],
];

/** 快捷键说明（? 键或镜头工具栏的 ⌨ 按钮） */
export function ShortcutHelp() {
  const open = useApp((s) => s.help);
  if (!open) return null;
  return (
    <div className="shortcut-help" role="dialog" aria-label={t('快捷键')}>
      <div className="shortcut-head">
        <strong>{t('镜头与快捷键')}</strong>
        <button aria-label={t('关闭')} onClick={() => useApp.getState().toggle('help')}>
          ×
        </button>
      </div>
      <dl>
        {ROWS.map(([k, v]) => (
          <div key={k}>
            <dt>
              <kbd>{t(k)}</kbd>
            </dt>
            <dd>{t(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
