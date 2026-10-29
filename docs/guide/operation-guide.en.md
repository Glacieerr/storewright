# Storewright operation guide

> This guide is organized around "how do I…": how each role works on the associate phone, how the shift lead handles AI recommendations, reassignments and schedules, and how to use the demo console and the 3D twin. On-screen labels are quoted in "…" exactly as the English interface shows them. The Chinese version is the main one and this English version follows it: [operation-guide.zh-CN.md](operation-guide.zh-CN.md).
>
> **This project is not affiliated with any retailer or company.** All stores, products, customers, associate names and numbers are synthetic.
>
> Based on the current code and design documents (2026-10-26). Every workflow in more detail, with scan and tap counts, is in [16 · Operation flows (Chinese)](../16-operation-flows.md).

## Contents

1. [Before you start](#1-before-you-start): [1.1 What the system is](#11-what-the-system-is) · [1.2 Three ways to run it](#12-three-ways-to-run-it) · [1.3 Walk through the showcase first](#13-walk-through-the-showcase-first) · [1.4 How to read this guide](#14-how-to-read-this-guide)
2. [Sign-in and roles](#2-sign-in-and-roles): [2.1 Pick an identity](#21-pick-an-identity) · [2.2 Phone layout](#22-phone-layout) · [2.3 What each role sees](#23-what-each-role-sees) · [2.4 Store settings](#24-store-settings)
3. [Floor roles on the associate phone](#3-floor-roles-on-the-associate-phone): [3.1 Picking](#31-picking) · [3.2 Staging](#32-staging) · [3.3 Handoff](#33-handoff) · [3.4 Delivery trips and drivers](#34-delivery-trips-and-drivers) · [3.5 Replenishment](#35-replenishment) · [3.6 Shelf checks and lot tasks](#36-shelf-checks-and-lot-tasks) · [3.7 Backroom fetch](#37-backroom-fetch) · [3.8 Receiving](#38-receiving) · [3.9 Put-away and QA](#39-put-away-and-qa) · [3.10 Cycle counts](#310-cycle-counts) · [3.11 Made-to-order deli](#311-made-to-order-deli) · [3.12 Returns](#312-returns) · [3.13 Oversized items](#313-oversized-items) · [3.14 Parcel hub](#314-parcel-hub) · [3.15 Next up](#315-next-up) · [3.16 Reminders](#316-reminders) · [3.17 On-duty team](#317-on-duty-team) · [3.18 Equipment alerts](#318-equipment-alerts) · [3.19 Incident checklists](#319-incident-checklists)
4. [Shift lead](#4-shift-lead): [4.1 AI recommendations](#41-ai-recommendations) · [4.2 Slot capacity and stopping orders](#42-slot-capacity-and-stopping-orders) · [4.3 Reassigning on-duty associates](#43-reassigning-on-duty-associates) · [4.4 Schedules and shift cover](#44-schedules-and-shift-cover) · [4.5 Incidents](#45-incidents) · [4.6 Recalls](#46-recalls) · [4.7 Food safety log](#47-food-safety-log) · [4.8 Repair requests](#48-repair-requests) · [4.9 Modes and models](#49-modes-and-models) · [4.10 Ask and store notes](#410-ask-and-store-notes)
5. [Demo console](#5-demo-console): [5.1 Create test orders](#51-create-test-orders) · [5.2 Stand in for customers and drivers](#52-stand-in-for-customers-and-drivers) · [5.3 Equipment and alerts](#53-equipment-and-alerts) · [5.4 Backroom, replenishment and parcels](#54-backroom-replenishment-and-parcels) · [5.5 Auto operations](#55-auto-operations) · [5.6 Everything else](#56-everything-else)
6. [3D twin and simulator](#6-3d-twin-and-simulator): [6.1 Run a day in the planning twin](#61-run-a-day-in-the-planning-twin) · [6.2 Live data and what-ifs](#62-live-data-and-what-ifs) · [6.3 Policy comparison](#63-policy-comparison) · [6.4 Scenarios and reports](#64-scenarios-and-reports) · [6.5 Customize the store](#65-customize-the-store) · [6.6 AI recommendations](#66-ai-recommendations) · [6.7 Tour and cinematic](#67-tour-and-cinematic) · [6.8 Live twin](#68-live-twin) · [6.9 Replay and forecast](#69-replay-and-forecast) · [6.10 Equipment and alerts in the twin](#610-equipment-and-alerts-in-the-twin) · [6.11 Your Store](#611-your-store)
7. [FAQ](#7-faq)
8. [Glossary](#8-glossary)
9. [Further reading](#9-further-reading)

---

## 1. Before you start

### 1.1 What the system is

Storewright is a store digital twin and operations system for grocery stores. Online orders go through picking, staging and handoff on associate phones, and backroom receiving, shelf replenishment, staffing and the store AI live in the same system. The 3D twin stays in sync with the floor and can replay any moment of the day or forecast the next three hours; the whole system can also run inside a browser with no backend.

### 1.2 Three ways to run it

All of them need Node.js 20 or later. Run `npm install` once in the project folder first.

| Way | Commands (in order) | Open | Good for |
|---|---|---|---|
| In-browser demo | `npm run build:site`, then `npm run demo:site` | http://127.0.0.1:4177/ | A first look. The store hub runs in the browser and the data stays in this browser |
| Planning twin (simulator) | `npm run dev` | http://localhost:5173 | The 3D store and the full-day simulation on their own; connected to a backend it becomes the live twin |
| Real backend | `npm run build:associate`, then `npm run server` | http://localhost:8787 | Several real phones working together. Phones on the same Wi-Fi as the computer open `http://<computer's LAN IP>:8787` |

In-browser demo:
- http://127.0.0.1:4177/ redirects to the showcase (`/app/showcase.html`). `/app/` is the associate app and `/sim/` is the simulator.
- Add `?store=hardware` to the address for the home-improvement store, or `?lang=en` for the English interface.
- Tabs opened from the same site share one store and stay in sync. The data stays in this browser only; operations data is cleared after 12 hours without activity.

Real backend:
- No separate database to install.
- `STORES=demo,hardware,large npm run server` runs the supermarket, the home-improvement store and a 300-person large store together; at sign-in, enter `demo`, `hardware` or `large` under "Store".
- The phone camera can scan only over HTTPS or localhost. To use phone cameras, start with `HTTPS=1 npm run server`, open `https://<computer's LAN IP>:8787` on the phone, and the first time follow the browser's prompt to continue (the certificate is generated on your computer). Bluetooth or USB scanners and typing work without HTTPS.
- To connect the simulator to this backend, see [6.8 Live twin](#68-live-twin).

### 1.3 Walk through the showcase first

The showcase puts the whole system on one page. The left column switches between "Console", "Digital twin", "Full-day simulation" and "Stacked", and "Open in a new tab ↗" opens the current view on its own. On the right are two associate phones; the selector above each phone switches between "Picker · Avery", "Stager · Riley", "Handoff · Morgan", "Shift lead · Taylor" and "Backroom · Drew". On narrow screens, use "Console", "Phone 1", "Phone 2" and "Digital twin" at the top.

"Walk through it (about 3 minutes)" at the top has 7 steps that tick themselves off from the store's live state:

1. **Order created**: in the console, tap "Create" to place one pickup order (by default it is locked and pick walks are created right away).
2. **Pick**: on phone 1 (the picker), claim the walk, tap the totes to bind their labels, tap "Picked N" on each line, then "Finish picking, go to staging".
3. **Stage**: switch phone 1 to "Stager · Riley", tap each tote and put it in a suggested slot.
4. **Arrived**: in the console, tap "On my way" and "Arrived" for this order; the handoff board changes color, and in the left column's "Digital twin" you can see the customer's car.
5. **Handoff**: on phone 2 (the handoff associate), open the order, start preparing, pull each tote, enter the code shown in the console and complete the handoff.
6. **AI**: switch one phone to "Shift lead · Taylor", open the "AI" tab and handle one recommendation.
7. **Twin**: in the console's "Equipment and alerts", tap "Staging cooler fault". The temperature rises and turns red in the twin, the alert reaches Taylor's phone, and Taylor taps "Acknowledge, I’ll handle it". Then drag the timeline under the twin: left to replay, right to see the forecast for the next 3 hours.

"Switch to the home-improvement store" changes the store; "Reset demo store" clears orders and activity and keeps the AI models.

### 1.4 How to read this guide

- "Scan" means a scanner, the phone camera, or typing. Every scan box has ⌨ ("Type manually") and ◎ ("Scan with camera") on the right. The camera stays open after reading a code so you can keep scanning; tap "Done" to close it.
- When the store has not turned on "Require scanning" (demos, training), any scan step can be replaced by tapping that row in the list. Once it is on, taps are refused; see [2.4 Store settings](#24-store-settings).
- When an action is refused, the phone shows why, for example "Avery has already claimed this walk". Actions taken while offline wait on the phone, the top bar shows "N queued", and they are sent in order once the connection is back.
- N and HH:MM in this guide stand for the numbers and times on screen.

## 2. Sign-in and roles

### 2.1 Pick an identity

The demo build has no passwords on purpose; the identity only records who did what.

1. Open the associate app: http://localhost:8787 with the real backend, `/app/` in the in-browser demo.
2. Under "Store", enter the store ID: `demo` is the supermarket, `hardware` is the home-improvement store.
3. Under "Who are you?", tap a name. With more than 24 people there is a search box and a role filter; type a staff ID and press Enter to sign in directly.
4. For the demo console, tap "Demo console (order platform / customers / drivers)" at the bottom.

- The roster shows the backroom role as "Backroom receiving"; this guide calls it backroom.
- Switching people: "More → Me → Sign out", or "Sign out" in the top bar. In the showcase, use the selector above each phone. The showcase lists only 5 people; for other identities (restock, deli), open `/app/` in a new tab and sign in there. It shares the same demo store as the showcase.
- Language: "EN" / "中文" at the top right of the sign-in page, or "More → Language".
- Common identities in the demo store (`demo`): Avery (pick), Riley (stage), Morgan and Quinn (handoff; Quinn can check ages), Robin (restock), Drew (backroom, permanently authorized for backroom fetches), Jamie (deli; the home-improvement store has no deli, so this person is in the backroom there), Taylor (shift lead, permanently authorized for backroom fetches).

### 2.2 Phone layout

- **Bottom tab bar**: "Pick", "Stage", "Handoff", "Inventory", "Modules" (only when the store has modules turned on), "AI" (shift lead only), "More". Badges: ● on "Pick" means you have a walk; "Stage" counts totes waiting to be staged; "Handoff" counts customers who have arrived and whom nobody is preparing yet; "Inventory" counts unclaimed restock, backroom and shelf-check tasks; "AI" counts open recommendations.
- **Top bar**: your name and store, the connection state ("Online", "Connecting", "Offline"), 👥 on duty (with the number of people on duty), 🔔 reminders, "Sign out".
- **Banners at the top of the page**: equipment alerts, incident checklists, "Next up" (when you have nothing in hand).
- **"More"**: "Me" ("Sign out"), "My shifts", "On-the-job tips", "Store settings" (shift lead), "Ask the assistant" (everyone else), "Language", "Connection", and "Print staging slot labels" under "Labels". "On-the-job tips" is on by default for your first two weeks: the first time you meet a situation (your first cold-chain walk, your first wrong pickup code, staging nearly full, and so on) it shows the key steps.

### 2.3 What each role sees

| Role | Opens on | Main work | In this guide |
|---|---|---|---|
| Pick | Pick | Claim walks, pick line by line | [3.1](#31-picking) |
| Stage | Stage | Put totes in slots, move totes to recovery | [3.2](#32-staging) |
| Handoff | Handoff | Customer handoffs, delivery handovers | [3.3](#33-handoff), [3.4](#34-delivery-trips-and-drivers) |
| Restock | Inventory → Restock | Restock batches, shelf checks, lot tasks | [3.5](#35-replenishment), [3.6](#36-shelf-checks-and-lot-tasks) |
| Backroom | Inventory → Receive | Receiving, put-away, counts, backroom fetches | [3.7](#37-backroom-fetch) to [3.10](#310-cycle-counts) |
| Deli | Modules → Made to order | Made-to-order tickets | [3.11](#311-made-to-order-deli) |
| Shift lead | Handoff, plus the "AI" tab | AI recommendations, reassignments, schedules, field response, store settings | [Section 4](#4-shift-lead) |

- The opening tab follows your **current role**: a temporary move > today's scheduled role > the role on the roster. When you are moved to another role, the phone switches tabs and tells you; if you have a task in hand, it waits.
- Anyone can open any tab, and most tasks can be done by anyone; a picker can help with staging, for example. The exceptions: only the shift lead has the "AI" tab; only permanently authorized people can claim backroom fetches; only the shift lead and the console can reassign people or change store settings.
- "Inventory" and "Modules" remember the sub-tab you last opened. The first time, "Modules" opens by role: deli on "Made to order", backroom on "Parcels", handoff on "Returns", stage on "Oversized".

### 2.4 Store settings

The shift lead changes them under "More → Store settings"; the console has a "Store settings" card on its page. Changes apply on every device right away.

- **"Require scanning"** (off by default): picks must scan the item barcode, and totes, slots, shelf locations, bins, recovery areas, hot-hold slots, oversized areas and parcel slots must all be scanned. Tap buttons are greyed out or hidden, and tapped actions are refused with "This store requires scanning: scan the label or barcode instead of tapping". The server checks the scanned barcodes and locations. Turn it off for demos and training.
- **"When handoff prep can start"**:
  - "Before the customer arrives (ambient first, chilled and frozen last); at the counter the code can be checked first" (default);
  - "Only once the customer has arrived (cold totes stay in staging until then)".

The reasons behind these settings are in [decision 0026 (Chinese)](../decisions/0026-flow-fixes.md).

## 3. Floor roles on the associate phone

### 3.1 Picking

After orders are locked (120 minutes before the pickup slot starts), the system creates pick walks at intervals; in the demo, every minute. Each tote's label is already assigned.

1. On the "Pick" tab, choose a card under "Walks to claim (N)". The card shows the temperature zone, "Priority", "Due HH:MM", totes, locations, units, estimated minutes and distance, plus AI out-of-stock hints and the cold-chain limit. Tap "Claim this walk". One person can hold one walk at a time, and once claimed it disappears from everyone else's list.
2. Label the totes. Under "Labels: x / n totes scanned", scan each tote in "Scan the tote label"; or start picking straight away and scan a tote the first time you put something in it (when the store does not require scanning, it binds automatically). "Print labels for this walk" opens this walk's labels in a new tab.
3. Pick line by line, in order. The card shows the aisle, bay and level, the item name, "×N", "Into tote i/n · Order XXXX", and marks such as "21+" and "No substitutes". Scan the item in "Scan item barcode"; a wrong item shows "Wrong item — look for …".
   - If only one unit is left, it is recorded at once; with several left, "N still needed. How many are going into the tote now?" pops up: type the number and tap "Confirm".
   - Without scanning, tap "Picked N" to record the rest of the line. This button is not there when the store requires scanning.
4. When every line is handled, "This cart is done" appears. Tap "Finish picking, go to staging"; the phone moves to the Stage tab and the totes appear in everyone's waiting-to-stage list.

Common actions while picking:

| Situation | What to do |
|---|---|
| You want to pick something else first | "Skip this line, pick it last" (remembered on this phone only) |
| You cannot find it on the shelf | Tap "Not found", choose what the shelf looks like ("Empty shelf", "Not at its location", "Damaged", "Wrong price tag", "Other"), then one way to handle it: "Use AI's first choice: …"; "Show substitutes" and tap one (the list shows the location and how likely the customer is to accept it); "Backroom has N cases: send to backroom pick"; or "Mark out of stock" |
| You only found part of the quantity | Enter the actual number in the quantity box, then handle the rest with "Not found" |
| The tote is full | "Tote i/n full? Add a tote": the unpicked lines of that tote move to a new tote; then tap "Print labels for this walk" to label it |
| AI asks you to count on the way | The "Count on the way" card: enter how many are on the shelf and tap "Submit N", or tap "Skip" |
| Break or end of shift | "Hand the rest to someone else (break, end of shift)" → "Hand over": unpicked lines go into a new priority walk and you take the picked totes to staging |
| The cold-chain limit is close or already passed | Tap "Hand over the rest and stage now" in the banner; totes with nothing picked are flagged so you can take them off |
| You haven't picked anything yet and want to stop | "Release this walk": the totes are unbound and the next person scans them again |
| Recalled item | The card shows a red banner "Recalled item: don't pick; handle as "can't find" (substitute or short)", and "Picked N" cannot be tapped |
| An order in the walk is cancelled | You are told right away. Items already picked stay in the tote and go to recovery at staging |

- **Cold-chain timer**: starts when the first chilled or frozen item goes into a tote and runs until the tote is placed in staging. The top of the Pick tab shows the time left, and the Stage list shows it too.
- Items marked **no substitutes** can only be marked out of stock or sent to backroom pick.
- **Voice commands**: tap "Voice command" and type, or use your phone keyboard's dictation to say "next", "can't find", "quantity 3" or "note: …", then tap "Run". Anything else goes to the store assistant. The store's local speech recognition is not connected yet.

### 3.2 Staging

1. Open the "Stage" tab. Occupancy for each temperature zone is at the top. "Waiting to stage (N)" lists picked totes, with the time left for cold-chain totes; totes pulled during a handoff prep that must go back are tagged "Put back".
2. Scan the tote in "Scan tote label"; when the store does not require scanning you can also tap a row. A tote that is not fully picked, or that is in a handoff prep, is flagged right away.
3. The card shows the customer, the order code, "Tote i/n · Pickup" or "Delivery", and the slot it is in now. Below are up to 4 suggested slots: slots already used by the same order first, then the emptiest; for customers arriving within half an hour the suggestions are close to the handoff point, and for customers more than an hour and a half away they are farther back.
4. Scan the slot label, or tap a suggested slot; you see "Placed in {slot}".
5. When all of the order's totes are placed, the order shows "Not started" on the handoff board, and delivery orders can be grouped into trips.

- Pickup orders can only go in pickup-area slots and delivery orders only in delivery-area slots. A wrong temperature zone, a full slot, or a slot whose cold unit is under repair is refused with the reason.
- To change slots, scan the tote and then the new slot. Picked the wrong tote? Tap "Choose another tote".

**Recovery area**: totes from cancelled orders go to the recovery area for their temperature zone.
- When you scan such a tote you see "Order cancelled: put this tote in the {zone} recovery area". "Move to recovery (N)" also lists the totes to move (those in slots, and those already pulled during a handoff prep).
- When the store does not require scanning, scanning the tote or tapping its row records it. When scanning is required, put the tote there and then scan the recovery-area label (one per temperature zone, printed from "More → Print staging slot labels").

### 3.3 Handoff

**Handoff board**: the "Handoff" tab has "Scan any tote, or enter the order code" at the top and "Handoff board (N)" below. Row colors:

| Color | Status | Meaning |
|---|---|---|
| Grey | "Not arrived" | Not here yet. Shows the pickup slot, or how many minutes away once the customer has given an ETA |
| Yellow | "Arriving" | Arriving within 5 minutes, "Arrives in N min"; when AI has corrected the time it also shows "AI-corrected · customer said N min" |
| Blue | "Arrived" | The customer has checked in; shows the wait and the bay |
| Red | "Long wait" | Waiting 8 minutes or more |

- Arrived customers come first, first come first served. With more than 10 orders, those not arriving soon are folded under "Orders not arrived yet (N)".
- The right side of each row shows progress: "Picking / staging x/n", "Not started", "Preparing (who)", "Ready to load", "Handing off".
- When a customer checks in, on-duty handoff associates who are not in a handoff get an arrival reminder.

**Handing off one pickup order**:

1. **Open the order and start preparing**: scan any tote of the order. When the whole order is staged and the store allows prep now, this one scan opens the order, starts the prep and records that tote. You can also enter the 4-character order code, or tap a row on the board and then "Start preparing". The order is locked to you; others who open it see "{who} is preparing this order" and can tap "Join to help".
2. **Read the early warnings**: the top of the page lists 21+ items and the people who can check ages, recalled items, items with a backroom fetch in progress, which hot-hold slot the deli item is in, which area the oversized pieces are in, and any cold-chain alert.
3. **Customer walked up to the counter**: if the customer did not check in on their phone, tap "Customer is here (staff check-in)". The wait is counted from then.
4. **Verify the pickup code**: under "Verify code", enter the customer's code (4 to 8 characters) and tap "Verify". With the customer at the counter you can verify first and pull the totes afterwards. A wrong code shows "Wrong code (N wrong so far); ask the customer to check it again"; there is no limit and it never locks. After 3 wrong tries, "Verified manually" appears as well.
5. **Pull each tote**: "Pull from staging (k / n)" lists each tote and slot in the order ambient, chilled, frozen, hot. Scan in "Scan each tote"; when the store does not require scanning you can also tap a row. If a label is missing, tap "Label missing? Reprint".
6. **Deli and oversized**: in the "Made to order" section tap "Take out", or "Customer doesn't want it" if the customer no longer wants it. After handing over the oversized pieces, tick "Oversized pieces taken out and handed over".
7. **Hand over**: once every tote is pulled and the code is verified, the "Handoff" section appears.
   - 21+ items: you see "Age-restricted items (21+): check ID"; after checking, tap "ID checked". If you cannot check, tick "Cannot verify: remove age-restricted items" and the page lists which items to take out and which tote they are in. Substitutes that are 21+ need the check too.
   - Recalled items: take them out of the listed totes and tick "Recalled items taken out of the tote".
   - Read the shortages and substitutions to the customer. For substitutes you can record "Happy" or "Not happy".
   - Tap "Complete handoff"; you see "Handoff complete" and return to the board.

- **Cannot start**: an order that is not fully staged shows "The order is not fully staged yet. Tell the customer the expected wait and why."; if the store only allows prep after arrival and the customer is not here, you see "Store setting: prep starts once the customer arrives."; delivery orders are prepared with their trip (see [3.4](#34-delivery-trips-and-drivers)).
- **Leave the prep**: if you scanned the wrong order or the customer never comes, tap "Put back and end prep" → "End prep". Pulled totes go back to their slots. When the store requires scanning they are not marked as returned automatically; scan each tote and slot on the Stage tab (they are tagged "Put back" in the list).
- **Order cancelled**: only the console can cancel. If it is cancelled during prep, the page lists the totes already pulled; put each in the recovery area for its zone and tap it.
- **Backroom fetch in progress**: you can wait for the fetch to arrive, or hand over now. Anything not delivered by the time you complete counts as short.

### 3.4 Delivery trips and drivers

**Where trips come from**: at intervals the system groups staged delivery orders into trips, up to 4 orders per trip and within the vehicle capacity (12 totes and 300 kg by default). With fewer than 4 orders it waits a little, for example when there is still time before the trip must leave, or other orders for the same slot are still being picked. The board shows "Trip TRxxx (n orders)".

**Drivers**: in the demo the console stands in for them; tap "Driver accepts" (this creates the driver's code), "ETA in 15 min" and "Driver arrives" in turn; see [5.2](#52-stand-in-for-customers-and-drivers).

**Handover** (handoff associate):
1. You can start only when every order on the trip is staged. Scan any tote of the trip on the board, or tap the trip's row and then "Start preparing".
2. If the driver did not report arrival in the app, tap "Driver is here (staff check-in)".
3. Enter the driver's code and tap "Verify". One code hands over the whole trip. If the driver has no code ("The driver has no code"), check ID and order details and tap "Verified manually".
4. Pull each tote.
5. Choose a vehicle position for each order: "Front passenger", "Rear left", "Rear right", "Trunk".
6. Tap "Complete handoff"; every order on the trip and the trip itself are completed.

**Driver cancellation and re-dispatch**:
- "Driver cancels" (console): allowed more than 10 minutes before the expected arrival, or after the driver has waited 10 minutes at the store; refused at other times.
- "Driver no-show: re-dispatch": on both the console and the shift lead's phone (on the trip), appearing 10 minutes after the expected arrival or 60 minutes after acceptance.
- After a cancellation or re-dispatch: the trip goes back to waiting for a driver and the prep ends; pulled totes go back to their slots or to a free slot in the same zone (when scanning is required, scan each tote and slot on the Stage tab); customers get a delay notice; if the slot is nearly over, the shift lead and the person who started the prep get "Trip … may miss its delivery window after redispatch: assign someone to follow up".

### 3.5 Replenishment

**Where tasks come from**: a shelf estimate below its threshold or likely to run out, a picker reporting an item out of stock or choosing a substitute, an AI restock before picking, or a manual request. No task is created if the item already has one or the backroom has no usable case. Tasks in the same aisle are batched, up to 8 per batch and only as much as one cart can carry (about 150 kg and 600 L by default; the store can change this). Anyone can restock, whatever their role.

1. Open "Inventory → Restock". Under "Restock batches (N)" each batch has a card with "Aisle N", "About X kg · Y L (cart limit …)" and the reason for each item, such as "Shelf empty", "Running low", "Before picking" or "May run out". A restock before picking shows "A picker arrives about HH:MM; restock before then". Tap "Claim this batch".
2. Fetch the cases in the backroom. "Case list: x / n picked" is sorted by bin. Scan the cases in "Scan the case or the shelf location label"; each case is recorded against the item it belongs to. When the store does not require scanning, tapping a row takes the suggested case.
3. With all cases in hand, go to the shelves. Scan the shelf location label (when scanning is not required you can tap "No location label? Confirm you are at the location (demo)"). The card shows "Units to shelve (shelf about x / y, room for z; n in the case)"; type the number and tap "Finish stocking".
4. If something is left in a case, the top of the page says "Put case … back in bin … (N units left)"; put it back and tap "Put back".

- A bin has no case: tap "Not in {bin}" on that row; the system counts only that bin.
- Don't want one task: "Back to queue"; don't want the batch: "Return the whole batch".
- Scanned cases and confirmed locations are remembered on this phone, so you can switch tabs and come back.

### 3.6 Shelf checks and lot tasks

**Shelf checks**: when AI thinks the system shows stock that may not be on the shelf, it sends a task straight to restockers (the shelf availability module is set to "Auto" by default). When a picker reports an item missing and AI thinks it is probably misplaced, the task asks you to look nearby.

1. At the top of "Inventory → Restock", under "Shelf checks (N)", tap "Check it".
2. Go to the location and scan its label. When scanning is not required you can confirm manually.
3. A task labelled "AI: may be misplaced" asks "Where did you find it?": "At its home location", "Found nearby, put back", "Not nearby either".
4. Enter how many are actually on the shelf (including any hidden behind or beside), and tap "Submit count". A count of 0 makes the system arrange a restock.

- A picker's "Count on the way" also closes the shelf check for that item.
- When you hold a restock batch, shelf checks are listed below it.

**Lot tasks** are in the same list. Tap "Go", scan the location, enter how many you actually did, and tap "Done, submit N units".

| Task | Where it comes from |
|---|---|
| "Markdown labels" | The shift lead accepted a markdown recommendation for a short-dated lot (which lot, what discount, about how many) |
| "Pull for donation" | The shift lead accepted a donation recommendation |
| "Pull expired" | A lot has expired; once done it is recorded as pulled and not flagged again |
| "Return to shelf" | A return was set to "Restock"; shelf stock goes up only after it is put back |
| "Count after recall pull" | Only some lots were recalled and the shelf has no lot records; count what is left on the shelf (this one uses "Check it" and "Submit count") |

### 3.7 Backroom fetch

Created when a picker taps "Backroom has N cases: send to backroom pick" under "Not found". Only permanently authorized people can do it (in the demo store, the shift lead and backroom staff, such as Taylor and Drew); others who open it see "Permanent authorization required". Authorized people on duty (except shift leads) get "Backroom pull waiting".

1. Under "Inventory → Backroom", in "Backroom picks (N)", tap "Claim".
2. "Cases of this item in the backroom" lists bins and cases. Scan the case in "Scan the case label (= found)"; when scanning is not required you can tap a case.
3. "After taking N, this item in this bin is:" tap "Some left" or "Empty". If the case holds more than needed, "I'll shelve the remaining N units on this trip (assign the restock task to me)" is ticked by default, so nobody has to make another trip.
4. Take it to staging: following "Take it to staging slot X, into tote i/n", scan the slot label (or "No slot label? Confirm manually (demo)"). The order line changes from short to picked.

- If the tote is not in staging yet you are told to deliver later; when the tote is placed in staging you get "The order's tote is in staging slot …: you can deliver the fetched item now".
- Not enough in the case: the page says "The case only had N: bring those; the rest counts as short."
- Not in the backroom either: tap "Not in {bin} either" (or "Not in the backroom either"). The system counts only the bin you checked, and cases in other bins stay usable.
- The order was already handed over or cancelled: the page asks you to put the units back on the shelf; tap "Back on the shelf" when done.
- Want to stop: tap "Back to queue".

### 3.8 Receiving

1. When a supplier's advance shipping notice (ASN) arrives (in the demo, sent from the console), a row appears under "Inventory → Receive" in "Receipts (N)": "In transit · N cases · due HH:MM"; late trucks show "N min late", and a dock queue shows "dock: unloading from HH:MM, N min wait". Open the row.
2. When the truck arrives, just scan cases. The first scanned case records the truck as arrived; you do not have to tap "Truck is here (also recorded when you scan the first case)".
3. Scan the case's barcode in "Scan the case's original barcode, or the QR code on the delivery note". The card has "Cases to receive" (you can type it), "Damaged (goes to QA)", "Lot (optional)" and the expiry date; when the case barcode carries the lot and expiry, scanning it fills them in. Tap "Receive N cases", then "Print the N case labels just received". Case labels carry the lot and expiry.
4. If the delivery note has a QR code, you can scan it (in the demo, tap "Demo: read this truck's delivery note"). The "Delivery note check" table appears with "Item", "Expected", "Delivery note", "Lot / expiry", "Received" and "Damaged"; items missing from the ASN are listed too. "Received" defaults to the delivery note quantity; change it to what you actually counted, enter damaged cases separately, and tap "Receive from delivery note".
5. When done, tap "Close receipt", look at the summary of short, over and damaged cases, and tap "Close it". Once closed, nothing more can be received on it, and the differences are recorded.

- "Print case labels for this receipt" prints every case label of the receipt.
- If some items on the delivery note were already received, you cannot receive from the note again; scan the remaining cases one by one.
- A badly written expiry date is refused with the correct format (year-month-day).

### 3.9 Put-away and QA

1. Open "Inventory → Put away", scan a case in "Scan a case label", or tap a row under "To put away / in QA (N)".
2. Under the card are "Suggested bins" (up to 3). Scan the bin label; when scanning is not required you can tap a suggested bin.
3. Pallet put-away: tick "Pallet put-away: scan this pallet's cases, then one bin", scan the cases of the pallet, then scan one bin to put them all away. If the bin runs out of room it stops, and the rest go to another bin.

Cases in QA (marked damaged at receiving) have three buttons:
- "Passed: sellable": then choose a bin and scan its label ("Back to sellable: pick a bin and scan its label"). Items under recall cannot go back to sellable.
- "Return to vendor".
- "Scrap".

A wrong temperature zone, chemicals next to food, the wrong stock status, or a full bin is refused.

### 3.10 Cycle counts

Count tasks come from the schedule (A items weekly, B monthly, C quarterly), from "not found" during a backroom fetch or restock (only the bin that was checked), and from AI risk-based suggestions ("Auto" by default).

1. Under "Inventory → Count", in "Count tasks (N)", tap "Claim".
2. Go to the bin and scan its label ("Go to bin X and scan its label to start"). When scanning is not required you can tap "No bin label? Confirm you're at the bin (demo)".
3. Enter the number of cases for each item. This is a blind count; system quantities are hidden. If you find an item that is not in the records, scan it in "Scan items that aren't in the records (optional)" to add a row.
4. Tap "Submit count". Missing cases are recorded as lost and extra ones are created as new cases.

- Want to stop: tap "Back to queue".
- "Inventory → Areas" shows each area's occupancy against its alert line; areas over the line are marked red.

### 3.11 Made-to-order deli

Only when the store has the deli module on. Tickets come from the order platform; in the demo, tick "Add a made-to-order deli item to each order" when creating orders in the console. Suggested start = slot start − prep time − 10 minutes; tickets that AI adjusted for the dish and how busy the kitchen is are marked "AI adjusted".

1. Under "Modules → Made to order", in "Queued (N)", each card shows "Start at HH:MM" ("Should have started HH:MM — late" when late). Tap "Start cooking".
2. When it is ready, under "Cooking (N)", choose a free hot-hold slot and tap "Done, place in X". When the store requires scanning, tap "Scan a hot-hold slot" and scan the slot's label. Each hot-hold slot holds one item.
3. "Holding (N)" shows "Discard in N min"; the system discards items that hold too long. The handoff associate takes the item out during handoff prep (there is also "Pull (for handoff prep)" here).

Spoiled, or the customer doesn't want it: tap "Discard", whether it is queued, cooking or holding.

### 3.12 Returns

1. Under "Modules → Returns", in "New return", choose "Customer return" or "Delivery return", pick an order under "Original order" or choose "No order (no-receipt return)", and tap "Start return".
2. For each item, first choose its condition ("Sealed", "Opened", "Damaged") and the quantity, then scan it in "Scan returned item". After the scan the condition goes back to "Sealed". In the demo you can expand "Order items (demo: tap instead of scanning)" and tap instead.
3. Choose a disposition for each item: "Restock", "Scrap", "Hazmat disposal", "Return to vendor". Buttons the rules forbid cannot be tapped and say why. AI's suggested disposition is highlighted, with the chance of resale and the reasons.
4. Scanned the wrong thing: tap "Wrong scan — remove this line".
5. When every item has a disposition, tap "Complete return". Refunds are handled by an external system.

Hard rules for returns:
- Chilled, frozen and hot items can never go back on the shelf.
- Food, household and personal-care items go back only if sealed; damaged items never go back.
- Chemicals can never go in the regular trash; opened or damaged chemicals can only go to hazmat disposal.
- You cannot return more than the order handed over.
- "Restock" does not add to shelf stock right away: the system gives restockers a "Return to shelf" task, and stock goes up once it is put back.

### 3.13 Oversized items

When orders are locked, items too heavy or too large for a tote become oversized tasks, one per piece. Pieces that need two people are marked "Two-person lift". A piece can be placed only after its label is printed.

1. Under "Modules → Oversized", each order has a card with "Load plan: N trips". Tap "Claim trip 1 (N pcs)".
2. Under "My oversized pieces (N)", scan the item barcode (when scanning is not required you can tap "Tap to scan").
3. Tap "Print label i/n" and stick it on.
4. Tap "Place in X", or scan the oversized area's label once it is in place. When scanning is required, only scanning works.

- Want to stop: tap "Release".
- When someone is moving a two-person piece, the system asks a free colleague to help.
- Handoff prep lists which area the order's oversized pieces are in.

### 3.14 Parcel hub

1. The carrier's advance notice arrives first (in the demo, tap "Parcel notice (8 parcels / 2 trips)" in the console).
2. Under "Modules → Parcels", scan each parcel in "Scan parcel code to induct".
3. A code that is not on any notice prompts you to check it and scan again. If it really is an extra parcel, tap "Register as extra (to the review area)"; if it was a wrong scan, tap "Wrong scan".
4. After induction, scan a slot label to put it away, or tap a suggested slot ("Place in X"). Tap "Report damaged" for a damaged parcel.
5. Under "Extra and damaged (N)", choose "Return to carrier" or "Hold in exceptions" for each.
6. When the driver comes, tap "Hand to driver (N)" on the trip's card under "By trip (N)". You cannot hand over while the trip still has parcels that are not in a slot.

Parcels still not inducted 30 minutes after their expected arrival are marked short by the system.

### 3.15 Next up

When you have nothing in hand and the most useful task is on another tab, a "Next up" card appears at the top of the page. Shift leads do not see it.
- The card says what it is ("Pick walks", "Stage", "Handoff", "Restock", "Backroom", "Shelf check", "Count"), when it is due, and why it was chosen, such as "Customer waiting", "Due soon", "Your role", "Nearby" or "About to run out".
- Tap "Claim and start" (pick walks, restock batches, counts and backroom fetches are claimed and opened at once) or "Go" (opens that handoff or shelf check).
- "Something else" shows the next suggestion and "Hide" hides the card for now. It is only a suggestion; doing something else is fine.

### 3.16 Reminders

🔔 in the top bar shows the number of unread reminders; new ones pop up once, and urgent ones are red. Tap it for the list:
- "Go": marks it read and opens exactly that item: the recommendation, the task, the order or trip, the alert banner, or "My shifts".
- "Got it": only marks it read.

Common reminders: "Customer here: order …", "Backroom pull waiting", "Shelf check: aisle N", "Restock before picking: aisle N, a picker is on the way", "Equipment alert: …", "Cold-chain limit exceeded: take chilled / frozen totes back to staging now", "Shift offer: …", "AI suggests: …" (shift lead).

Sending rules: urgent ones go out at once; each person gets at most 3 non-urgent reminders an hour (arrival reminders don't count); nothing non-urgent while you are in a handoff or at night; reminders about the same aisle, device or module are merged; they close by themselves once the matter is handled.

### 3.17 On-duty team

Tap 👥 in the top bar to open "On duty"; every device can see it. Close it with Esc, by tapping outside, or with "Close".
- People are grouped by current role. Each group shows how many people it has and the work waiting in that role: "N walks to claim", "N totes to stage", "N customers waiting", "N restock tasks", "N backroom fetches". Roles with work waiting and nobody on them are marked red.
- Each person shows what they are doing: "Picking · …", "Handing off · …", "Fetching from backroom", "Restocking", "Counting", or "Idle" with no task. Temporary moves show "Temporary · back to … at HH:MM", queued moves show "Then to …", and pinned people show "Pinned". Your own row is marked "You".
- People who are off duty are folded under "Off duty (N)"; open it to see when they start, "Shift over" or "On leave".
- Ordinary associates can only look; the panel says "Shift leads make reassignments." How shift leads move people is in [4.3](#43-reassigning-on-duty-associates).
- When you are moved, your phone says "You were moved to …; back to your usual role at HH:MM"; for a queued move it says "Your lead has you moving to … once you finish what you're on".

### 3.18 Equipment alerts

The alert banner at the top of the phone reads "Equipment alert · {device} · {kind}", where the kind is "Temperature too high", "Temperature too low", "Dock door left open" or "Sensor offline". Who sees it:
- the shift lead sees all of them;
- backroom and restock see the walk-in cooler, walk-in freezer and dock doors;
- deli sees the hot holding cabinet;
- stage and handoff see a staging cooler or freezer only when it holds totes.

Open the banner to see the reading, when it started, the impact (which orders and totes, how many backroom cases, which free slots in the same zone) and what to do. The shift lead and the roles responsible for that device can tap "Acknowledge, I’ll handle it". If a critical alert goes unacknowledged for 5 minutes, the console gets a reminder. Once the readings recover, the alert clears by itself.

When a handoff associate opens an affected order, a cold-chain alert note says to check the product temperature before handoff and call the shift lead if needed.

### 3.19 Incident checklists

When the shift lead starts an incident (power outage, fire alarm, system outage, severe storm), a red banner appears at the top of every phone: "Incident: … · Started HH:MM, N min ago" with "Checklist (x / n)".
- Each person sees the steps for their own role and for everyone, and ticks them off when done. A ticked step cannot be unticked.
- Associates see the list expanded by default; shift leads see it collapsed and tap the title to expand it (the full list is under "AI → Field").

## 4. Shift lead

The shift lead's phone has an extra "AI" tab with "Recommendations", "Schedule", "Field", "Ask", "Modes & stats" and "Models". The console switches to "AI" at the top and sees the same content.

### 4.1 AI recommendations

The top of "AI → Recommendations" has the brief ("Opening brief", "Midday brief" or "Evening brief", switched with "Morning", "Midday" and "Evening"), the "Closing review", the "Weekly report" and the "Order outlook"; open recommendations follow. They are **sorted by urgency**: ones marked urgent, ones that would run an action, and equipment and operations warnings come first, and among equally urgent ones the soonest due comes first. Each card shows the prediction and range, the confidence, "Main reasons", other options or other models' predictions, and the model and mode.

To handle a recommendation:

1. Start from the top one and read the reasons and the expected effect.
2. If you agree, tap "Accept".
3. If the action affects people, money or customers (moving someone, shift offers and early-leave offers, telling customers they will be late, markdowns, donations, stopping orders), a second box appears: "Confirm: …" with "This affects people, money or customers and cannot be undone". Check what will happen and tap "Confirm", or "Cancel" to back out.
4. If you disagree, tap "Override", choose a reason ("Data is wrong", "I know something the system does not", "Not enough staff", "Customer request", "Disagree", "Other"), optionally add a "Note (optional)", and tap "Submit".
5. To set it aside, tap "Dismiss".

- Show-only recommendations have "Useful", "Not accurate" and "Dismiss". "Useful" only records feedback and does not run the action; to run it, set the module to "Confirm" under "Modes & stats". Show-only recommendations do not send reminders either (except urgent ones).
- Recommendations whose action can no longer be done (the person has already been moved, the order has already been handed over) are closed by the system automatically. Until then the card shows "Outdated" and "Things have changed; this suggestion can no longer be done", with only "Hide".
- "Recently handled" is at the bottom of the page.
- Shift-offer recommendations have extra options; see [4.4](#44-schedules-and-shift-cover).

### 4.2 Slot capacity and stopping orders

Below the recommendations is a compact "Slot capacity" table: for the next few pickup slots, how many orders are "Booked", how many the store "Can do (picking / handoff)", and how many are "Left". When a slot is nearly full:
1. Tap "Stop orders" on that slot's row.
2. Tap "Confirm: stop new orders for HH:MM". Orders already taken are still fulfilled.
3. To undo, tap "Reopen".

"AI → Models" has the full slot capacity table and "Simulate: order cap vs late orders".

### 4.3 Reassigning on-duty associates

1. Tap 👥 in the top bar to open "On duty".
2. Tap "Reassign" on the person's row.
3. Choose "For how long": "30 min", "1 hour" (default), "2 hours" or "No end time".
4. If the person has a task in hand, choose "After this task" (default, the move is queued) or "Move now (they still finish their task)".
5. Tap "Move to …", for example "Move to Handoff". People can move to pick, stage, handoff, restock, backroom and deli; roles they are trained for are marked ✓. People on a temporary move also have "Back to …" (their usual role).
6. You see "Moved … to …; back to … at HH:MM". When the time is up, the system moves them back automatically.

- A queued move takes effect once the person finishes their task; their row shows "Then to …", and you can tap "Cancel queued move".
- "Pinned" puts the person on the pinned list, and AI never suggests moving them; "Unpin" removes them.
- Moving someone without backroom-fetch authorization to the backroom shows that they can do receiving, put-away and counts only.
- Shift leads themselves cannot be moved. When you accept an AI suggestion to move someone who has a task in hand, that move is queued too.
- Background and rules: [decision 0025 (Chinese)](../decisions/0025-team-view-dispatch.md).

### 4.4 Schedules and shift cover

**Draft schedule** ("AI → Schedule"):
1. Choose "This week (from …)" or "Next week (from …)".
2. Tap "Let AI draft this week’s schedule". Review the total hours, "Short", "Over", "Rule violations", "Weekend shift spread", each day's coverage chart and "Gaps that cannot be filled".
3. Tap a cell in the table to change that person's shift for that day: change "Start", "End" and "Role" and tap "Save", or tap "Remove this shift"; in an empty cell you can "Add this shift". After every change, the shortfall, overstaffing, hours and rule checks are recalculated for the edited schedule. Problems your edits create are written in plain words, such as "Sam: shift on Tue is too short", and gaps they open are marked "opened up by your edits".
4. Tap "Publish this schedule". If one is already published, the button reads "Replace the published schedule with this draft".

Until a schedule is published, the system uses the roster to decide who is on duty.

**Absences and shift cover**:
1. Under "Report an absence", choose the associate and "Today" or "Tomorrow", then tap "Report an absence".
2. AI suggests who can cover under Recommendations. Accepting it (two steps) sends a shift offer. "If declined, ask the next person automatically (no need to accept again)" is ticked on the card by default: if someone declines, the next offer goes out without another accept.
3. To choose someone else, tap "Send to … instead" to send the offer to another candidate directly.
4. The invited person taps "Accept" or "Can’t make it" under "More → My shifts".

"My shifts" also shows your own shifts this week, and offers such as "You can leave early: … (voluntary)".

### 4.5 Incidents

1. Under "AI → Field", in "Incidents", tap "Start: Power outage", "Start: Fire alarm", "Start: System outage" or "Start: Severe storm".
2. "Start "…"? A checklist appears on everyone's phone right away." appears; tap "Confirm start".
3. The card shows the impact (chilled and frozen totes in staging, cold cases in the backroom, orders due in the next two hours) and the full checklist. Each person ticks off their own role's steps at the top of their phone.
4. When there is a draft customer notice, you can tap "Copy" (fire alarms have none).
5. When it is over, tap "End and build timeline". The last incident can be expanded to see its timeline.

### 4.6 Recalls

1. Under "AI → Field", in "Recalls", paste a public recall notice into "Recall notice text" and tap "Read". In the demo you can tap "Demo: generate a recall notice".
2. Check the extracted product, barcodes, lots, dates and reason, and tick the matching items. Items with a matching barcode, or whose name matches word for word, are ticked by default; when in doubt, select more.
3. Tap "Confirm N items and start the recall". Backroom cases move to QA hold at once, and online picking can no longer pick these items.
4. Work through the five steps and tick them: "Pull from shelves", "Move backroom cases to QA hold", "Remove from staged totes and carts", "Substitute or short open orders", "Notify customers who already picked up". Steps already done at the start, or with nothing to do, are ticked automatically and say "done at start or nothing to do".
   - "Totes to pull (N)" lists the order, whether the tote is in a slot or on a cart, and which items.
   - "Draft customer notices (send after review)" can be copied one by one.
5. When all five steps are done, tap "All done: close the recall".

When only some lots are recalled: once "Pull from shelves" is ticked, the other lots left on the shelf can be picked as usual; for items with no lot records on the shelf, the system sends restockers a "Count after recall pull" task. At handoff, only recalled items picked into totes before the shelf pull are blocked.

### 4.7 Food safety log

"Food safety log" is at the bottom of "AI → Field". Choose a date to see each temperature-controlled unit's minimum, average and maximum temperature, minutes outside its limits, and that day's alerts and repair tickets. After reviewing, you can add a "Note (optional)" and tap "Confirm this day's log". The readings come from the digital twin's telemetry and only the most recent period is kept.

### 4.8 Repair requests

1. In the alert banner at the top of the phone, tap "Acknowledge, I’ll handle it".
2. If it needs repair, tap "Request repair". The staging slots that unit serves stop taking new totes, and placing one there is refused.
3. When it is fixed, under "Repair tickets", choose the "Actual fault" ("Compressor", "Door seal", "Sensor", "Defrost", "Other", "No problem found") and tap "Fixed, close the ticket".

While the alert is active, "Repair tickets" are inside the alert banner. After the alert clears (or when AI opened a ticket without an alert), the top of the phone shows "Repair tickets (N)"; open it to close the ticket. The console's "Equipment and alerts" can close it too.

### 4.9 Modes and models

- **"Modes & stats"**: each AI module can be set to "Show only", "Confirm" or "Auto", with how many recommendations it issued, its adoption rate and the override reasons. The console can "Lock" a module so that only the console can change it. Actions that affect people, money or customers still need a person to confirm even in "Auto", and modules that keep missing drop to show-only by themselves. Shelf checks and counts are "Auto" by default and only send tasks to restockers and the backroom. Reminder statistics are at the top of this page.
- **"Models"**: each model's current version, training data and backtest metrics. You can "Forecast now", "Retrain", "Test the release check with a weaker model" and "Roll back the order forecast model".

### 4.10 Ask and store notes

Shift leads use "AI → Ask"; everyone else uses "More → Ask the assistant → Open the local assistant and store notes".
- Ask about the store, items, staff, procedures, or "what if…" in the box and tap "Ask". Answers cite their data sources and can be marked "Useful" or "Not helpful".
- Under "Store notes" you can write down how things really work on the floor (for example, that an item actually sits on an end cap) and tap "Save this note". The assistant uses these notes when answering.

## 5. Demo console

The demo console stands in for the order platform, customers and drivers. Enter it from the sign-in page with "Demo console (order platform / customers / drivers)"; the showcase's "Console" in the left column is the same thing. At the top you can switch between "Demo console" and "AI", and a row of numbers shows orders, pick walks, staged, waiting and completed. The console page also has the "Store settings" card (see [2.4](#24-store-settings)).

### 5.1 Create test orders

1. Under "Create test orders", choose the "Type" (pickup or delivery), the "Count" and the "Max lines per order".
2. "Lock now and create pick walks" is ticked by default. When the store has the modules, you can also tick "Add a made-to-order deli item to each order" and "Add an oversized item to each order (2 pieces)".
3. Tap "Create". The pickup slot is now plus 40 minutes. Rejected orders are skipped and the rest are still created, with "Created N orders; M rejected: reason".
4. Each order's pickup code is in the "Code" column of the order table. It plays the role of the code on the customer's phone and is stored only in this browser.

### 5.2 Stand in for customers and drivers

Buttons on each row of **"Active orders (N)"**: "Lock" (orders not yet locked); "On my way" (the customer reports arriving in 4 minutes) and "Arrived" (the customer checks in, with a bay), both for pickup orders only; "Cancel" (no confirmation). Above the table are "Create pick walks" and "Run scheduler"; when there are auto-operations orders you can tick "Show auto-operations orders (N)".

For each trip under **"Delivery trips (N)"**, tap "Driver accepts" (creates the driver's code, shown as "Driver code XXXX"), "ETA in 15 min" and "Driver arrives" in turn. "Driver cancels" can be tapped only within the allowed window, and the text beside it says how long to wait or why it cannot be cancelled. "Driver no-show: re-dispatch" appears when the driver is late enough.

### 5.3 Equipment and alerts

The "Equipment and alerts" card shows twin health, each device's reading and status, and open alerts (with "Acknowledge, I’ll handle it" and "Request repair").

Cause a fault to watch the alert travel to the phones and the twin:

| Button | What the reading does | Result (demo store) |
|---|---|---|
| "Staging cooler fault", "Staging freezer fault", "Walk-in cooler fault" | The temperature keeps rising | Reaches the critical line in about 1 minute; alerts at once |
| "Dock door left open" | The door stays open | Reminder after 2 minutes |
| "Sensor disconnected" | No more readings | Alert after 2 minutes |
| "Staging cooler slowly loses cooling", "Walk-in cooler door seal leaks", "Staging freezer reading gets stuck" | The unit slowly gets worse | See whether AI suggests a repair before the limit is crossed |

After "Repair all", the readings drift back to their set points and the alerts clear by themselves. Under "Repair tickets" below, choose the actual fault and close the ticket.

### 5.4 Backroom, replenishment and parcels

**"Backroom & replenishment"**:
- "Send delivery notice (ASN)": sends a notice for fast-selling items the backroom is out of, due in 30 minutes. "Supplier reports 25 min delay" changes the latest receipt that has not arrived yet.
- Choose a speed (30×, 120×, 600×) and tap "Start shopper simulation": the store starts selling, shelf stock goes down, and locations with sensors report readings.
- "Auto-restock: a virtual restocker works restock tasks by priority (shelf checks still need an associate)".
- Under "Empty the shelf for this item", choose an item, optionally tick "System does not know (misplaced / shrink) — wait for a picker or sensor to find out", and tap "Empty the shelf".
- "Print backroom bin labels"; the table below lists the items where real stock and the system estimate differ most.

**"Parcel hub"**: "Parcel notice (8 parcels / 2 trips)" sends a batch of parcel notices; once parcels are staged, each trip has "Driver handoff".

### 5.5 Auto operations

"Auto operations (dual track)" has virtual customers place orders, virtual associates pick, stage and hand off, and virtual drivers take delivery trips.
1. Choose "Orders per hour" (20, 40, 80, 160) and "Work pace" (normal, 2×, 4×).
2. Tap "Start auto operations". The card shows what each virtual associate is doing and how many orders are done.
3. Tap "Stop auto operations" to end it.

Auto-operations orders are kept in separate walks and trips from yours and do not appear on associate phones; both tracks share the same staging area, shelves and store AI.

### 5.6 Everything else

- "Area management": occupancy and alerts for each area.
- "Live events": every action on the associate app appears here as it happens.
- The "Store" card: "Print staging slot labels", and "Clear store (demo)" (asks first, then clears all orders and events).

## 6. 3D twin and simulator

The simulator can be used in two ways. Without a store connection it is the **planning twin**: a discrete-event simulation of a whole day, used to try layout, staffing and policy changes before making them. Connected to a store it is the **live twin**, and the scene follows the work on the floor. Design details: [07 · Simulator (Chinese)](../07-simulator.md) and [14 · Digital twin (Chinese)](../14-digital-twin.md).

### 6.1 Run a day in the planning twin

When you open the simulator (http://localhost:5173, or `/sim/` on the demo site), it first simulates a whole day for the current store and policy ("Running the first simulation…"). After that, every change is recalculated in the background without interrupting the picture.

**Top bar**:
- "Store": "Small store (one floor)", "Medium store (one floor)", "Large store (two floors)", "Home improvement store". "Policy": "Baseline (no dedicated system)", "Default profile (service and safety first)", "Efficiency-first profile".
- "AI" toggle (on by default): staffing from the order forecast (same total hours), corrected arrival times, ranked substitutions.
- Views "2.5D", "3D", "Top"; stores with several floors let you pick a floor; building views "Interior", "Cutaway", "Exterior".
- "Overlay": "Temperature zone", "Pick heat", "Shelf stock", "Area occupancy", "None". "Quality": "High", "Medium", "Low".
- "Tour", "Cinematic", "中文" / "EN", "Edit layout". At phone width these are all under "Settings".

**Bottom timeline**: tap ▶ to play (or press Space); speeds 1×, 10×, 60×, 300×, 900× (`[` and `]` also change it); drag the slider to any time. The timeline runs until the next morning's opening so you can watch the night restock.

**Camera and inspection**: the wheel zooms toward the cursor, WASD or the arrow keys pan, Q / E rotate, R / F tilt; 1 / 2 / 3 switch views, B switches the building view, G follows the selected associate or vehicle, M shows the minimap, H resets, and ? opens the shortcut list. Click an associate, aisle or vehicle in the scene for a floating card; right-click for common actions.

### 6.2 Live data and what-ifs

The "Live data" tab:
- Metric cards for the current moment (for example average wait, "Not ready on time", "Fill rate", "Overweight totes", "Dwell at door", "Pick rate") and full-day curves ("Handoff progress (cumulative orders)", "Cars waiting", "Average customer wait (min)", "Staging occupancy", "Role utilization (busy / on shift)", "Cumulative units picked") that draw up to the current playback time.
- "Staffing · this hour (HH:00)": tap − or ＋ for each role to change the head count; it applies from the current hour, and the day is recalculated in the background in about 0.1 s.
- "What-if": "Order surge +30%", "One picker calls in sick", "Reset to default"; you can also choose "Weather", "Season", "Weekday" and "Road congestion".
- "Incidents": turn random small incidents and random major incidents on or off, or choose a major incident and tap "Trigger now".
- Toggles for the "Shelf stock model", the "Night restock crew" and "Student part-timers".

To move one associate, click them and choose a role under "Reassign (from this hour)" on the card, or right-click and choose "Reassign to … (from this hour)".

### 6.3 Policy comparison

The "Policy comparison" tab runs each of the three policies in the background with the same store, the same order stream and the same staffing. The table lists the differences (good and bad in color) and overlaid curves follow. Tap "Switch to …" to play that policy in the scene. This is a single run; for statistical significance see the 30-replication experiment in [06 · Phase 1 results (Chinese)](../06-phase1-results.md).

### 6.4 Scenarios and reports

1. Under "Scenarios & reports", enter a "Scenario name" and tap "Save as scenario". A scenario keeps every current setting, the day's results and a thumbnail of the scene, stored in this browser.
2. Under "Saved scenarios (N)", "Set as A" and "Set as B" compare two scenarios side by side; "Load" applies a scenario's settings to the simulator; "Delete" removes it.
3. "Multi-day simulation": choose 7, 14 or 30 days; each day gets a fresh set of orders, and you see the mean, P10, median and P90.
4. The P&L is a rough daily net with adjustable unit costs. Its total leaves out in-store sales and is usually negative; compare scenarios by their difference.
5. "Export HTML report" or "Export Markdown"; "Download the current view (PNG)".

### 6.5 Customize the store

1. Tap "Edit layout" in the top bar or open the "Customize store" tab. The simulation keeps running.
2. "⬚ Select": click an aisle to select it, Shift- or ⌘-click to select several, and drag to move them together. "＋ Draw aisle" (N) draws an aisle by dragging on the floor. There are also "Rotate 90°" (T), "Copy", "Paste", "Duplicate beside", "Distribute evenly", "Select all on floor" and "Delete".
3. Every change is validated first and applied about 0.4 s after it passes; problems are listed, and the last valid layout is kept.
4. "↶ Undo" and "↷ Redo" (⌘Z / ⇧⌘Z, up to 50 steps). "Done" keeps the current layout; "Discard all changes" returns to the layout before editing.

The same tab also has the "Store generator" (preset sizes, item-by-item settings, or "🎲 Random store", then "Generate and apply"), "Surroundings", "Backroom and staging", "Hours and parking", "Facilities", "Truck yard", "Areas and dock doors", "Pickup bays", and "Export JSON" / "Import JSON". While editing, colored handles in the scene drag the customer entrance, the handoff door, elevators and escalators, and the staging area.

### 6.6 AI recommendations

The simulator's "AI recommendations" tab looks for problems in the current scenario's simulated day (deliveries and the truck yard, backroom and restocking, online-order staging, the front end, exceptions and risks), checks a few other days to see whether they recur, and tries each actionable fix on the scenario first.
- Each suggestion says what to do, why, the "Expected effect" and the "Confidence".
- "Adopt" applies the change to the scenario and re-simulates, and can be undone with "Undo"; "Dismiss" asks for a reason; "Locate" jumps to the relevant time and place.
- Above them are today's plan, the shift handoff summary and "Build AI schedule"; "Adopt vs. not adopt" runs the same day with and without the adopted changes.
- After changing the scenario, tap "Analyse again".

### 6.7 Tour and cinematic

- "Tour": a 12-step introduction; each step moves the camera and highlights the matching part of the interface. "Back", "Next", "Finish"; Esc leaves. The first time you open the simulator, "First time here?" appears at the top left with "Start the tour", "Cinematic tour" and "No thanks".
- "Cinematic": switches to 3D at 30× speed and cycles the camera through the store overview, the pickup bays, a picker, the staging area, the backroom, the street corner and an overhead shot, about 10 seconds each. Good for recording a demo video. Esc or a click on the scene leaves.

### 6.8 Live twin

1. Start the backend with `npm run server` first (see [1.2](#12-three-ways-to-run-it)).
2. In the simulator's "Digital twin" tab, enter `http://localhost:8787` (or the LAN address; with HTTPS, enter the https address and open it once in the same browser to accept the certificate) under "Backend URL", and tap "Connect".
3. Tick "Show only live data in the scene (hide simulated associates, shoppers and vehicles)". Associates appear where they last scanned, totes in staging slots come from the live state, customers' cars park in the pickup bays they checked in at, and device cards show readings.
4. The panel shows orders today, customers waiting, average wait, pick walks, staging occupancy, the handoff board, shelves and replenishment, who is on duty, AI recommendations (handled on the associate app's AI page) and live events. Tap "Disconnect" to end the connection.

- The digital twin in the showcase connects to the in-browser store automatically. It has no data panel; tap "Twin panel" at the top right of the scene for the same content.
- Positions in the scene are matched by location and slot codes, so the layout must match the backend's (the demo backend uses the medium store template).

### 6.9 Replay and forecast

Once connected, the bottom of the scene shows the twin timeline: the past on the left, now in the middle, the next 3 hours on the right. Times when alerts happened are marked in red on the track.
- **Replay**: drag left, or tap "◀ Replay". The scene goes back to that moment (associates, staged totes, customers' cars, dock doors, temperatures), and the top shows "Replay HH:MM" with that moment's orders, waiting customers and equipment alerts.
- **Live**: tap "Live" or "Back to live". Dragging back to near the present also returns to live.
- **Forecast**: drag right, or tap "Forecast ▶". The top shows "Forecast HH:MM (+N min)" with the expected waiting customers, orders ready for handoff, picking backlog and orders that will miss their window.
- **Try a plan**: in the "Forecast" section of the "Digital twin" panel, "Try a plan" offers "+1 picker", "+1 handoff associate", "Move a handoff associate to picking" and "One picker fewer", compared side by side with the current plan, along with the orders that may miss their pickup window. The panel says whether it uses speeds "measured today" or the "default".

The forecast answers "with today's staff and order volume, what happens over the next few hours". Long-term questions such as layout, policy and staffing belong to the planning twin's full-day simulation.

### 6.10 Equipment and alerts in the twin

- "Twin health: how closely the twin matches the store": starts at 100 and loses points for sync, data sources, sensors and record accuracy.
- "Equipment and sensors": each device's reading and status; click a row to point the camera at that device.
- "Equipment alert": open alerts with their impact. In the scene, the alarmed device gets a red ring at its base and its area flashes red.

Try it: tap "Staging cooler fault" in the console. About a minute later the device card in the twin turns red and the alert, with its impact, reaches the shift lead's phone; the shift lead taps "Acknowledge, I’ll handle it"; tap "Repair all" in the console, and once the readings recover the alert clears by itself.

### 6.11 Your Store

Build a twin of your own store from an empty lot, then simulate and run it like the template stores. Stores are saved in this browser, as many as you like.

1. Press "Your Store" in the top bar (or add `?yours` to the simulator address) to open the project page, then press "New store".
2. Enter a name, pick the industry (Supermarket or Home improvement), drag the building width and depth (the ground-floor area shows below), pick the floors and staging size, set dock doors, online pickup bays and opening hours, tick facilities (Auto service, Garden center, Pharmacy) and press "Generate and start building". The closest number of aisles and shelf sections for that footprint is found, a working store is generated and the editor opens.
3. The project bar under the top bar lets you rename the store; "Build steps" jump to the matching part of the editor (Sales floor, Backroom & receiving areas, Staging, Facilities, Parking & hours, Site surroundings); changes save automatically.
4. "Pre-opening check" lists problems to fix first and suggestions: missing areas, cooler and freezer, whether staging slots and pickup bays are enough at peak (estimated from orders a day), dock doors and a refrigerated door, backroom pallet positions and opening hours.
5. "Done building: run a full day" simulates a whole day in this store; the data tabs, policy comparison and scenarios & reports all work.
6. "Live sandbox" opens the showcase in a new tab: the in-browser hub builds this store, and the console, two phones and the digital twin connect to it, so you can create, pick and hand off orders.
7. "My stores" goes back to the project page. Each store card has "Build", "Full-day simulation", "Live sandbox", "Export" (downloads a `.storewright.json` file), "Copy" and "Delete" (then "Confirm delete"); "Import a store file" brings an exported file back, for example on another computer or browser.

- Stores are kept only in this browser, and clearing site data deletes them; export the ones you want to keep.
- Stores you build are synthetic demo data too: simulation results compare options and are not an operating plan.

## 7. FAQ

**I tapped a button and got "This store requires scanning: scan the label or barcode instead of tapping".**
The store has "Require scanning" turned on. Scan labels and barcodes with a scanner, the camera, or by typing. For demos and training, ask the shift lead to turn it off under "More → Store settings".

**The pick card has no "Picked N" button, or it is greyed out.**
When the store requires scanning, the button is not there and you scan the item barcode. If it is greyed out and the card has a red banner, the item is under recall; handle it with "Not found".

**I can't find the walk, order or task I'm looking for.**
- Auto-operations orders, walks and trips are handled by virtual associates and do not appear on associate phones.
- Walks and tasks claimed by someone else disappear from the list; while you hold a walk you cannot claim another ("You still have a walk in progress (…)").
- Backroom fetches are only for permanently authorized people (others see "Permanent authorization required"); only the shift lead has the "AI" tab; the "Modules" tab appears only when the store has modules on, and the home-improvement store has no deli.
- "Next up" appears only when you have nothing in hand and the most useful task is on another tab, and shift leads do not see it.

**I can't start a handoff prep.**
Read the message: the order is not fully staged yet; the store only allows prep after arrival and the customer isn't here; delivery orders are prepared with their trip once it is formed ("Delivery orders are prepared together once their trip is formed"); or someone else is preparing it, in which case tap "Join to help".

**Verifying the code says the customer hasn't arrived.**
Verification needs a check-in first. When the customer walks up to the counter, tap "Customer is here (staff check-in)" ("Driver is here (staff check-in)" for trips).

**Will the pickup code lock after several wrong tries?**
No. You can keep retrying; after 3 wrong tries "Verified manually" appears as well. Check ID and order details, then tap it.

**I made a mistake. How do I undo it?**

| Situation | What to do |
|---|---|
| Claimed a walk but haven't picked anything | "Release this walk" |
| Started picking and can't finish | "Hand the rest to someone else (break, end of shift)" |
| Want to pick other lines first | "Skip this line, pick it last" |
| Put a tote in the wrong slot | Scan the tote and the right slot again; that moves it |
| Started the wrong handoff prep | "Put back and end prep" → "End prep" |
| Don't want a restock, backroom fetch, count or oversized task | "Back to queue", "Return the whole batch" or "Release" |
| Wrong scan in a return | "Wrong scan — remove this line" |
| Moved the wrong person | "Back to …" or "Cancel queued move" |
| Wrong edit in a draft schedule | Before publishing, edit freely; after publishing, make a new draft and tap "Replace the published schedule with this draft" |
| AI recommendations | Actions that affect people, money or customers cannot be undone, which is why there is an extra "Confirm" step; tap "Cancel" there |

What cannot be undone: a ticked incident checklist step; a closed receipt; an order cancelled in the console (no confirmation is asked).

**I was moved to another role but my phone didn't switch.**
You still have a task in hand. The move is queued and the phone says "Your lead has you moving to … once you finish what you're on"; finish your task first.

**Why didn't I get a reminder?**
Each person gets at most 3 non-urgent reminders an hour (arrival reminders don't count), nothing non-urgent during a handoff or at night, and similar reminders are merged. Urgent ones go out at once. Show-only recommendations send no reminders (except urgent ones).

**I tapped "Useful" on an AI recommendation and nothing happened.**
That module is "Show only", and "Useful" only records feedback. To run the action, change it to "Confirm" under "Modes & stats".

**The recommendation card says "Outdated".**
Things have changed (the person was already moved, the order was already handed over), so the action can no longer be done. Tap "Hide", or wait for the system to close it.

**The tote won't go in this slot.**
Read the message: the temperature zone is wrong; the slot is full; a pickup order went to the delivery area (or the other way round); or the slot's cold unit is under repair, so use another slot in the same zone.

**Where do I close a repair ticket after the alert has cleared?**
The shift lead's phone shows "Repair tickets (N)" at the top; open it, choose the actual fault and tap "Fixed, close the ticket". The console's "Equipment and alerts" can close it too.

**The phone camera won't open.**
The camera needs HTTPS or localhost. Over a plain http LAN address it cannot open; use a scanner or type the code, or start the backend with `HTTPS=1 npm run server`.

**Where did the demo data go? How do I start over?**
In the in-browser demo, data stays only in this browser, and operations data is cleared after 12 hours without activity. "Reset demo store" in the showcase or "Clear store (demo)" in the console clears it by hand.

**Two tabs don't stay in sync.**
Some browsers do not support SharedWorker (older phone browsers, some in-app browsers), so each page uses its own store and the page says so. To see several devices in sync, use the showcase, which has the console, the phones and the simulator on one page.

## 8. Glossary

| Term (on screen) | Meaning |
|---|---|
| Walk (pick walk) | One picking task: one cart picks several totes for several orders at once |
| Tote | The pickup container for an order's items, separated by temperature zone; the QR code on its label identifies it |
| Slot | A place for totes in staging, with a slot label and a temperature zone; slots are split into a pickup area and a delivery area |
| Location | Where an item sits on the shelf: aisle, bay, level |
| Bin | A place for cases in the backroom, with a bin label |
| Case | A case of product in the backroom; it gets a case label at receiving |
| Lock | The order can no longer change and is split into totes for pick walks; by default 120 minutes before the pickup slot starts |
| Slot (pickup slot) | The time window the customer chose for pickup or delivery; 60 minutes by default |
| Order code | The order's 4-character short code; entering it at handoff opens the order |
| Code | The pickup code from the customer or the driver's code, verified before handoff |
| Cold-chain timer | The limit for chilled and frozen items, from the first item into a tote until the tote is staged |
| Stage | Putting picked totes in slots to wait for the customer or driver |
| Recovery | The area for totes from cancelled orders, one per temperature zone |
| Handoff prep | The process from starting to completing a handoff; locked to whoever started it, and others can join to help |
| Handoff board | The list of orders and trips on the Handoff tab, colored by arrival status |
| Staff check-in | The handoff associate checks in a customer or driver who did not check in on their phone |
| Verified manually | After 3 wrong pickup codes, checking ID and order details instead of the code |
| Trip | Several delivery orders grouped for one driver |
| Vehicle position | Where each order goes in the vehicle at a delivery handover |
| Backroom fetch | Taking stock from the backroom to an order's tote when the shelf is empty; needs permanent authorization |
| Restock | Taking cases from the backroom to the shelves; tasks in one aisle that fit one cart form a batch |
| Shelf check | Counting what is actually at a location to correct the system estimate |
| Count on the way | A picker checks an item while passing by |
| Lot tasks | Shelf tasks for a specific lot: markdown labels, pull for donation, pull expired, return to shelf |
| Count (cycle count) | Counting the cases in one backroom bin; a blind count with system quantities hidden |
| ASN (advance shipping notice) | The supplier's list of what is coming, sent in advance |
| Delivery note | The paperwork that comes with the truck; with a QR code it can be scanned and compared |
| QA | The hold status for problem cases; after checking they become sellable, return to vendor or scrap |
| Pallet put-away | Scanning a pallet's cases, then one bin, to put them away together |
| Made to order | Deli items cooked for an order and kept in a hot-hold slot |
| Hot-hold slot | Where a finished deli item is kept; one item per slot, discarded automatically when held too long |
| Oversized | Items too heavy or too large for a tote; handled piece by piece, scanned before the label is printed, kept in the oversized area |
| Parcel hub | Carrier parcels inducted, staged in the store, then handed to the driver |
| Disposition | What happens to a returned item: restock, scrap, hazmat disposal, return to vendor |
| Recall | Pulling, blocking and notifying customers from a public recall notice; closes only after all five steps |
| Incident | A checklist split by role for a power outage, fire alarm, system outage or severe storm |
| Food safety log | Each temperature-controlled unit's temperatures, excursions, alerts and repairs for a day |
| Repair ticket | A unit's repair record; while open, the slots that unit serves stop taking new totes |
| Shift lead | The lead on shift; has the AI tab and can reassign people and change store settings |
| On duty | The panel behind 👥 in the top bar: who is in which role and what they are doing |
| Temporary move | The shift lead moves someone to another role for a while; they move back automatically when the time is up |
| Queued move | Someone with a task in hand moves to the new role after finishing it |
| Pinned | People AI never suggests moving |
| Next up | The next task the system suggests when you have nothing in hand |
| Reminders | Notifications behind 🔔; AI decides who gets them and when |
| Show only, Confirm, Auto | The three modes of an AI module |
| Slot capacity | How many more orders each pickup slot can take |
| Draft schedule | A week's schedule drafted by AI and editable by hand; it takes effect once published |
| Shift offer | An invitation sent to others when someone is absent; it takes effect once the person accepts |
| Store settings | "Require scanning" and "When handoff prep can start" |
| Auto operations | Virtual customers, associates and drivers in the demo, running alongside your own work |
| Planning twin | The simulator's full-day simulation, used to try layouts, staffing and policies |
| Live twin | The 3D twin in sync with the store once connected |
| Replay, forecast | Going back to an earlier moment of the day; projecting the next 3 hours from now |
| Twin health | A score for how closely the twin matches the store |
| Policy, profile | How work is done in the planning twin: baseline, default profile, efficiency-first profile |
| Scenario | A saved set of simulator settings and results |

## 9. Further reading

Most design documents are in Chinese; [docs/en/overview.md](../en/overview.md) summarizes all of them in English.

- [16 · Operation flows (Chinese)](../16-operation-flows.md): every workflow step by step, with tap and scan counts, refusal reasons, and how each friction point was fixed.
- [08 · Live operations (Chinese)](../08-live-operations.md): the associate app and real-time backend, pickup codes, driver cancellation, how to run it.
- [09 · Backroom, exceptions and replenishment (Chinese)](../09-backroom-replenishment.md): receiving, put-away, counts, backroom fetches, shelf-stock estimates.
- [10 · Store AI (Chinese)](../10-store-ai.md): recommendation records, the three modes, the local assistant.
- [12 · Business modules and a second industry (Chinese)](../12-business-modules.md): rules for made-to-order deli, returns, oversized items and the parcel hub.
- [13 · In-browser demo, end-to-end tests and deployment (Chinese)](../13-demo-and-deployment.md): the showcase, address parameters, deployment.
- [07 · Simulator (Chinese)](../07-simulator.md) and [14 · Digital twin (Chinese)](../14-digital-twin.md): everything the simulator does; the twin's replay, forecast and alerts.
- [Decision 0025 (Chinese)](../decisions/0025-team-view-dispatch.md) (on-duty team and reassignment) and [decision 0026 (Chinese)](../decisions/0026-flow-fixes.md) (store settings and workflow fixes).
- Project overview: [README.en.md](../../README.en.md).
