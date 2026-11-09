import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultFacilities, RANGES } from '../facility/config';
import { DRILL_KEYS, GENS, LOAD_LEVELS, PRESETS, SCENARIO_FORMAT, SCENARIO_VERSION, SPEEDS, TABS, TOURS, WEATHERS } from './types';

/**
 * 场景文件的 JSON Schema（draft 2020-12），由这里的常量生成，写到 docs/scenario.schema.json（测试检查两者一致）：
 *   npx tsx src/scenario/schema.ts --write
 * 检查规则以 parse.ts 为准；Schema 给编辑器补全和别的语言的工具用。
 */
export function scenarioSchema(): Record<string, unknown> {
  const d = defaultFacilities();
  const fac: Record<string, unknown> = {};
  for (const k of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
    const props: Record<string, unknown> = {};
    for (const [f, [lo, hi]] of Object.entries(RANGES[k]) as [string, readonly [number, number]][]) props[f] = { type: f === 'size' ? 'number' : 'integer', minimum: lo, maximum: hi };
    props.down = { type: 'array', items: { type: 'string', maxLength: 39 }, description: 'Equipment under maintenance, e.g. ["QC1"]' };
    props.staff = {
      type: 'array',
      description: 'Crew changes per role; roles not listed stay unchanged',
      items: {
        type: 'object',
        required: ['key', 'crew'],
        properties: {
          key: { enum: d[k].staff.map((r) => r.key) },
          crew: { type: 'object', additionalProperties: false, properties: { early: { type: 'integer', minimum: 0, maximum: 200 }, late: { type: 'integer', minimum: 0, maximum: 200 }, night: { type: 'integer', minimum: 0, maximum: 200 } } },
        },
      },
    };
    fac[k] = { type: 'object', properties: props };
  }
  const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/Glacieerr/storewright/blob/main/StoreX-Chain/docs/scenario.schema.json',
    title: 'StoreX Chain scenario',
    description: 'A shareable, reproducible moment in the StoreX Chain regional twin. Every field is optional. See docs/07-scenarios.en.md.',
    type: 'object',
    properties: {
      $schema: { type: 'string' },
      format: { const: SCENARIO_FORMAT },
      version: { const: SCENARIO_VERSION },
      id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$', maxLength: 80 },
      title: { type: 'string', maxLength: 200 },
      titleEn: { type: 'string', maxLength: 200 },
      description: { type: 'string', maxLength: 2000 },
      descriptionEn: { type: 'string', maxLength: 2000 },
      region: { type: 'string', pattern: '^(default|random-\\d{1,6}|custom-\\d{1,6}(~[a-z]+\\.[A-Za-z0-9]+)*)$' },
      gen: { enum: [...GENS] },
      seed: { type: 'integer', minimum: 1, maximum: 9999 },
      load: { enum: [...LOAD_LEVELS] },
      drill: { enum: [...DRILL_KEYS] },
      facilities: { type: 'object', properties: fac },
      time: { oneOf: [{ type: 'integer', minimum: 0, maximum: 86399 }, { type: 'string', pattern: '^\\d{1,2}:\\d{2}(:\\d{2})?$' }] },
      speed: { enum: [...SPEEDS] },
      play: { type: 'boolean' },
      camera: { type: 'object', properties: { preset: { enum: [...PRESETS] }, position: vec3, target: vec3 }, dependentRequired: { position: ['target'], target: ['position'] } },
      follow: { type: 'string', maxLength: 40 },
      weather: { enum: [...WEATHERS] },
      tab: { enum: [...TABS] },
      tour: { enum: [...TOURS] },
      exercise: { type: 'string', pattern: '^ex\\d{2}$' },
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--write')) {
  writeFileSync(fileURLToPath(new URL('../../docs/scenario.schema.json', import.meta.url)), `${JSON.stringify(scenarioSchema(), null, 2)}\n`);
  process.stdout.write('written: docs/scenario.schema.json\n');
}
