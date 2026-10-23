import type { YourStoreExtension } from './extensions';

/** 公开仓库里没有「你的商店」的私有模块时用这个空实现 */
export const yourStore: YourStoreExtension | undefined = undefined;
