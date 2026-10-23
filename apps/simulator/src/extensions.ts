import { useEffect, useState, type ComponentType } from 'react';
import type { StoreConfig } from '@storewright/store-config';

/**
 * 「你的商店」扩展点（决策记录 0013）：项目页、项目栏、门店项目的保存和授权是在线版的付费部分，代码在私有仓库里。
 * 构建时有私有模块就打包进来（`virtual:your-store`，见 vite.config.ts），公开仓库里没有时这里是 undefined，
 * 模拟器照常运行，只是不显示「你的商店」。门店编辑器（区域、卸货门、取货车位……）和开业检查都在公开的核心里。
 */

export type YourStoreFeature = 'multiProject' | 'export' | 'liveSandbox' | 'fullReport';

export interface ProjectRecord {
  id: string;
  name: string;
  config: StoreConfig;
  sizing?: { ordersPerDay: number; staffScale: number };
}

export interface YourStoreExtension {
  /** 项目页：门店列表、新建门店、授权与购买 */
  Page: ComponentType;
  /** 打开门店项目时顶栏下方的项目栏 */
  ProjectBar: ComponentType;
  /** 启动时按地址参数打开项目页（?yours）或项目（?project=） */
  loadFromUrl(): Promise<void>;
  /** 读出门店项目（门店实况的实时沙盒要先载入它） */
  getProject(id: string): Promise<ProjectRecord | undefined>;
  canUse(feature: YourStoreFeature): boolean;
  /** 用到付费功能时调用：可用时返回 true，否则打开购买 / 授权提示 */
  request(feature: YourStoreFeature): boolean;
}

let loaded: YourStoreExtension | undefined;
let loading: Promise<YourStoreExtension | undefined> | undefined;

export function loadYourStore(): Promise<YourStoreExtension | undefined> {
  loading ??= import('virtual:your-store').then((m) => (loaded = m.yourStore));
  return loading;
}

/** 已经载入时直接返回（同步）；还没载入或没有私有模块时为 undefined */
export function yourStoreNow(): YourStoreExtension | undefined {
  return loaded;
}

export function useYourStore(): YourStoreExtension | undefined {
  const [ext, setExt] = useState(loaded);
  useEffect(() => {
    if (!ext) void loadYourStore().then(setExt);
  }, [ext]);
  return ext;
}
