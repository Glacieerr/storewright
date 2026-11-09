/** 场景文件：格式、检查、分享链接、仿真参数（见 types.ts 的说明） */
export * from './types';
export { parseScenario, parseClock, clockText, mergeFacilities, facilitiesDiff, type ParseResult } from './parse';
export { scenarioToSearch, scenarioHash, scenarioUrl, scenarioFromSearch, hasScenarioParams, mergeScenario, type UrlScenario } from './url';
