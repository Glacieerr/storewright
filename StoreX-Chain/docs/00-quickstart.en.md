# Five-minute quick start

[中文](00-quickstart.md)

StoreX Chain is a regional digital twin of one large store's whole supply chain: ocean liners, freighters, intercontinental trains and long-haul trucks, through the port, the air cargo terminal, the logistics park and the distribution centre, all the way to the store shelf. The simulation, the 3D twin, the dispatch board and the duty assistant all run in your browser. This is a personal portfolio / open-source project. **It is not affiliated with any retailer or company**; the region, store, products and every number are synthetic.

There is a lot in it, and you don't need all of it on day one. Follow the three steps below and in five minutes you will know what it is, what it can do and where to look next.

## 1. Open it (pick one)

- **Live demo** (nothing to install): <https://glacieerr.github.io/storewright/storex-chain/> (available after the first push and deployment). The hosted demo is a static site without the local twin server; everything else works the same.
- **Run it locally** (needs [Node.js 22](https://nodejs.org/)):

  ```bash
  git clone https://github.com/Glacieerr/storewright.git
  cd storewright && npm ci
  npm run dev -w storex-chain
  ```

  Then open <http://localhost:5182>. The first load generates the region and simulates 18 weeks, so allow 5–10 seconds.

On first open a welcome card on the 3D view offers three paths: the container tour, an exercise, or exploring on your own ("Explore on my own" starts a 30-second guided tour of the interface; the "?" button in the top bar replays it any time). Add `?lang=en` to the address, or press "EN" in the top bar, for the English interface.

## 2. Try these five things first

| Try | How | What you'll see |
|---|---|---|
| 1. One container from ship to shelf | The first button on the welcome card, or open `?tour=container` | A one-minute guided tour: the camera follows one container from berthing and discharge through the yard, a drayage truck and the distribution centre to the store shelf, with numbers computed from the simulation at every step |
| 2. Scenario library | "Scenarios" in the top bar, then click a card | Ten curated scenarios: port congestion drill, airport closure, peak load, extreme load at night, the store's morning receiving rush, half the cold-chain doors, a random region, a custom region… one click switches to it |
| 3. Share link | "Share" → "Copy link" in the top bar | The link carries the region, scheme, day, load, drill, facility changes, time and camera, so whoever opens it sees what you see; you can also export / import scenario files (format: [Scenario files and share links](07-scenarios.en.md)) |
| 4. Drill | Choose "Port congestion" under "Drill" and press "Run" | How the port and the gate queue, which jobs on the dispatch board are hit, and how KPI alerts escalate |
| 5. Duty assistant | Further down the page, ask the duty assistant "现在哪些车晚了" (which trucks are late), "港口那边怎么样" (how is the port), or "要是高速封两个钟头会怎样" (what if the highway closes for two hours) | Answers come as conclusion / evidence / confidence / next step, every number traceable to the data; proposals that change the plan are only submitted for your confirmation, never executed on their own. The built-in assistant understands and answers in Chinese; the optional large-model mode can answer in English ([large-model mode](06-llm-option.en.md)) |

## 3. Where to go next, by who you are

| You are | Start here | Then |
|---|---|---|
| A **student or teacher** of logistics, supply chain or industrial engineering | "Exercises" in the top bar: the 10 exercises of the [teaching sandbox](teaching/README.en.md), graded automatically | The student lab manual, the instructor answer key and classroom notes in [docs/teaching](teaching/README.en.md) |
| A **developer** (digital twins, simulation, games, logistics software) | Two small libraries you can use on their own: the [yard engine](../../packages/yard/README.en.md) (queue lanes, driver-side reversing, articulated trailer motion, one schedule) and the [vehicle overlap audit](../../packages/overlap-audit/README.en.md) | The [extension guide](05-extending.md) and the [system design](04-system-design.md) (Chinese), the [scenario file format](07-scenarios.en.md) |
| A **practitioner** in stores, warehousing, ports, forwarding or dispatch | The dispatch board (change departures, swap doors and trucks, let the solver plan) and the drills | The duty assistant, the layered KPI board, the [business analysis](03-business-analysis.md) (Chinese) |
| A **researcher** in operations research, simulation or AI | The [comparison reports](results/README.md) (deterministic seeds, reproducible) | The [Duty-Desk Bench](benchmark.en.md) (four blind test sets and how to reproduce them), [validation](08-validation.en.md) (against theory and exact solutions), the [planning report](01-planning-report.md) (Chinese) |

## The interface at a glance

| Area | What it is for |
|---|---|
| Controls at the top | Scheme (previous generation / StoreX / full chain), region (default / random / custom), load, drill and day; press "Run" after changing them |
| 3D view | Drag to rotate, scroll to zoom, click a vehicle to see its route; the row below holds camera presets and layers (place names, land-use plan, vehicle tags, monitors, split replay, weather, quality) |
| Timeline | Play, pause or drag to any moment; the whole page follows this clock |
| Duty assistant, KPI board, closed loop, dispatch board | Scroll down: ask questions and approve; four KPI layers with alerts; field → sensing → twin → recommendation → command; the whole day's jobs |
| Top bar | "Share", "Scenarios", "Exercises", "?", the tabs (comparison and reports, network planning, about) and 中文 / English |

## FAQ

- **Why is the first load slow?** The browser generates the region, simulates 18 weeks and plans a day of port and logistics-park operations, which usually takes 5–10 seconds. On slow networks, everything outside the main program (reports, network planning, the about page, the facility admin, the duty assistant's language model) is downloaded only when you use it.
- **Is the data real?** No. The region, store, products, sailing schedule and every number are synthetic; equipment and freight rates sit in common ranges from public sources. Use it for demonstration, teaching and research, not for real operational decisions.
- **Can I hide the welcome card?** Tick "Don't show again", or add `?onboard=0` to the address.
- **Can I use my own data or facilities?** Change facilities in the facility admin and write settings in a scenario file ([Scenario files and share links](07-scenarios.en.md)); to connect your own systems see the [extension guide](05-extending.md).
