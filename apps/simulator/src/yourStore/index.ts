import './yourStore.css';

/**
 * 「你的商店」（决策记录 0013、0027）：项目页、项目栏和门店项目。模拟器按需加载这个模块（App.tsx、main.tsx）；
 * 门店编辑器（区域、卸货门、取货车位……）和开业检查的规则在编辑器与 store-config 里，这里只有搭建流程和门店项目的保存。
 */
export { loadProjectFromUrl, YourStorePage } from './YourStore';
export { ProjectBar } from './ProjectBar';
