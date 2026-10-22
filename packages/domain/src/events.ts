import type { FulfillmentType, OrderType, TempZone, VehiclePosition } from './types';

/**
 * 领域事件（事件溯源的骨架）。
 *
 * 每个动作都是一条不可变事件；回放模式、审计日志、实时同步和指标计算都来自同一条事件流。
 * 键为事件类型，值为事件负载。
 */
export interface EventPayloads {
  OrderLocked: { orderId: string; type: OrderType; fulfillmentType: FulfillmentType; lines: number };
  ToteAssignmentsCreated: { orderId: string; toteIds: string[]; oversizedPieces: number };
  PickWalkCreated: { walkId: string; tempZone: TempZone; totes: number; stops: number; distanceM: number; estimatedSec: number };
  PickWalkClaimed: { walkId: string; associateId: string };
  ItemPicked: { walkId: string; toteId: string; lineId: string; itemId: string; qty: number };
  ItemNotFound: { walkId: string; lineId: string; itemId: string; resolution: 'SUBSTITUTED' | 'EXCEPTION' | 'SHORT' };
  ColdChainAlert: { walkId: string; elapsedSec: number; limitSec: number };
  PickWalkCompleted: { walkId: string; associateId: string; durationSec: number };
  ExceptionCreated: { exceptionId: string; orderId: string; lineId: string; itemId: string };
  ExceptionResolved: { exceptionId: string; found: boolean };
  ReplenishmentTaskCreated: { itemId: string; reason: 'EXCEPTION' | 'EMPTY' | 'LOW' | 'MANUAL' };
  /** 货架存量模块：拣货员遇到空货位；补货上架完成 */
  ShelfEmpty: { itemId: string; locationId: string };
  ReplenishmentCompleted: { itemId: string; locationId: string; units: number };
  /** 突发状况：小状况（标签重打、商品破损、框找不到、打印机卡纸）或大事件（火警、警情、停电、系统故障） */
  IncidentOccurred: { kind: string; ref?: string; extraSec?: number; until?: number };
  OversizedPicked: { pieceId: string; orderId: string; associateId: string };
  ToteStaged: { toteId: string; orderId: string; slotCode: string; recorded: boolean };
  OrderStaged: { orderId: string; lateBySec: number };
  CustomerApproaching: { orderId: string; etaSec: number };
  CustomerArrived: { orderId: string; tripId?: string };
  PrepStarted: { orderId: string; associateId: string; early: boolean };
  ReadyToLoad: { orderId: string };
  CodeVerified: { orderId?: string; tripId?: string };
  VehiclePlacementRecorded: { tripId: string; orderId: string; position: VehiclePosition };
  TripComposed: { tripId: string; orderIds: string[] };
  OrderHandedOff: { orderId: string; waitSec: number };
}

export type EventType = keyof EventPayloads;

export interface DomainEvent<K extends EventType = EventType> {
  seq: number;
  /** 仿真秒 */
  t: number;
  type: K;
  payload: EventPayloads[K];
}

export type AnyDomainEvent = { [K in EventType]: DomainEvent<K> }[EventType];

/** 事件日志：追加写入，可以关闭保留以节省内存（大批量实验时）。 */
export class EventLog {
  private seq = 0;
  readonly events: AnyDomainEvent[] = [];
  private readonly listeners: Array<(e: AnyDomainEvent) => void> = [];

  constructor(private readonly retain = true) {}

  append<K extends EventType>(t: number, type: K, payload: EventPayloads[K]): DomainEvent<K> {
    const event = { seq: ++this.seq, t, type, payload } as DomainEvent<K>;
    if (this.retain) this.events.push(event as AnyDomainEvent);
    for (const l of this.listeners) l(event as AnyDomainEvent);
    return event;
  }

  subscribe(listener: (e: AnyDomainEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  get count(): number {
    return this.seq;
  }
}
