/** 区域类型的名称（决策记录 0013）；界面里用 t() 翻译 */
export const AREA_NAME: Record<string, string> = {
  UNLOAD: '卸货区',
  RECEIVING_HOLD: '收货暂放区',
  QA: '待检区',
  RTV: '退供应商区',
  RETURNS: '顾客退货处理区',
  PALLETS: '空托盘区',
  BALER: '纸箱回收与报废区',
  RACKS: '托盘货架区',
  COOLER: '冷藏库',
  FREEZER: '冷冻库',
  OVERSTOCK: '高位库存区',
  BULK: '大件区',
  CAGE: '贵重商品笼',
  CHEM: '化学品隔离区',
  CHARGING: '叉车充电区',
  STAGING: '暂存区',
  STAGING_DELIVERY: '配送暂存道',
  STAGING_OVERSIZED: '大件暂存区',
  HOT_HOLD: '熟食保温区',
  PARCEL: '包裹区',
  RECOVERY: '回收专区',
  STAGING_COOLER: '线上订单冷藏库',
  STAGING_FREEZER: '线上订单冷冻库',
  PASSAGE: '连通通道',
  OVERFLOW: '溢流位',
};

/** 二楼的高位库存区叫补货区（货梯送上来的托盘放在这里，决策记录 0019） */
export const UPPER_STOCK_NAME = '补货区';
