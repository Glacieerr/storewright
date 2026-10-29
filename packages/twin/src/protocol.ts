import type { OpsState } from '@storewright/ops';
import type { TwinHealth } from './health';
import type { RuleConfig, SensorStatus } from './rules';
import type { Bucket } from './telemetry';

/**
 * 门店中枢和孪生查看端（模拟器、控制台）之间的消息（决策记录 0016）。
 * 传感器清单两边都从门店静态数据算出（registry.ts），这里只传读数。
 */

export interface SensorValue {
  id: string;
  v: number;
  s: SensorStatus;
  at: number;
  /** 越线、门开着或离线开始的时间 */
  since?: number;
}

/** 实时推送：订阅了孪生的连接每 2 秒收到一次 */
export interface TwinFrame {
  t: 'twin';
  at: number;
  sensors: SensorValue[];
  health: TwinHealth;
  /** 演示门店：正在模拟故障的传感器 */
  faults?: string[];
  /** 设备健康（预测性维护，决策记录 0022）：状态、预计多少分钟后越过告警线、底线温度每小时的变化 */
  equipment?: Array<{ id: string; s: 'OK' | 'WATCH' | 'RISK' | 'STUCK'; eta?: number; slope?: number }>;
}

/** GET /api/stores/:id/twin：打开孪生时取一次 */
export interface TwinSnapshot {
  at: number;
  /** 回放可以回到的最早时间（第一条作业事件） */
  from?: number;
  rules: RuleConfig;
  frame: TwinFrame;
  /** 最近 60 分钟的分钟汇总（面板里的迷你曲线） */
  series: Record<string, Bucket[]>;
  demo: boolean;
}

/** GET /api/stores/:id/twin/at?t=：回放到 t 时刻 */
export interface TwinReplay {
  at: number;
  state: OpsState;
  sensors: Array<{ id: string; v: number }>;
}
