import type { DisruptionKey, Gen, LoadLevel } from '../sim/config';
import type { Facilities } from '../facility/config';

/**
 * 场景文件（JSON）：一份可以分享、复现的「孪生里的一个时刻」——哪个区域、哪种方案、第几组仿真、什么负荷和演练、
 * 设施怎么改过、从几点开始看、镜头在哪、跟随哪辆车，以及要不要放演示导览、打开哪道练习。
 * 网页的分享链接（src/scenario/url.ts）、场景库（web/public/scenarios/*.json）、教学沙盘的练习（src/teach）和命令行都用这一个格式；
 * 所有字段都可以不写（不写就用网页的默认值）。格式说明见 docs/07-scenarios.md，JSON Schema 见 docs/scenario.schema.json。
 *
 * Scenario file (JSON): a shareable, reproducible moment in the twin. Every field is optional; missing fields
 * fall back to the app defaults. Used by share links, the scenario library, the teaching exercises and the CLI.
 */
export const SCENARIO_FORMAT = 'storex-chain/scenario';
export const SCENARIO_VERSION = 1;

export type ScenarioDrill = DisruptionKey | 'none';
export type ScenarioWeather = 'auto' | 'clear' | 'cloudy' | 'rain' | 'fog' | 'storm';
export type ScenarioPreset = 'overview' | 'port' | 'airport' | 'dc' | 'flagship';
export type ScenarioTab = 'twin' | 'report' | 'network' | 'about';
export type ScenarioTour = 'container';

/** 嵌套的部分字段：数组整个给出（检修设备整个替换）；对象数组的元素也可以只写一部分（岗位表按 key 合并，见 mergeFacilities） */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly (infer U)[] ? (U extends object ? DeepPartial<U>[] : T[K]) : T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface ScenarioCamera {
  /** 镜头预设（全景、港口、机场、物流园、综合店） */
  preset?: ScenarioPreset;
  /** 自定义镜头：位置和看向的点（区域坐标，米）；给了就不用 preset */
  position?: [number, number, number];
  target?: [number, number, number];
}

export interface Scenario {
  /** 固定写 'storex-chain/scenario'（读的时候可以不写） */
  format?: typeof SCENARIO_FORMAT;
  /** 格式版本：1 */
  version?: typeof SCENARIO_VERSION;
  /** 场景库里的编号（文件名不带 .json） */
  id?: string;
  /** 标题和说明（中文 / 英文） */
  title?: string;
  titleEn?: string;
  description?: string;
  descriptionEn?: string;
  /** 区域：和网址里的 ?region= 一样（default、random-编号、自定义写法） */
  region?: string;
  /** 方案：g1 上一代、g2 StoreX、g3 StoreX 全链路 */
  gen?: Gen;
  /** 仿真的第几组（1–9999） */
  seed?: number;
  /** 负荷档位 */
  load?: LoadLevel;
  /** 演练（扰动）：none 是正常的一天 */
  drill?: ScenarioDrill;
  /** 设施改动（相对默认配置）：只写改了的字段；数组整个替换 */
  facilities?: DeepPartial<Facilities>;
  /** 从当天几点开始看：秒（0–86340）；文件里也可以写 "08:30" */
  time?: number;
  /** 播放速度：仿真每秒走几秒（10、60、120、300、600、1800） */
  speed?: number;
  /** 打开就播放（不写 = 网页默认） */
  play?: boolean;
  camera?: ScenarioCamera;
  /** 跟随一辆车：车牌 / 编号（如 DR-02、M03）或调度台的作业编号 */
  follow?: string;
  weather?: ScenarioWeather;
  /** 打开哪个页签 */
  tab?: ScenarioTab;
  /** 打开就放演示导览（container：一个集装箱从船到货架） */
  tour?: ScenarioTour;
  /** 打开教学沙盘的哪道练习（如 ex01） */
  exercise?: string;
}

export const GENS: readonly Gen[] = ['g1', 'g2', 'g3'];
export const LOAD_LEVELS: readonly LoadLevel[] = ['normal', 'peak', 'high', 'extreme'];
export const DRILL_KEYS: readonly ScenarioDrill[] = ['none', 'portCongestion', 'airportClosed', 'highwayClosed', 'supplierOutage', 'demandSurge'];
export const WEATHERS: readonly ScenarioWeather[] = ['auto', 'clear', 'cloudy', 'rain', 'fog', 'storm'];
export const PRESETS: readonly ScenarioPreset[] = ['overview', 'port', 'airport', 'dc', 'flagship'];
export const TABS: readonly ScenarioTab[] = ['twin', 'report', 'network', 'about'];
export const TOURS: readonly ScenarioTour[] = ['container'];
export const SPEEDS: readonly number[] = [10, 60, 120, 300, 600, 1800];
