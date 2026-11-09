/**
 * English UI strings for the scenario feature (share links, scenario library, scenario files, toasts),
 * keyed by the Chinese source text (merged into ../en.ts). Each feature keeps its own file so parallel
 * work does not collide in one big dictionary.
 */
export const EN_SCENARIO: Record<string, string> = {
  // index.html — top bar
  分享: 'Share',
  '复制此刻的分享链接、导出或导入场景文件': 'Copy a share link for this moment, or export / import a scenario file',
  场景库: 'Scenarios',
  '精选场景：点一下就切到那个区域、负荷、演练、时刻和镜头': 'Curated scenarios: one click switches to that region, load, drill, time and camera',
  // share popover
  分享此刻: 'Share this moment',
  '链接里有区域、方案、日子、负荷、演练、设施改动、时刻和镜头：别人打开看到的就是你现在看到的。':
    'The link carries the region, scheme, day, load, drill, facility changes, time and camera: whoever opens it sees exactly what you see now.',
  分享链接: 'Share link',
  复制链接: 'Copy link',
  导出场景文件: 'Export scenario file',
  导入场景文件: 'Import scenario file',
  打开场景库: 'Open scenario library',
  链接已复制: 'Link copied',
  '没能自动复制：链接已选中，请按 Ctrl+C / ⌘C': 'Could not copy automatically: the link is selected, press Ctrl+C / ⌘C',
  场景文件已导出: 'Scenario file exported',
  场景文件: 'Scenario file',
  '场景文件太大（最多 256 KB）': 'The scenario file is too large (256 KB at most)',
  '不是合法的 JSON：{err}': 'Not valid JSON: {err}',
  '已导入场景{title}': 'Scenario {title} imported',
  // library dialog
  '精选的几个场景：点一下就切到那个区域、负荷、演练、时刻和镜头。换区域或设施时会重新载入页面。也可以从「分享」导入自己的场景文件。':
    'A few curated scenarios: one click switches to that region, load, drill, time and camera. Changing the region or facilities reloads the page. You can also import your own scenario file from “Share”.',
  '正在读取场景库…': 'Loading the scenario library…',
  '场景库没读出来：{err}': 'Could not load the scenario library: {err}',
  '场景库里没有找到「{id}」（{err}）': 'Scenario “{id}” is not in the library ({err})',
  '切到场景「{title}」': 'Switching to “{title}”',
  导览: 'Tour',
  '随机区域 {n}': 'Random region {n}',
  改过设施: 'Facilities changed',
  // toasts and checks
  '还有 {n} 条': '{n} more',
  '{what}有 {n} 处不对，没有套用：': '{what}: {n} problem(s), not applied:',
  '{what}里有 {n} 处忽略了：': '{what}: {n} item(s) ignored:',
  '页面还在准备，稍等一下再试': 'The page is still getting ready, try again in a moment',
  链接里的场景: 'The scenario in the link',
  场景库里的场景: 'The library scenario',
  '这个场景需要的区域或设施没能套上（页面已经重新载入了几次），先停在这里':
    'Could not switch to the region or facilities this scenario needs (the page has reloaded several times), so it stops here',
  '没找到要跟随的车「{id}」': 'Vehicle “{id}” to follow was not found',
  // src/scenario/parse.ts, url.ts — validation messages (translated with tx())
  '{key} 应该是文字': '{key} should be text',
  '{key} 太长（最多 {max} 个字符）': '{key} is too long ({max} characters at most)',
  '{key} 只能是 {list}': '{key} must be one of {list}',
  '{key} 应该是三个数 [x, y, z]（米）': '{key} should be three numbers [x, y, z] (metres)',
  'facilities 应该是对象（port / airport / dc / store）': 'facilities should be an object (port / airport / dc / store)',
  '{key} 不认识，忽略': '{key} is not recognised, ignored',
  'facilities.{fk} 应该是对象': 'facilities.{fk} should be an object',
  '{key} 应该在 {a}–{b} 之间': '{key} should be between {a} and {b}',
  '{key} 应该是设备编号的数组（如 ["QC1"]）': '{key} should be an array of equipment ids (e.g. ["QC1"])',
  '{key} 应该是岗位数组：[{ "key": "recv", "crew": { "early": 3 } }, …]（key 是这个设施已有的岗位：{keys}）':
    '{key} should be an array of roles: [{ "key": "recv", "crew": { "early": 3 } }, …] (key is one of this facility\'s roles: {keys})',
  '{key} 类型不对': '{key} has the wrong type',
  '场景文件应该是一个 JSON 对象': 'A scenario file should be a JSON object',
  '字段 {k} 不认识，忽略': 'Field {k} is not recognised, ignored',
  'format 应该是 "{f}"': 'format should be "{f}"',
  'version {v} 不支持（这个版本只认 {n}）': 'version {v} is not supported (this version reads {n} only)',
  'id 只能用小写字母、数字和连字符': 'id may only use lowercase letters, digits and hyphens',
  'region 应该是 default、random-编号，或自定义写法（custom-7~sea.S~river.1，和网址里的 ?region= 一样）':
    'region should be default, random-<seed> or a custom spec (custom-7~sea.S~river.1, the same as ?region= in the URL)',
  'seed 应该是 1–9999 的整数': 'seed should be an integer from 1 to 9999',
  'time 应该是 "HH:MM" 或当天的秒数（0–86399）': 'time should be "HH:MM" or seconds of the day (0–86399)',
  'speed 只能是 {list}': 'speed must be one of {list}',
  'play 应该是 true / false': 'play should be true / false',
  'camera 应该是对象：{ "preset": "port" } 或 { "position": [x, y, z], "target": [x, y, z] }':
    'camera should be an object: { "preset": "port" } or { "position": [x, y, z], "target": [x, y, z] }',
  'camera.position 和 camera.target 要一起给': 'camera.position and camera.target must be given together',
  'exercise 应该像 ex01': 'exercise should look like ex01',
  'fac 参数解不开（链接可能被截断了）': 'The fac parameter cannot be decoded (the link may be truncated)',
  'scenario 参数只能是场景库里的编号（小写字母、数字、连字符）': 'The scenario parameter must be a library id (lowercase letters, digits, hyphens)',
  // web/src/assistantPanel.ts — the engine loads on first use
  '正在载入值班助手…': 'Loading the duty assistant…',
  '值班助手没能载入：{err}': 'The duty assistant could not load: {err}',
};
