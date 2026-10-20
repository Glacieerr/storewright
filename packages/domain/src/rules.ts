/**
 * 声明式规则引擎。
 *
 * 规则写成 JSON，便于在配置界面中编辑和校验，例如 GM / Oversized 分类：
 *
 *   { "id": "too-heavy", "when": { "field": "unitWeightKg", "op": "gt", "value": 13.6 }, "then": "OVERSIZED" }
 *
 * 规则按顺序求值，返回第一条命中规则的结果（first match）。
 */

export type Comparator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'notIn' | 'includes';

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { field: string; op: Comparator; value: unknown };

export interface Rule<T extends string = string> {
  id: string;
  description?: string;
  when: Condition;
  then: T;
}

export type Facts = Readonly<Record<string, unknown>>;

function compare(actual: unknown, op: Comparator, expected: unknown): boolean {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'notIn':
      return Array.isArray(expected) && !expected.includes(actual);
    case 'includes':
      return Array.isArray(actual) && actual.includes(expected);
  }
}

export function evaluateCondition(cond: Condition, facts: Facts): boolean {
  if ('all' in cond) return cond.all.every((c) => evaluateCondition(c, facts));
  if ('any' in cond) return cond.any.some((c) => evaluateCondition(c, facts));
  if ('not' in cond) return !evaluateCondition(cond.not, facts);
  return compare(facts[cond.field], cond.op, cond.value);
}

/** 返回第一条命中规则的结果；都不命中时返回 fallback。 */
export function firstMatch<T extends string>(rules: readonly Rule<T>[], facts: Facts, fallback: T): { result: T; ruleId?: string } {
  for (const rule of rules) {
    if (evaluateCondition(rule.when, facts)) return { result: rule.then, ruleId: rule.id };
  }
  return { result: fallback };
}
