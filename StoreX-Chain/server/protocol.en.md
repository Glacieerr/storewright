# Twin server interface

> **This is an English translation of [protocol.md](protocol.md).** protocol.md is the reference: if the two differ, protocol.md (and the code) is right. String values inside the JSON examples are what the server actually returns (Chinese interface text) and are left untranslated; where a field takes a fixed set of Chinese values, the English meaning is given in brackets.
>
> **Security:** the twin server is meant for local use. Its security model (loopback by default, a token for anything else, no wildcard CORS) is in the [Security](#security) section below and in [SECURITY.md](../../SECURITY.md).

The twin server runs the end-to-end simulation (to get the day's plan), the dispatch board (dock doors, store receiving docks and vehicles assigned) and the closed-loop twin (field + twin) on a server. It advances minute by minute in real time, which can be sped up, pushes the field's vehicle positions, sensor data and the twin's recommendations to external systems, and accepts their decisions and commands. Unreal Engine (`engines/ue5/`), MATLAB (`engines/matlab/`) and browsers all connect through this interface.

```bash
npx tsx server/twinServer.ts --port 8787 --gen g3 --seed 1 --level normal --policy safe --speed 10 --start 4 --region default --load normal
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--port`, `--host` | 8787, 127.0.0.1 | Listening address (local only by default; a non-local `--host` requires `--token`, otherwise the server refuses to start; see "Security") |
| `--token <token>` | no token | Access token (or the environment variable `STOREX_TOKEN`, so it does not appear in the process list): when set, state-changing endpoints and WebSocket commands must carry it |
| `--allow-origin <origin,origin>` | no CORS headers | Allowed browser origins (for example `http://localhost:5173`): only these origins get CORS headers, may change state and may open a WebSocket |
| `--insecure` | off | Start even when listening beyond the local machine without a token (with a warning; use only in a trusted network) |
| `--gen` | g3 | Generation: g1 previous generation, g2 StoreX, g3 StoreX Chain |
| `--seed` | 1 | Number of the simulation and of the field conditions (the same number gives the same day every time) |
| `--level` | normal | Field conditions: normal (an ordinary day), rough (an eventful day) |
| `--policy` | safe | What the twin may execute on its own: manual (everything confirmed by a person), safe (low-risk options run automatically), auto (everything runs automatically) |
| `--speed` | 10 | Simulated minutes per second (10 = a day in about 2.4 hours; can be changed with `/api/control`) |
| `--start` | 4 | Hour of the day to start from (the earlier part is run quickly at start-up; live and watch default to 0) |
| `--region` | default | Region: `default`, `random-<number>`, or a custom spec (the same syntax as `?region=` in the web app's address); the coast, river, city, roads, rail, port, airport, logistics park and store all follow this region |
| `--load` | normal | Load level: normal, peak, high, extreme (demand, liners, block trains and flights scale together; facilities use the default configuration) |

Test client: `npx tsx server/client.ts 8787` (checks health, model, state and recommendation cards, receives a few WebSocket frames and approves one pending card).

## Coordinates

- All positions in the service are "sandbox coordinates": metres, x east, z south, y up (three.js right-handed system). Regional distances are compressed to 1/10 (1 km is drawn as 100 m); buildings and vehicles keep their real size.
- Vehicle `heading`: degrees, 0 = east (+x), 90 = south (+z), clockwise seen from above.
- **Unreal Engine** (centimetres, left-handed, Z up): `X = x × 100`, `Y = z × 100`, `Z = y × 100`, `Yaw = heading`. With x east and z south, the left-handed system gives X east and Y south, so the heading needs no sign change.
- Vehicle positions are lane-level: they use the same road network as the web app's 3D scene (lanes, junctions, interchanges, roundabouts), the same stopping points (dock doors, store receiving docks, yards) and the same motion planning (drive past the door, then reverse onto it), so positions drawn in Unreal Engine match the web app. The position is the front of the vehicle (the leading point); when reversing, `reversing = true` and the heading still points where the front of the vehicle points.

## REST

Every endpoint returns JSON. No CORS headers are sent by default (only browser origins listed in `--allow-origin` get them; see "Security").

| Method | Path | Meaning |
| --- | --- | --- |
| GET | `/api/health` | `{ ok, t, clock }`; t is seconds since midnight of the simulated day |
| GET | `/api/model` | The static model: generation, seed, field conditions, `region` and load level `load`, coordinate notes, the store (centre, heading, positions of its 4 receiving docks), positions of the DC's 38 dock doors, road nodes, product families (temperature zone, source, whether shipped direct to the store), the day's vehicles and their job IDs |
| GET | `/api/state` | Now: `t`, `clock`, `speed`, `paused`, cumulative KPIs `kpi`, every vehicle on the road `vehicles`, which vehicle occupies each door and receiving dock `doors`, the store's stock per product family (twin estimate `est` / field truth `truth`), number of pending recommendation cards |
| GET | `/api/messages?since=0&limit=1000` | Sensor data sent by the field (from message number since), returns `{ next, total, msgs }`; continue with next |
| GET | `/api/recommendations` | All of the day's recommendation cards (structure below) |
| GET | `/api/vehicle?vid=19` | Details of one vehicle: current position and state, plus origin, destination, planned departure / arrival, next stop and estimated arrival, load, cargo, and the planned and estimated arrival at each stop (structure below) |
| POST | `/api/approve` | `{ key, option? }`: approve a pending recommendation card (without option, the recommended option runs); takes effect now |
| POST | `/api/reject` | `{ key }`: reject a pending recommendation card |
| POST | `/api/command` | A command (structure below), sent straight to the field; takes effect now |
| POST | `/api/control` | `{ speed?, paused? }`: change speed, pause / resume |
| GET / POST | `/api/assistant?q=…&role=…` (POST with `{ question, role }`) | Duty assistant: the same assistant as in the web app, reading the service's current plan, closed loop and the day plans of the four warehousing hubs (port logistics center, air cargo terminal, logistics park, store); `role` is the role of the person asking (structure below) |
| GET | `/api/assistant/tools` | The assistant's query tools (name, description, JSON Schema of the parameters), ready for a future language model |
| GET | `/api/watch` | Things to watch now (urgent first), with proposals where something can be done |
| GET | `/api/handover?shift=dawn\|day\|mid\|night` | Shift handover report (without shift: the current shift; within half an hour of a shift starting, the shift that just ended), with Markdown |
| GET | `/api/review` | Recommendation review: cards handled so far, the twin's prediction against the field's actual outcome, statistics by kind |
| GET | `/api/kpi` | Tiered KPI board: current value and state of the group, region, facility and operation KPIs (ok / warn / alarm / na, with the web app's default thresholds; the service has no facility monitor, so port gate, container yard and dock-door items are na) |

### Vehicles (`vehicles[]` of `/api/state`, WebSocket `tick`)

```json
{ "vid": 19, "id": "M04", "kind": "reefer", "label": "多温区配送车 · 24 托",
  "x": 252.08, "z": -261.84, "heading": 135, "reversing": false,
  "act": "开往综合店", "delayMin": 47, "temp": 2.3, "state": "抛锚",
  "from": "物流园配送中心", "to": "综合店", "depart": 27000, "arrive": 30720,
  "next": "综合店", "nextPlan": 28980, "eta": 31800,
  "load": "24 托 · 3,100 件 · 6.2 吨", "kg": 6200, "cargo": "冷藏、冷冻、常温" }
```

- `kind`: truck (ambient truck / long-haul truckload), reefer (refrigerated and multi-temperature trucks), ev (electric delivery truck), van (online delivery vans and small vans), drayage (container truck), train, ship, plane;
- `delayMin`: minutes behind plan; `temp`: cargo temperature of a refrigerated vehicle (°C); `state`: `抛锚` [broken down], `等救援车` [waiting for the rescue truck], `等月台门` [waiting for a dock door], `等收货口` [waiting for a store receiving dock], `按指令晚点到` [holding back on instruction] (empty = normal);
- `from` / `to`: origin and final destination; `depart`: planned departure; `arrive`: planned arrival at the last stop (both in seconds since midnight);
- `next`: the next place to reach; `nextPlan`: planned arrival there; `eta`: estimated arrival. For the store stop it is the twin's estimate from sensor data (traffic, whether a receiving dock is free); otherwise the delay derived from positioning is carried forward;
- `load`: load (pallets, units, tonnes; for trains, ships and planes, containers / ULDs); `kg`: weight in kilograms (only where it can be computed); `cargo`: what is on board;
- Vehicles dispatched by the twin (rescue trucks, top-up restock trucks) get `vid` numbers after the day's vehicles.

`/api/vehicle?vid=19` adds `stops` to the fields above: for each stop, `name`, planned arrival `plan`, estimated arrival `eta` for stops not yet reached, and whether it has been passed (`passed`). Equipment and job progress at the port, airport, logistics park and store receiving area (quay cranes, gantry cranes, loaders, dock doors, forklifts, stacker cranes and so on) are shown in the web app's facility monitor, computed in the browser from the same plan.

### Sensor data (`msgs[]`)

| kind | Fields | Frequency |
| --- | --- | --- |
| `gps` | vid, x, z | Every vehicle every minute (a few metres of error) |
| `event` | vid, ev (depart / arrive / leave / fault / fixed / ack / done / eta), place?, code?, note?, fam?, units?, eta? | When it happens; long-haul trucks (direct to store or into the DC) report `eta` (estimated time of entering the region, seconds of the day) every hour from 4 hours before entering the region |
| `temp` | vid, air, product, set, door, cool | Refrigerated vehicles every 5 minutes |
| `load` | vid, door, done, total | Every 5 minutes while loading (pallet scans) |
| `door` | door (C01…, D01…, S01-1…S01-4), open, vid | When a vehicle docks / leaves |
| `pos` | store, fam, units | Every 15 minutes per product family |
| `stock` | store, fam, units | Every hour per product family |
| `traffic` | id, x, z, r, factor, until, text, end? | Accidents / roadworks start and end |
| `soc` | vid, soc | Electric vehicles every 10 minutes |

WebSocket pushes leave out gps and pos (too much data); use `/api/messages` for everything.

### Recommendation cards (`/api/recommendations`, WebSocket `cards`)

```json
{ "key": "breakdown:19", "kind": "breakdown", "t": 27300, "clock": "07:35",
  "title": "M04 抛锚", "text": "…", "status": "proposed", "best": "wait",
  "options": [
    { "key": "rescue", "label": "派救援车接走车上的货", "late": 0, "hot": 0, "short": 0, "cost": 238,
      "note": "救援车约 53 分钟后到，转运 30 分钟", "auto": false, "hasCommands": true },
    { "key": "wait", "label": "等修好（约 1.5 小时）", "late": 0, "hot": 0, "short": 0, "cost": 0,
      "note": "门店合计晚 0 分钟", "auto": true, "hasCommands": false } ] }
```

- `kind`: late (predicted late arrival), temp (temperature about to exceed the limit), breakdown (vehicle broken down), door (wait for a dock door), stockout (the store is about to run out);
- Every option carries the twin's simulated outcome: late minutes, over-temperature minutes, stock-out minutes (summed over product families) and extra cost (USD). The recommended option has the lowest total score (late + over-temperature × 2 + stock-out × 1.5 + cost ÷ 12); `auto` = low risk, executed automatically under the "safe" policy;
- `status`: proposed (pending), done (executed; `by` = auto / user, `chosen` = the option executed), rejected, resolved (the problem went away on its own), expired (nobody acted and the problem really happened).

### Commands (request body of `/api/command`, WebSocket `cmd`)

| kind | Fields | Meaning |
| --- | --- | --- |
| `notifyStore` | store, until | Tell the store to extend its receiving cut-off to until (seconds) |
| `resequence` | vid, order | Deliver the remaining stores on board in a new order |
| `rescue` | vid | Send a rescue truck to take over the cargo of a broken-down vehicle or one with a failed reefer unit |
| `driverCheck` | vid | Ask the driver to stop and check the door seals |
| `setpoint` | vid, delta | Adjust the reefer setpoint remotely (relative to the standard value, at most −2 °C) |
| `reassignDoor` | vid, door | Move a vehicle waiting for a door to another dock door |
| `restock` | fam, units | The DC sends an extra small truck to top up one product family at the store |
| `divert` | vid, to (store / DC) | Send a long-haul truck bound for the DC straight to the store, or a direct truck to the DC |
| `hold` | vid, until | Make a vehicle arrive later (wait at the roadside until until) |

### Duty assistant (`/api/assistant`)

```json
{ "t": 39600, "clock": "11:00", "q": "批准第一条", "intent": "approve", "confidence": 1,
  "text": "要执行的是：执行「通知综合店顺延收货」（DS-BEV-2 到综合店预计晚 231 分钟）。…",
  "cites": ["闭环孪生（现场的感知数据和孪生的估计）"],
  "links": [{ "kind": "card", "key": "late:2:S01", "label": "看建议卡" }],
  "proposals": [{ "id": "p12", "title": "执行「通知综合店顺延收货」（…）", "effect": "推演结果：多花 $25；不处理的话迟到 231 分钟。…",
                  "risk": "high", "cost": 25, "actions": [{ "kind": "decide", "key": "late:2:S01", "action": "approve", "option": "notify" }],
                  "requests": [{ "method": "POST", "path": "/api/approve", "body": { "key": "late:2:S01", "option": "notify" } }] }],
  "followups": ["为什么推荐第一条"], "tools": [{ "name": "propose_decision", "args": { "keys": ["late:2:S01"], "action": "approve" } }] }
```

- The assistant only reads: anything that would change state comes back as a proposal, and `requests` lists the endpoints to call to carry it out; the caller makes those calls (after a person confirms). Dispatch-board fixes need a re-simulation and cannot be executed in the service;
- `intent` is the intent (rules + logistic regression classification, with naive Bayes kept only for comparison; when unsure the assistant asks a question), `tools` lists the query tools called; every number comes from tool results;
- The service has no facility monitor (port, airport and logistics-park equipment is computed in the web app from the plan); questions about a facility are answered with the jobs related to it.

> Translator's note: the classifier comparison and the abstention thresholds are in [assistant-eval.md](../docs/results/assistant-eval.md).

Every answer is also given in four parts (the web app's assistant panel uses the same four):

```json
{ "q": "DS-BEV-2 为什么晚了", "intent": "rootcause",
  "conclusion": "DS-BEV-2 到店开始卸货时（10:09）按计划在走，没有晚（比计划差不到 1 分钟）。",
  "basis": { "tools": [{ "name": "explain_delay", "cite": "闭环孪生（现场的感知数据和孪生的估计）：每分钟的延误、车载终端事件、路况、调度指令" }],
             "asOf": 38160, "quality": { "level": "good", "label": "良好", "text": "…" } },
  "certainty": { "value": 0.88, "level": "高", "intent": 0.98, "data": 1, "model": 0.9, "notes": ["原因按每分钟的延误增量逐分钟归因…"] },
  "next": [{ "text": "可以接着问：「现在有什么风险」" }],
  "grounding": { "total": …, "grounded": …, "missing": [] },
  "entities": { "vehicles": ["DS-BEV-2"], "fams": [], "doors": [] },
  "data": [{ "…": "各个工具返回的结构化结果" }] }
```

- `conclusion`: a one-sentence conclusion; `basis`: which tools were used, the time the data is as of (seconds of the day) and data quality; `certainty` = intent-classification certainty × data quality × model validation; `next`: what to do next and who must approve;
- `grounding` is the number check: every number, time and ID in the answer must be found in the tool results (or in the question or the policy table); a non-empty `missing` is a defect (evaluation in [`docs/results/assistant-eval.md`](../docs/results/assistant-eval.md));
- When a question lacks the vehicle, card or warehousing hub, the answer is `clarify: { question, options }` instead of a guess; out-of-scope questions get `declined: true` with what the assistant can do; requests to skip confirmation or approval get `refused: true`, and proposals still need a person to confirm;
- `role` is `dispatcher` (default), `manager` (site manager), `regional` (regional manager) or `viewer` (read only); unknown values fall back to the default. In a proposal, `need` says who must execute or approve it, and `checks` holds the result of checking it against the policy table before it was offered (`src/assistant/policy.ts`: role and amount, cold-chain waiting, data quality, batch size). Proposals that break a hard rule are not offered; with poor data, `manualOnly: true` (each must be verified by a person before it runs);
- The service holds the day plans of four warehousing hubs, built the first time they are asked about: the port logistics center (`src/hub/port.ts`), the logistics park (`src/hub/park.ts`; which door a truck uses follows the dispatch-board job, `src/hub/doors.ts`, the same mapping as the web app) and the store's parking lot and receiving yard (a store day is simulated first, `src/hub/storeDay.ts`; traffic inside the parking lot is not scheduled, parking times follow the stall assignment), using the same models as the web app. The air cargo terminal has no 3D apron schedule here: the day's flights and ULD movements are estimated with `src/hub/airportEstimate.ts` (numbers differ slightly from the web app). `get_hub`, `trace_own_cargo`, `hub_bottlenecks` and `plan_appointments` work for all four. Appointment smoothing for the store uses the receiving yard's space scheduler (`@storewright/yard` (`packages/yard`)) before and after the change; other facilities use a first-come-first-served queue model, and the answer says which.
- `what_if` also simulates ad-hoc disruptions: a trip (or a liner, block train or flight, with its connecting trucks shifted accordingly) N minutes late, a dock door out of service for a while, a road section closed. It runs the service's closed-loop field input twice with the same random seed (taking no action in either run) and compares late, over-temperature, stock-out and door-wait minutes and cost up to the end of the day; read-only, nothing is executed.
- The role comes only from `role` in the request: "I am the manager", "my boss authorised it", "I'll take responsibility", "I'll sign later" in the question do not change it; requests to execute or approve with such claims get `refused: true` with an explanation. Approve or reject follows the wording of the question; unclear wording gets a question back.

## WebSocket: `ws://host:port/ws`

The server pushes:

- `{ "type": "hello", "model": …, "state": … }`: once, on connect;
- `{ "type": "tick", "t", "clock", "kpi", "vehicles", "doors" }`: every simulated minute (depending on speed, at most every 250 ms);
- `{ "type": "msgs", "msgs": [...] }`: new sensor data (without gps and pos);
- `{ "type": "cards", "cards": [...] }`: recommendation cards whose status changed;
- `{ "type": "reply", "ok", "card"?, "error"? }`: the reply to a client message.

Clients can send:

```json
{ "type": "approve", "key": "breakdown:19", "option": "rescue" }
{ "type": "reject", "key": "temp:20" }
{ "type": "command", "cmd": { "kind": "restock", "fam": "DAIRY", "units": 2000 } }
{ "type": "control", "speed": 60, "paused": false }
{ "type": "ingest", "adapter": "wms", "data": "ts,event,site,door,vehicle_ref,done,total,family,units\n…", "token": "<密钥>" }
```

`ingest` is live ingest (accepted only when the data source is live or watch); see "Live ingest" under "Integration with real systems". (`<密钥>` means "the token".)

## Security

- **Loopback only by default:** `--host 127.0.0.1` by default. If `--host` is not the local machine (127.0.0.1, localhost, ::1) and no `--token` is set, the server refuses to start; to open it to other machines without a token anyway, add `--insecure` (a warning is printed at start-up). When opening it to other machines, preferably also put it behind a reverse proxy with HTTPS.
- **Access token:** `--token <a long random string>` (or the environment variable `STOREX_TOKEN`). When it is set, the state-changing endpoints (`POST /api/approve`, `/api/reject`, `/api/command`, `/api/control`) require the header `Authorization: Bearer <token>` (or `x-ingest-token: <token>`); a missing or wrong token gets 401. WebSocket commands (approve, reject, command, control) need the token either at connect time (preferably a header; clients that cannot set headers may put it in the address as `ws://host:port/ws?token=<token>`, over loopback or TLS only; the UE plugin just puts it in its ServerUrl) or as `"token": "<token>"` in each message; otherwise the reply is `{ "type": "reply", "ok": false }`. Read-only queries (state, model, messages, duty assistant) need no token. Live ingest (`/api/ingest/*`, WebSocket ingest) uses `--ingest-token`, or the access token when that is not set separately.
- **Browser origins:** no CORS headers by default (the former `access-control-allow-origin: *` is gone). Browser requests (those with an `Origin` header) that change state or open a WebSocket must come from an origin in the `--allow-origin` list (the server's own address counts too), otherwise they get 403; only listed origins get CORS headers. The local script (`server/client.ts`), the UE plugin and the MATLAB client send no browser origin and keep working.
- **Request bodies and parameters:** JSON request bodies are capped at 64 KB (413 above); a body that is not a JSON object gets 400; numeric URL parameters (`since`, `limit`, `vid`) that are not numbers get 400.
- The local default (loopback only, no token) works as before: `server/client.ts`, the UE plugin (`ws://127.0.0.1:8787/ws`) and MATLAB (`http://127.0.0.1:8787`) need no change. With a token set, `server/client.ts` and MATLAB must add the `Authorization` header (in MATLAB, `weboptions('HeaderFields', {'Authorization', 'Bearer <token>'})`).

## Optional LLM mode

With `STOREX_LLM` set (`claude` or `local`), `/api/assistant` answers through a language model that calls the assistant's own tools; the response's `engine` field says which engine answered (`builtin`, `claude`, `local`) and `engineNote` gives the reason when it fell back to the built-in assistant. Without it nothing changes. Setup, privacy and cost: [docs/06-llm-option.md](../docs/06-llm-option.md). The web panel's "local twin server" engine needs `--allow-origin http://localhost:5173`.

## Notes

- By default the service listens only on the local machine; for the access token, browser origins and request-body limits, see "Security".
- All times are seconds since midnight of the simulated day; when the day is over the clock stops at 24:00 (restart the service for another day or other field conditions).
- This project is not affiliated with any retailer or company (本项目与任何零售商、企业无隶属关系); all data is synthetic.

## Integration with real systems

By default the twin server's data comes from the field simulated inside the service. `server/adapters/` adds a layer so the same twin (the same estimation, what-if simulation, recommendation cards and automatic execution) can run on data from external systems: a transport management system (TMS), warehouse and store systems (WMS) and port electronic data interchange (EDI). The data can be a recording, files in a directory, data pushed live by an external system (`/api/ingest`), or a directory the service watches for appended data. Wherever the data comes from, the REST and WebSocket interfaces above stay the same.

```bash
# Record: run one day of the simulated field and record every message the twin receives (.gz = compressed)
npx tsx server/twinServer.ts --record day.jsonl.gz --start 0
# Replay: run the twin again on that recording (plan from the recording's generation, seed, region, load, day and policy)
npx tsx server/twinServer.ts --source replay:day.jsonl.gz
# External system files: tms*.jsonl / *.json → transport management, *.csv → warehouse and store, *.edi → port; meta.json names the matching plan
npx tsx server/twinServer.ts --source feed:server/adapters/samples --outbox outbox.jsonl
# Live ingest: external systems push to /api/ingest/tms|wms|edi (after live: the meta.json of the matching plan, optional)
npx tsx server/twinServer.ts --source live:server/adapters/samples/meta.json --speed 600
# Sender script: push the samples at the data's own timestamps (60 minutes of data per second; 0 = as fast as possible)
npx tsx server/adapters/send.ts --to http://127.0.0.1:8787 --from server/adapters/samples --speed 60
# Watch a directory: new files are read from the start, existing files from where reading stopped (meta.json in the directory names the plan)
npx tsx server/twinServer.ts --source watch:/path/to/drop-folder
# Sample data (one simulated day written in the three interface formats plus a recording, about 290 KB in total)
npx tsx server/adapters/samples.ts
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--source` | sim | `sim` the field simulated in the service (exactly as before); `replay:<file>` a recording; `feed:<dir>` external system files; `live` or `live:<meta.json>` external systems push data live; `watch:<dir>` watch a directory for new files and appended data |
| `--ingest-token <token>` | no token | Shared token required for live ingest (or the environment variable `STOREX_INGEST_TOKEN`, so it does not appear in the process list). The minimum when the service does not listen only on the local machine (`--host` is not 127.0.0.1) |
| `--lateness <seconds>` | 60 | live, watch: how late data may arrive; the twin advances at most to "newest data time received − this" |
| `--record <file>` | not recorded | Write the data the twin receives, new or re-planned vehicles and the commands it sends as JSON Lines (works with any source) |
| `--outbox <file>` | not written | Translate the twin's commands into external-system instructions and append them to this file (JSON Lines); also available from `/api/outbox` |
| `--geo-origin lat,lon` | 0,0 | Origin for converting latitude/longitude to sandbox coordinates (the default is a synthetic origin, not a real place); can also be set as `geoOrigin` in meta.json |

Replays and external data carry their matching plan: `--gen`, `--seed`, `--region`, `--load` and `--policy` given on the command line win; anything not given comes from the recording's header or meta.json. live and watch start at midnight by default (with `--start`, the service first fast-forwards to that hour, and earlier data counts as late).

### When reality is a recording or an external system

- The loop still steps one minute at a time: each step hands the twin the data due in that step (a recording by the step in which the twin originally received it; external systems by the data's own timestamps), and the twin estimates, simulates, raises cards and sends commands within its policy as usual.
- Commands cannot change reality: they are recorded and translated into external instructions in the outbox. New vehicles caused by commands (rescue trucks, top-up restock trucks) and changed plans are registered with the twin through the recording or through the TMS "new trip" record.
- What the interface calls "the field" is inferred from the data: vehicle positions from the twin's estimated progress (plan clock = now − estimated delay); dock doors and store receiving docks from door sensors; store stock from the latest stock count minus later sales; the store's own containers from port EDI events. In the cumulative results, lateness compares when the store receiving dock opened (unloading started) with the receiving cut-off, over-temperature comes from reefer readings (one every 5 minutes), stock-outs from the observed stock, and the cost of actions from the simulated cost of the executed options.
- Waiting for a dock door or a receiving dock is inferred from door sensors: once a vehicle has arrived at the DC (arrival event; vehicles whose plan starts with loading or unloading count as on site from their first message of the day) or at the store (arrival event), and its planned loading/unloading time has come (vehicles planned to wait on site first are shifted later; at the store, nothing starts before the store opens), if its dock door is occupied by another vehicle (at the store: all receiving docks occupied by other vehicles), the wait runs from then until its own door (receiving dock) opens; the vehicle state in `/api/state` still shows `等月台门` [waiting for a dock door] or `等收货口` [waiting for a receiving dock]. Compared with the simulated field, each vehicle is within 1 minute (`tests/adapters.test.ts`). The number of receiving docks follows the facility configuration; if the data uses a higher dock number, the data wins.
- With the same recording, the same policy and no dispatcher intervention, a replay produces exactly the same recommendation cards and commands as the recorded run (`tests/adapters.test.ts` compares them card by card); once a dispatcher approves or rejects at a different moment, the run diverges from the recording (reality is still the recording).

### Live ingest (live, watch)

External systems push data as things happen, and the service hands it to the twin by the data's own timestamps. The three entry points use the same interface and checks (formats in the next three sections):

| Method | Path | Body |
| --- | --- | --- |
| POST | `/api/ingest/tms` | Transport management: JSON Lines (one record per line) or one JSON array |
| POST | `/api/ingest/wms` | Warehouse and store: CSV with a header, or JSON (one array, or one object per line, keys as the CSV column names; `vehicle_ref` may also be written `vehicleRef`) |
| POST | `/api/ingest/edi` | Port: EDIFACT text (one interchange, which may contain several messages) |

```bash
curl -X POST http://127.0.0.1:8787/api/ingest/tms -H 'x-ingest-token: <token>' --data-binary @tms.jsonl
```

```json
{ "ok": true, "adapter": "tms", "accepted": 1025, "rejected": 1,
  "reasons": [{ "at": "第 7 行", "reason": "不认识的车辆编号" }], "queued": 812, "newest": 61200 }
```

`accepted` / `rejected` count the records accepted and rejected in this batch (`reasons` lists at most 20), `queued` is the number of records the twin has not reached yet, and `newest` is the newest timestamp received (seconds). Status codes: 401 wrong token, 404 no such endpoint, 409 the data source is not live / watch, 413 more than 16 MB at once.

Data can also be pushed over WebSocket: `{"type":"ingest","adapter":"tms","data":"…text…","token":"<token>"}` (for TMS and WMS, `data` may also be a JSON array; if the connection request carried an `x-ingest-token` header, messages may omit `token`); the reply is `{"type":"reply","ok":true,"accepted":…,…}`.

- Time: the twin follows the data it has received and never runs ahead of it, advancing up to "newest data time received − `--lateness` (default 60 seconds)"; `--speed` then becomes the maximum speed. If the data stops, the twin stops there (the time of each adapter's last record in `/api/adapters` shows who stopped).
- Late and out-of-order data is handled like the data-quality channel: data whose time the twin has already passed (late) is handed over in the next step and recorded at the time it happened; positions older than one already handed to the twin for the same vehicle (stale) are not used. Late door, stock-count and fault records do not change the "current" state (they are older than what is already in use). `/api/adapters` has three extra counts per adapter: `late`, `outOfOrder` (older than the newest record this adapter has already received) and `stale` (positions that were too old to use).
- Records outside the twin's day (earlier than 18:00 the day before, later than 02:00 the day after) are rejected, so a record with a wrong date cannot drag the twin's clock away.
- A new trip (`trip`) must be pushed before the records that use its ID (within one batch, the TMS adapter processes new trips first); the sender script pushes each batch per adapter, TMS first.
- watch: the directory is read every second; new files from the start, files already read only from where reading stopped; only complete records are handed over (whole lines, whole EDIFACT messages), and a half line waits for the next read. Continued reads get the file's CSV header or EDI service string prepended. A truncated or replaced file is read again from the start; `*.json` (one array) is read once as a whole file. The push endpoints also work in watch mode. Do not write the recording (`--record`) or outbox (`--outbox`) files into the watched directory.
- Security: by default the service listens only on the local machine (127.0.0.1). To let other machines push data, the minimum is `--ingest-token` (a long random string); push requests carry the header `x-ingest-token: <token>` (or `Authorization: Bearer <token>`); preferably also put the service behind a reverse proxy with HTTPS. Prefer the header: `?token=` on the WebSocket URL exists for clients that cannot set headers and should be used only over loopback or TLS (HTTPS / WSS), because URLs tend to end up in logs. If the service listens on a non-local address without an access token (`--token` or `STOREX_TOKEN`), it refuses to start unless `--insecure` is given (see Security).
- Sender script `server/adapters/send.ts`: splits the `*.jsonl`, `*.csv` and `*.edi` files in a directory into timestamped records and pushes them in time order. `--speed` minutes of data per second (0 = as fast as possible), `--token` the token (or the environment variable), `--start` / `--end` push only data between those hours, `--max` maximum records per batch (default 2000); at the end it prints how many records each adapter accepted and rejected, and why.

### Recording format (JSON Lines)

| type | Fields | Meaning |
| --- | --- | --- |
| `meta` | version, gen, seed, level, policy, region, load, day, created | Header: the matching plan |
| `msg` | step, msg | Which sensor message the twin received in which step (the step's start time, seconds), in the order received |
| `vehicle` | eff, vid, v, extra?, replan? | A new vehicle (rescue truck, top-up restock truck) or a vehicle with a changed plan: the step it takes effect from, the vehicle index and the planned track |
| `cmd` | cmd | A command the twin sent (for reference only; not treated as reality during replay) |

### Time, coordinates and vehicle IDs

- Time: external systems use "date + local time" (ISO 8601, no time zone, milliseconds allowed); the simulated day uses the synthetic date 2030-03-28 (the early hours of the next day are 2030-03-29).
- Coordinates: external systems use latitude/longitude, converted to sandbox coordinates with an equirectangular projection around the origin (1 real metre = 0.1 sandbox metre).
- Vehicle IDs: the job IDs of the dispatch board (M02, DS-BEV-1, VS1…); vehicles dispatched by the twin are registered with a "new trip": rescue trucks `RS-<original ID>`, top-up restock trucks `RT-<product family>-<index>`. Places such as the store, the DC and the port use the twin's IDs (S01, DC, PORT…).

### Transport management system (TMS, JSON Lines)

| type | Fields | → Sensor data |
| --- | --- | --- |
| `position` | ts, vehicleRef, lat, lon | `gps` |
| `status` | ts, vehicleRef (null for confirmations by the store), status, location?, code?, note?, family?, units? | `event`: DEPARTED → depart, ARRIVED → arrive, LEFT → leave, BREAKDOWN → fault (ENG), REEFER_FAULT → fault (COMP), REPAIRED → fixed, INSTRUCTION_ACK → ack, TASK_DONE → done |
| `eta` | ts, vehicleRef, eta, note? | `event` (eta: when a long-haul truck expects to enter the region) |
| `reefer` | ts, vehicleRef, airTemp, productTemp, setPoint, doorOpen, compressorOn | `temp` |
| `battery` | ts, vehicleRef, soc (0–1) | `soc` |
| `incident` | ts, incidentRef, lat, lon, radiusM (real metres), travelFactor, until, text, cleared? | `traffic` |
| `trip` | ts, vehicleRef, kind, label, purpose (rescue / restock / replan), forRef?, family?, units?, loadAt?, segments[{start, end, path[[lat, lon]…], act?, place?, nodes?, loop?, yaw?}] | Registers a new trip or a changed plan (processed first within a file) |

```json
{"type":"position","ts":"2030-03-28T09:30:00","vehicleRef":"M02","lat":0.0231877,"lon":0.0590271}
{"type":"status","ts":"2030-03-28T09:41:00","vehicleRef":"M02","status":"ARRIVED","location":"S01"}
{"type":"reefer","ts":"2030-03-28T09:45:00","vehicleRef":"M04","airTemp":3.412,"productTemp":3.902,"setPoint":3,"doorOpen":false,"compressorOn":true}
```

Twin commands → TMS dispatch instructions (`{"type":"instruction","id":"TI-00001","ts":…,"action":…}`): resequence → RESEQUENCE (stops), hold → HOLD_UNTIL (until), divert → DIVERT (to), rescue → DISPATCH_RESCUE, notifyStore → NOTIFY_STORE (storeRef, receiveUntil), driverCheck → DRIVER_CHECK, setpoint → REEFER_SETPOINT (deltaC).

### Warehouse and store systems (WMS, CSV)

Columns: `ts,event,site,door,vehicle_ref,done,total,family,units` (the first line is the header; cells containing commas or quotes are wrapped in double quotes).

| event | Columns used | → Sensor data |
| --- | --- | --- |
| DOOR_OPEN / DOOR_CLOSE | site (DC or a store ID), door (C01…, D01…, S01-1…), vehicle_ref | `door` (waits for dock doors and receiving docks are inferred from it) |
| LOAD_SCAN | door, vehicle_ref, done, total (pallets) | `load` |
| STOCK_COUNT | site (store), family, units | `stock` (shelf + backroom) |
| SALES | site (store), family, units | `pos` (units sold in the last 15 minutes) |

Twin commands → warehouse system tasks: reassignDoor → `{"task":"DOOR_REASSIGN","vehicleRef":…,"door":…}`, restock → `{"task":"REPLENISH","to":"S01","family":…,"units":…}`.

### Port electronic data interchange (EDI, a simplified UN/EDIFACT subset)

Reads and writes port events for the store's own containers using UN/EDIFACT syntax (UNA service string, segment terminator `'`, element separator `+`, component separator `:`, release character `?`). The message types, segment usage and codes are this project's own convention, not any terminal's or shipping line's implementation guide.

| Message | Code | Event | → Sensor data (place PORT, note holds the event and container number) |
| --- | --- | --- | --- |
| CODECO | BGM 34 / 36 | Gate in / gate out | `event` arrive / leave (drayage truck) |
| COARRI | BGM 44 / 45 | Discharge / load (onto the block train or a truck) | `event` done (ship, block train or truck) |
| IFTSTA | BGM 23, STS CR / HD | Customs release / customs hold for inspection | `event` done (vid = −1, no vehicle) |

Each message: `UNH`, `BGM`, `DTM+137` (message time), `TDT` (mode 1 sea / 2 rail / 3 road; the last element is the vessel or vehicle ID), `LOC+165` (place), one group per container of `EQD` (container number, size and type, 5 full / 4 empty) + `DTM+203` (event time, format 204: year month day hour minute second) + `STS` (IFTSTA only), `CNT`, `UNT` (segment count). Container numbers are checked against the ISO 6346 check digit; the sample container numbers are synthetic (owner code SXC).

```
UNH+2+COARRI:D:95B:UN'
BGM+44+CO00002+9'
DTM+137:20300328023253:204'
TDT+20++1+++++VS1'
LOC+165+PORT'
EQD+CN+SXCU0860010+45G1:102:5+++5'
DTM+203:20300328023253:204'
CNT+16:1'
UNT+9+2'
```

These events go into the data stream (`/api/messages`) and the adapter statistics; the twin's estimates are not per container. "The observed field" keeps the current state of each of the store's containers by container number: discharged and waiting for customs release, under customs inspection, released and waiting to be picked up, loaded onto the block train or a truck, gated out (events are ordered by the time they happened, late events are slotted back in, and a resent event is counted once). `/api/containers` returns it, and the assistant's "how is the port" answer gets an extra line about the store's containers.

```json
{ "t": 36000, "clock": "10:00", "source": "live", "summary": { "total": 3, "byState": { "海关已放行，等装车提走": 2, "已卸船，等海关放行": 1 } },
  "containers": [{ "id": "SXCU0860047", "state": "discharged", "label": "已卸船，等海关放行", "since": 28568, "sinceClock": "07:56",
                   "customs": "pending", "vehicle": "VS1", "events": [{ "t": 28568, "clock": "07:56", "code": "DISCHARGE", "note": "卸船" }] }] }
```

### Bad data

Every adapter checks record by record; bad records are skipped and counted by reason, and the service keeps running: invalid JSON, unknown record type, wrong time format, unknown vehicle ID, invalid coordinates, unknown status, invalid reading or value, wrong number of columns, missing door or product family, segment count not matching UNT, unsupported message type, wrong container check digit, incomplete file.

### Endpoints

| Method | Path | Meaning |
| --- | --- | --- |
| GET | `/api/health` | Adds `source`: sim / replay / feed / live / watch |
| GET | `/api/model` | Adds `source`: the source, the file or directory, how many records each file had accepted and rejected, the file being recorded; live and watch also give the queued count (queued), the newest data time received (newest) and the allowed lateness in seconds (lateness) |
| GET | `/api/adapters` | Per adapter: accepted, rejected and reasons, the time of the last record (lastAt / lastClock), latency (time the twin received it − time of the data, average and maximum, seconds), late, outOfOrder, stale (positions too old to use), commands sent (sent); and how many entries are in the outbox |
| POST | `/api/ingest/tms`, `/api/ingest/wms`, `/api/ingest/edi` | Live ingest (see "Live ingest" above) |
| GET | `/api/containers` | Status of the store's containers at the port (only with external data that includes port EDI) |
| GET | `/api/outbox?since=0` | The outbox: entries after number since, each with seq, t, adapter (tms / wms), the twin's command cmd and the translated external instruction out; returns `{ next, list }`; continue with next |

```json
{ "t": 32400, "clock": "09:00",
  "source": { "mode": "feed", "dir": "samples", "files": [{ "name": "tms.jsonl", "adapter": "tms", "accepted": 1025, "rejected": 0 }] },
  "adapters": [{ "name": "tms", "label": "运输管理（TMS）", "accepted": 1025, "rejected": 0, "reasons": {}, "lastAt": 32400, "lastClock": "09:00",
                 "latency": { "avg": 0.4, "max": 60, "unit": "秒（仿真时间：孪生收到的时刻 − 数据的时刻）" }, "late": 0, "outOfOrder": 0, "stale": 0, "sent": 1 }],
  "outbox": 1 }
```

### Current limitations

- Only the synthetic date is understood (the day starting 2030-03-28); dates from real systems have to be converted first, and the twin runs only one day (00:00 to 02:00 the next day).
- Pushed data has no message IDs: resent data is counted twice (except positions, which are not used if older than the one in use, and port container events, which are counted once); senders must avoid resending.
- The twin follows the newest time received: if one system's clock runs fast, other systems' data arrives late; if the data stops, the twin stops. There is only a shared token: no per-user permissions and no HTTPS (put the service behind a reverse proxy).
- In replay and external-data modes there is no ground truth: waits for doors and receiving docks are inferred from door sensors (arrival events are needed for the time on site; vehicles whose plan starts at a door count from their first message; each vehicle is within 1 minute of the simulated field); stock-outs are inferred from stock counts and sales at 5-minute resolution.
- The twin does not estimate port operations per container (container states are only for `/api/containers` and the assistant); the EDI format is a simplified subset defined by this project.
