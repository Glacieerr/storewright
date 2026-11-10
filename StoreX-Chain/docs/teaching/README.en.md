# Operations teaching sandbox

[中文](README.md)

A teaching pack for courses in **logistics, supply-chain management, industrial engineering and transport**: a regional supply-chain digital twin that runs in the browser (port, airport, logistics park, distribution centre and store, with 3D, a dispatch board and a duty assistant), plus **10 exercises**, **automatic grading** and an **instructor answer key**, in Chinese and English.

> All data is synthetic and for teaching only. It represents no real company's operations and must not be used for real operating decisions. This is a personal portfolio / open-source project and is not affiliated with any retailer or company.

## What is in the pack

| Item | Where |
|---|---|
| 10 exercises (starting scenario, steps, questions, auto-check) | "Exercises" in the top bar; defined in [`src/teach/exercises.ts`](../../src/teach/exercises.ts) |
| Student lab manual | [lab-manual.en.md](lab-manual.en.md) ([中文](lab-manual.md)) |
| Instructor answer key (computed from the simulation) | [instructor/answer-key.en.md](instructor/answer-key.en.md) ([中文](instructor/answer-key.md)) |
| Teaching notes: topics, discussion questions, extensions, common mistakes | [instructor/teaching-notes.en.md](instructor/teaching-notes.en.md) ([中文](instructor/teaching-notes.md)) |
| Grading command line | `npm run teach` (see below) |

## The ten exercises

| ID | Exercise | Level | Time | Topics |
|---|---|---|---|---|
| ex01 | Read a day: the rhythm of the chain and its KPIs | Intro | 15 min | reading KPIs, service level, on-time rate, cost per case |
| ex02 | Port: how long containers sit in the yard, and where demurrage comes from | Core | 20 min | container yard, free time and demurrage, pre-clearance, rail shuttle |
| ex03 | Fleet size and unloading pace: why slower store receiving needs more trucks | Core | 20 min | fleet sizing, vehicle turnaround, Little's law |
| ex04 | DC dock doors: size for the peak | Core | 25 min | dock-door planning, peak vs average utilisation, queueing |
| ex05 | Cold chain: remaining shelf life at the store and fresh waste | Core | 20 min | cold chain, remaining shelf life, cross-docking |
| ex06 | Store receiving: how many docks | Core | 25 min | receiving docks, delivery windows, resource allocation |
| ex07 | Drill: impact of and response to port congestion | Core | 20 min | disruption drill, resilience, safety stock, lead time |
| ex08 | Stress test: from normal to extreme, where is the bottleneck | Advanced | 30 min | stress testing, economies of scale, bottlenecks |
| ex09 | Comparing schemes: previous generation / StoreX / StoreX Chain | Core | 20 min | supply-chain design, information sharing, inventory, cost and emissions |
| ex10 | Root cause with the duty assistant: ask, then verify on the Dispatch board | Advanced | 25 min | root-cause analysis, auditable AI, human in the loop |

About 3.5 hours in total. Suggested plans:

- **Two 90-minute sessions**: first ex01, ex02, ex05, ex09 (reading indicators, comparing schemes); then ex03, ex04, ex06, ex07 (changing set-ups, running a drill). ex08 and ex10 as homework.
- **One 3–4-hour lab**: all ten in groups; each group presents one discussion question at the end.
- **A single lesson**: ex01 + ex04 + ex07 cover "read indicators → change the set-up → run a drill".

## Preparation

**Online demo (no installation)**: <https://glacieerr.github.io/storewright/storex-chain/>. Everything runs in the browser; students only need a computer with an up-to-date Chrome, Edge, Firefox or Safari (a discrete GPU makes the 3D smoother).

**Local** (offline classrooms, or to edit the exercises): install Node.js 22 and, at the repository root:

```bash
npm install
npm run dev -w storex-chain
```

Open <http://localhost:5182>. Switch 中文 / EN at the top right, or add `?lang=en` to the address.

## In class

1. Students click "Exercises" in the top bar → pick one → "Load starting scenario" (scheme, load, drill, facilities and camera are set).
2. They follow the steps, find numbers and change settings in the interface, and enter their answers.
3. "Check answers" gives instant feedback: ticks for right answers, hints (not answers) for wrong ones; they may fix and check again. Progress is kept in the browser.
4. When done, "Export my answers" produces `exNN-answers.json` (their scenario and answers), which they hand in.

Each exercise in the panel also has "Background" notes and ungraded "Discussion" questions for short reports or class discussion.

## Grading

Grading always uses the same rules: the student's scenario is **re-simulated** (the same scenario always gives the same result), number questions are checked within a tolerance, choices by option, and set-up tasks by whether the student's scenario really achieves them. Instructors and students therefore get the same score on any computer.

```bash
# List the exercises, print one
npm run teach -w storex-chain -- list --en
npm run teach -w storex-chain -- show ex04 --en

# Grade one submission (exit code 0 = pass, 1 = not passed, 2 = invalid file)
npm run teach -w storex-chain -- check ex04 --answers ex04-answers.json --en

# Machine-readable result (for a grade sheet)
npm run teach -w storex-chain -- check ex04 --answers ex04-answers.json --json

# Answer key; --write regenerates instructor/answer-key*.md
npm run teach -w storex-chain -- key --en
```

To grade a whole class kept in one folder (macOS / Linux shell):

```bash
for f in answers/*.json; do npm run -s teach -w storex-chain -- check ex04 --answers "$f" --json; done > results.jsonl
```

Each exercise is worth 100 points; 70% passes. You can also rely on the in-browser "Check answers" alone and collect nothing.

## Editing or adding exercises

Exercises live in [`src/teach/exercises.ts`](../../src/teach/exercises.ts): starting scenarios use the [scenario file format](../../src/scenario/types.ts), each question has an `expect(state)` that computes the correct answer from the simulation plus a tolerance, and each set-up task has an `ok(state)`. Background notes and discussion questions are in [`src/teach/background.ts`](../../src/teach/background.ts). After editing:

```bash
npm run teach -w storex-chain -- key --write      # regenerate the answer key
npm run teach -w storex-chain -- manual --write   # regenerate the lab manual
npx vitest run tests/teach.test.ts                # check: the key scores 100, wrong answers lose points
```

## Licence

The teaching documents are released under [CC BY 4.0](../../../LICENSE-docs): copy, adapt and use them in teaching (paid courses included) with attribution. The code is released under the repository's [AGPL-3.0](../../../LICENSE).
