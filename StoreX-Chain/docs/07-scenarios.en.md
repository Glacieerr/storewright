# Scenario files and share links

[中文](07-scenarios.md)

A **scenario** is a shareable, reproducible moment in the twin: which region, which design generation, which simulation sample, what load and drill, how the facilities were changed, what time of day, where the camera is, which vehicle to follow, and whether to play the guided tour or open an exercise. The same scenario shows the same result on any computer (the simulation is deterministic).

Three ways to use one:

1. **Share link** — the **Share** button in the top bar copies a link to the current state; whoever opens it sees what you see.
2. **Scenario file** (`.json`) — **Share → Export scenario file** downloads one, **Import scenario file** opens one; the scenario library is made of such files (`web/public/scenarios/`).
3. **Command line** — `npm run sim -- scenario file.json [--json]` runs the scenario without a browser and prints the main indicators plus the dispatch board KPIs for the animated day; the teaching sandbox grader (`npm run teach`) reads the same format.

The format is defined in `src/scenario/` (`types.ts` documents every field, `parse.ts` holds the validation rules). The JSON Schema is [`scenario.schema.json`](scenario.schema.json) (add `"$schema": "./scenario.schema.json"` for editor completion).

## Example

```json
{
  "$schema": "../../docs/scenario.schema.json",
  "format": "storex-chain/scenario",
  "version": 1,
  "id": "port-congestion",
  "title": "港口拥堵演练",
  "titleEn": "Port congestion drill",
  "descriptionEn": "How the port and the distribution centre cope when the liner is 6 days late and yard dwell doubles.",
  "gen": "g3",
  "seed": 1,
  "load": "normal",
  "drill": "portCongestion",
  "facilities": { "port": { "gateLanes": 3 }, "dc": { "dryDoors": 14 } },
  "time": "08:30",
  "speed": 60,
  "play": true,
  "camera": { "preset": "port" },
  "follow": "DR-02"
}
```

## Fields

Every field is optional; missing fields use the app defaults.

| Field | Values | Meaning |
|---|---|---|
| `format`, `version` | `"storex-chain/scenario"`, `1` | Optional; must match when present |
| `id` | lower-case letters, digits, hyphens | Library id (same as the file name) |
| `title` / `titleEn`, `description` / `descriptionEn` | text | Chinese and English title and description |
| `region` | `default`, `random-N`, `custom-N~options…` | Same as `?region=` in the URL; a different region reloads the page |
| `gen` | `g1` / `g2` / `g3` | Previous generation / StoreX / StoreX Chain |
| `seed` | 1–9999 | Simulation sample |
| `load` | `normal` / `peak` / `high` / `extreme` | Load level |
| `drill` | `none` / `portCongestion` / `airportClosed` / `highwayClosed` / `supplierOutage` / `demandSurge` | Disruption drill |
| `facilities` | parts of `{ port, airport, dc, store }` | Changes from the default configuration, same ranges as the admin sliders; `down` (equipment under maintenance) replaces the list; `staff` merges per role: `[{ "key": "recv", "crew": { "early": 3 } }]` |
| `time` | `"HH:MM"` or seconds of the day | Start time |
| `speed` | 10 / 60 / 120 / 300 / 600 / 1800 | Playback speed (simulated seconds per second) |
| `play` | true / false | Start playing |
| `camera` | `{ "preset": "overview" \| "port" \| "airport" \| "dc" \| "flagship" }` or `{ "position": [x,y,z], "target": [x,y,z] }` | Camera |
| `follow` | plate / id (e.g. `DR-02`, `M03`) or an operation id | Follow a vehicle |
| `weather` | `auto` / `clear` / `cloudy` / `rain` / `fog` / `storm` | Weather |
| `tab` | `twin` / `report` / `network` / `about` | Tab to open |
| `tour` | `container` | Play the guided tour “one container from ship to shelf” |
| `exercise` | `ex01` … `ex10` | Open a teaching-sandbox exercise |

Unknown fields produce a warning, not an error (later versions may add fields); invalid values are listed one by one and the scenario is not applied.

## How the web app applies a scenario

- **Fields that affect the simulation** (`region`, `gen`, `seed`, `load`, `drill`, `facilities`) fall back to defaults when missing, so the same scenario gives the same result on anyone’s computer; **view fields** (`time`, `speed`, `play`, `camera`, `follow`, `weather`, `tab`) keep the current state when missing.
- When the region or the facilities differ from the current ones, the page reloads with the parameters (it stops and shows a notice after 3 reloads within 15 seconds, to prevent loops).
- Opening someone else’s link uses the link’s facilities and **does not overwrite** the configuration you saved in the admin console; saving facilities in the console while the URL carries scenario parameters reloads with a link that has the new facilities (scheme, time and camera are kept).
- `tour` and `ex` are one-shot: they are removed from the URL after they are applied, so a refresh does not replay the tour or reopen the exercise.
- With scenario parameters in the URL the welcome card and the interface tour do not pop up (`?onboard=1` forces them, `?onboard=0` never shows them).

## Share-link parameters

| Parameter | Field | Example |
|---|---|---|
| `region` | `region` | `region=random-3` |
| `gen`, `seed`, `load`, `drill` | same name | `gen=g3&seed=2&load=peak&drill=portCongestion` |
| `t` | `time` | `t=08:30` |
| `speed`, `play` | same name | `speed=60&play=1` |
| `cam` | `camera` | `cam=port` or `cam=x,y,z,tx,ty,tz` |
| `follow`, `weather`, `tour` | same name | `follow=DR-02&tour=container` |
| `ex` | `exercise` | `ex=ex03` |
| `fac` | `facilities` | base64url-encoded JSON |
| `scenario` | — | A library file id: `scenario=port-congestion`; other parameters in the URL override the file |
| `#report`, `#network`, `#about` | `tab` | Tab |

`lang=en` (UI language) is not part of the scenario and is kept as is when sharing.

## Compatibility

- The format version is `1`. Adding fields keeps the version; changing the meaning of an existing field bumps it and is noted in the CHANGELOG.
- Fields missing from old links fall back to defaults, so links shared earlier keep working.
