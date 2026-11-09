/**
 * 资料库：常见情况的处理办法（标准作业流程，写在下面），加上设计文档按小节切开的内容，按关键词检索（BM25）。
 *
 * 中文按单字和相邻两字切词，英文按单词；标题里的词权重加倍。检索只返回原文片段和出处，不改写、不编造。
 */
export interface Passage {
  id: string;
  title: string;
  /** 出处：处理办法 / 文档名 · 小节 */
  source: string;
  text: string;
}

/** 常见情况的处理办法（通用的做法，按本项目的功能写） */
export const SOP: Passage[] = [
  { id: 'sop-cold-doors', title: '冷链门不够用怎么办', source: '处理办法', text: '先看调度台「问题」页有没有冷链门冲突，能自动修的点「改门」。冷链门 C01–C04 收货、C05–C12 发货，忙的时段收货门和发货门可以临时互借。装车超时的门，孪生会建议把下一辆车改到空闲的冷链门（低风险，可以自动执行）。还不够就把发车错开 15–30 分钟；长期不够在管理台给物流园加冷链门。' },
  { id: 'sop-breakdown', title: '车辆抛锚怎么处理', source: '处理办法', text: '车载终端报发动机故障以后，孪生推演两种做法：派救援车接走车上的货（救援车从配送中心出发，转货约 30 分钟，按里程计费），或者等修好（约 1.5 小时）。车上有冷链货、门店快到收货截止时一般派救援车；离收货截止还早、修车快时等修好更省。确认后在实时跟踪里能看到救援车，修好的车空车回配送中心。' },
  { id: 'sop-temp', title: '冷机温度超标怎么办', source: '处理办法', text: '先提醒司机就近停车检查车门密封（低风险，可以自动执行）；压缩机正常时远程把设定温度调低 2 °C；压缩机坏了调设定温度没用，派冷藏车接货。超温的货到店单独验收，记下货温和超温时长；超温分钟在合计分里按 2 倍算。' },
  { id: 'sop-dock', title: '门店收货口排不开怎么办', source: '处理办法', text: '综合店店后有 4 个收货口，配送中心的车和长途直送车共用，先到先用。排不开时孪生会建议让后到的车在路边晚点进场，或者通知门店顺延收货截止（门店多排半小时人手）。' },
  { id: 'sop-stockout', title: '门店预计缺货怎么办', source: '处理办法', text: '孪生按收银（每 15 分钟）和盘点（每小时）数据估计每个商品族还能卖多久，比预测卖得快就提前报警。做法：配送中心追加一趟小车补货，或者把进配送中心的长途车改直送门店。缺货分钟在合计分里按 1.5 倍算。' },
  { id: 'sop-late', title: '长途直送车晚到怎么办', source: '处理办法', text: '长途车进区域之前每小时报一次预计进区域的时刻。预计赶不上收货截止时，可以通知门店顺延收货（约 25 美元的加班），或者接受晚到；晚得不多、门店人手紧张时一般接受。' },
  { id: 'sop-port', title: '港口拥堵的预案', source: '处理办法', text: '港口拥堵时堆场停留时间翻倍。预案：靠预清关和预约让自己的箱优先放行（只多 30%）、用铁路接驳、提前提箱、门店相关商品族的安全库存多放一天；演练里可以选「港口拥堵」看效果。' },
  { id: 'sop-airport', title: '机场关闭怎么办', source: '处理办法', text: '空运的进口果蔬和海鲜停飞期间，用区域生鲜和海运冷箱补位，门店相关商品族提高备货；机场恢复后先放冷链货。演练里可以选「机场关闭」。' },
  { id: 'sop-highway', title: '高速封闭怎么办', source: '处理办法', text: '改走另一个高速出口，配送车错峰（提前或夜间出发），门店收货时段适当延长；长途直送车改进配送中心再分拨。演练里可以选「高速封闭」。' },
  { id: 'sop-supplier', title: '供应商断供怎么办', source: '处理办法', text: '切换备用供应商，配送中心按门店销量分配现有库存，门店调整陈列、减少促销；恢复后先补安全库存。演练里可以选「供应商断供」。' },
  { id: 'sop-surge', title: '需求暴涨怎么应对', source: '处理办法', text: '追加配送车次，优先补缺货风险高的商品族，线上订单分波次；孪生的缺货预警会提前给出追加补货、改直送的建议。演练里可以选「需求暴涨」。' },
  { id: 'sop-door-overrun', title: '月台门装车超时怎么办', source: '处理办法', text: '仓库系统每 5 分钟扫描一次托盘，孪生按装车进度预测装完的时刻；会耽误下一辆车时，建议把下一辆车改到空闲的门（低风险，可以自动执行），没有空门就等这樘门。' },
  { id: 'sop-handover', title: '交接班要交代什么', source: '处理办法', text: '本班完成的车次和准点情况；发生的事件和怎么处理的；没处理完的建议卡、还在路上晚点的车、没结束的路况；下一班的到港、航班、班列、收货高峰和预计缺货。值班助手可以一键生成交接班报告。' },
  { id: 'sop-cards', title: '建议卡怎么用', source: '处理办法', text: '孪生发现问题时出一张建议卡：列出几种做法和逐个推演的结果（迟到、超温、缺货分钟和多花的钱），推荐合计分最低的。待处理的卡可以选一个做法执行，或者否决；决定在此刻生效，整天从头再推演一遍。' },
  { id: 'sop-policy', title: '自动执行的范围', source: '处理办法', text: '三档：全部人工确认；低风险的自动执行（改门、提醒司机检查、调设定温度、不处理），要花钱或改计划的仍等调度员；全部自动执行。值班助手提出的动作一律先给人看推演结果，确认以后才执行。' },
  { id: 'sop-score', title: '合计分怎么算', source: '处理办法', text: '合计分 = 迟到分钟 + 超温分钟 × 2 + 缺货分钟 × 1.5 + 多花的钱（美元）÷ 12。建议卡推荐合计分最低的做法；用孪生和不用孪生也按它比。' },
  { id: 'sop-fidelity', title: '孪生的保真度是什么', source: '处理办法', text: '保真度看孪生的估计跟现场差多少：提前半小时估计到店时刻的平均误差（分钟）、货温误差（°C）、门店库存误差（%）；孪生还会从定位里学「比计划慢多少」，估计越用越准。' },
  { id: 'sop-track', title: '实时跟踪怎么看', source: '处理办法', text: '实时跟踪列出所有车船飞机的位置、状态、从哪来到哪去、下一站和预计到达、载重、货温；点一行镜头跟过去。现场视图里预计到达用孪生按感知数据的估计。' },
  { id: 'sop-facility', title: '设施监控和管理台', source: '处理办法', text: '设施监控看港口、机场、物流园、综合店此刻的设备、在场车辆和作业进度；管理台可以改泊位、机位、装卸线、月台门、设备和排班，改完重新载入页面生效（配置存在本机浏览器里）。' },
  { id: 'sop-load', title: '负荷档位是什么意思', source: '处理办法', text: '压力测试用：平常、高峰、高负荷、极限四档，需求、班轮航次、洲际班列和货运航班一起放大，港口、机场和道路上别家的流量也跟着变密。' },
  { id: 'sop-drill', title: '演练有哪些', source: '处理办法', text: '演练沿用报告里的五种扰动：港口拥堵、机场关闭、高速封闭、供应商断供、需求暴涨；选了以后动画那一天正好在扰动里，可以看调度台、闭环孪生怎么应对。' },
  { id: 'sop-region', title: '区域怎么换', source: '处理办法', text: '默认区域是报告里的数字用的区域；随机生成时海在哪一侧、河、城市大小、港口、机场、物流园、铁路、高速出口、门店的位置全部随机；自定义可以逐项指定。' },
  { id: 'sop-server', title: '孪生服务是什么', source: '处理办法', text: '孪生服务在服务器上按可以加速的真实时间跑同一套仿真、调度台和闭环孪生，用 REST 和 WebSocket 把车辆位置、感知数据、建议卡推给虚幻引擎、MATLAB 和浏览器，接收批准、否决和指令；值班助手也有接口。只监听本机。' },
  { id: 'sop-parking', title: '停车场和道闸', source: '处理办法', text: '港口、机场、物流园、客运站和城区都有停车场；员工停车场有岗亭和道闸，车在闸前停一下、抬杆再走。港口和机场还有货车等候区。' },
  { id: 'sop-guardrails', title: '值班助手的规则表（护栏）', source: '处理办法', text: '值班助手只读数据、只给提议，执行一律要人点「确认执行」，问题里要求跳过确认、审批的不理会。角色：只读不能执行；调度员能直接执行低风险的和多花不超过 100 美元的；站长 1,000 美元以内；区域经理不限。冷链货在月台、场地或路边等待不超过 30 分钟；会让冷链货超温 30 分钟以上、而有别的做法不超温的不提议。一次最多批量执行 6 条。每条提议显示之前都按规则表检查，检查结果记进操作记录。' },
  { id: 'sop-dataquality', title: '数据通道变差时怎么办', source: '处理办法', text: '定位、事件丢点、晚到或断线时，孪生按计划和最后知道的延误推算位置。值班助手在回答里写明丢了多少、平均晚到多久、最长断线多久，并按数据质量降低把握；提议标成「先核实，逐条确认」：问司机、看监控确认以后再执行，不批量。' },
  { id: 'sop-rca', title: '晚点归因怎么算', source: '处理办法', text: '闭环每分钟记一次每辆车比计划晚多少。把每一分钟的增量归给那一分钟正在发生的事：车辆故障、调度指令让车晚点进、在配送中心装车或等月台门、在门店等收货口、途中停靠、路上的事故施工拥堵、路上车速比计划慢；出发时带着的延误记为出发前，路上追回的记负数。各项加起来等于总的晚点。问「M02 为什么晚」「门店今天为什么晚」。' },
  { id: 'sop-appointment', title: '预约错峰怎么用', source: '处理办法', text: '仓储中心月台前排队太长时，把还没到的车的预约时段挪一挪：只改 30 分钟以后才到的车，冷链车最多挪 30 分钟、普通车最多挪 60 分钟，冷链车挪完以后等待不超过 30 分钟。比较挪之前和挪之后的排队（门店收货场有场地布置，用场地排程器逐辆排；其他设施用先到先服务的排队模型估，回答里写明是哪个），确认后记进操作记录、通知承运商（孪生里不改到达时刻）。问「港口物流中心预约错峰」。' },
  { id: 'sop-hubs', title: '仓储中心有哪些区', source: '处理办法', text: '港口物流中心：集装箱堆场、闸口排队车道、拆装箱库（拼箱货拆箱、装箱）、保税库、查验场、拆装箱月台。机场货站：ULD 立体库、拆组板区、冷库（2–8 °C）、散货库、陆侧月台和排队车道。物流园：铁路堆场、转运仓、月台、园区闸口排队、甩挂区。门店：顾客车位、线上取货车位、收货排队车道、收货口。货从船、飞机、火车卸下来先进这些区，再装上公路的车；问「港口物流中心怎么样」「本店的货在哪」「哪里是瓶颈」。' },
];

/**
 * 处理办法的英文（英文界面显示资料库摘录时用）：text 按中文原文的句子（以「。」切开）逐句对应。只用来显示，不进检索，中文回答和评测不受影响。
 * English text of each playbook entry, one English sentence per Chinese sentence (split at 「。」); display only, not indexed.
 */
export const SOP_EN: Record<string, { title: string; text: string[] }> = {
  'sop-cold-doors': {
    title: 'What if there are not enough cold-chain doors',
    text: [
      'First check the dispatch board\'s "Issues" tab for cold-chain door conflicts, and click "Change door" on the ones that can be fixed automatically.',
      'Cold-chain doors C01–C04 receive and C05–C12 ship; at busy times receiving and shipping doors can be borrowed from each other.',
      'When loading at a door overruns, the twin suggests moving the next truck to a free cold-chain door (low risk, can run automatically).',
      'If that is still not enough, stagger departures by 15–30 minutes; if doors stay short, add cold-chain doors to the logistics park in the admin console.',
    ],
  },
  'sop-breakdown': {
    title: 'How to handle a vehicle breakdown',
    text: [
      'When the on-board unit reports an engine fault, the twin simulates two options: send a rescue truck to take over the load (it leaves from the DC, the transfer takes about 30 minutes, charged by distance), or wait for the repair (about 1.5 hours).',
      "With cold-chain goods on board and the store's receiving cutoff close, a rescue truck is usually sent; when the cutoff is still far off and the repair is quick, waiting is cheaper.",
      'Once confirmed, the rescue truck shows in live tracking, and the repaired truck returns empty to the DC.',
    ],
  },
  'sop-temp': {
    title: 'What if the reefer temperature is too high',
    text: [
      'First remind the driver to stop nearby and check the door seals (low risk, can run automatically); if the compressor works, lower the set point remotely by 2 °C; if the compressor is broken, changing the set point does not help, so send a reefer truck to take over the load.',
      'Goods that ran warm are checked separately at the store, recording the cargo temperature and how long it was too warm; minutes over temperature count double in the total score.',
    ],
  },
  'sop-dock': {
    title: "What if the store's receiving docks are full",
    text: [
      'The store has 4 receiving docks at the back, shared by DC trucks and long-haul direct trucks, first come first served.',
      'When they are full, the twin suggests letting the later truck wait at the roadside and enter later, or asking the store to extend the receiving cutoff (half an hour of extra staff).',
    ],
  },
  'sop-stockout': {
    title: 'What if the store is expected to run out',
    text: [
      'The twin estimates from checkout data (every 15 minutes) and stock counts (hourly) how long each product family will last, and warns early when it sells faster than forecast.',
      'Options: the DC adds an extra small-truck replenishment run, or a long-haul truck bound for the DC goes straight to the store.',
      'Out-of-stock minutes count 1.5 times in the total score.',
    ],
  },
  'sop-late': {
    title: 'What if a long-haul direct truck is late',
    text: [
      'Before entering the region, long-haul trucks report their expected entry time every hour.',
      'If one is expected to miss the receiving cutoff, the store can be asked to extend receiving (about $25 of overtime), or the late arrival can be accepted; when it is only a little late and the store is short of staff, it is usually accepted.',
    ],
  },
  'sop-port': {
    title: 'Port congestion plan',
    text: [
      'When the port is congested, yard dwell time doubles.',
      'Plan: use pre-clearance and appointments so our boxes are released first (only 30% longer), connect by rail, pick up boxes early, and keep one more day of safety stock for the affected product families; pick "Port congestion" in the drills to see the effect.',
    ],
  },
  'sop-airport': {
    title: 'What if the airport closes',
    text: [
      'While air-freighted imported produce and seafood are grounded, fill in with regional fresh goods and ocean reefer containers and raise the stock of the affected families at the store; when the airport reopens, cold-chain goods go first.',
      'Pick "Airport closed" in the drills.',
    ],
  },
  'sop-highway': {
    title: 'What if the highway closes',
    text: [
      "Use another highway exit, stagger the delivery trucks (leave earlier or at night) and extend the store's receiving hours a little; long-haul direct trucks go to the DC first and are redistributed from there.",
      'Pick "Highway closed" in the drills.',
    ],
  },
  'sop-supplier': {
    title: 'What if a supplier stops delivering',
    text: [
      'Switch to a backup supplier; the DC allocates the stock on hand by store sales, and the store adjusts displays and cuts promotions; after recovery, safety stock is refilled first.',
      'Pick "Supplier outage" in the drills.',
    ],
  },
  'sop-surge': {
    title: 'How to handle a demand surge',
    text: [
      "Add delivery runs, replenish the families with the highest stock-out risk first and split online orders into waves; the twin's stock-out warnings suggest extra replenishment or direct delivery early.",
      'Pick "Demand surge" in the drills.',
    ],
  },
  'sop-door-overrun': {
    title: 'What if loading at a dock door overruns',
    text: [
      'The warehouse system scans pallets every 5 minutes and the twin predicts when loading will finish from the progress; if the next truck would be held up, it suggests moving that truck to a free door (low risk, can run automatically), or waiting for this door if none is free.',
    ],
  },
  'sop-handover': {
    title: 'What to cover at shift handover',
    text: [
      "Trips completed this shift and their punctuality; events and how they were handled; open recommendation cards, trucks still running late and ongoing road incidents; the next shift's ship arrivals, flights, trains, receiving peaks and expected stock-outs.",
      'The duty assistant writes the handover report in one click.',
    ],
  },
  'sop-cards': {
    title: 'How recommendation cards work',
    text: [
      'When the twin finds a problem it issues a recommendation card: it lists several options with the simulated outcome of each (late, over-temperature and out-of-stock minutes and extra cost) and recommends the one with the lowest total score.',
      'For an open card you can run one option or reject it; the decision takes effect now and the whole day is simulated again from the start.',
    ],
  },
  'sop-policy': {
    title: 'What runs automatically',
    text: [
      'Three levels: everything confirmed by a person; low-risk actions run automatically (change door, remind the driver to check, adjust the set point, do nothing) while those that cost money or change the plan still wait for the dispatcher; everything runs automatically.',
      "Actions proposed by the duty assistant always show the simulated outcome first and run only after confirmation.",
    ],
  },
  'sop-score': {
    title: 'How the total score is calculated',
    text: ['Total score = late minutes + over-temperature minutes × 2 + out-of-stock minutes × 1.5 + extra cost (US$) ÷ 12.', 'Recommendation cards recommend the option with the lowest total score; runs with and without the twin are compared by it too.'],
  },
  'sop-fidelity': {
    title: "What the twin's fidelity is",
    text: [
      "Fidelity measures how far the twin's estimates are from the field: the average error of the arrival time estimated half an hour ahead (minutes), the cargo temperature error (°C) and the store stock error (%); the twin also learns from GPS how much slower than plan trucks run, so its estimates get better with use.",
    ],
  },
  'sop-track': {
    title: 'How to read live tracking',
    text: [
      'Live tracking lists every truck, ship and plane with its position, status, origin and destination, next stop and ETA, load and cargo temperature; click a row and the camera follows it.',
      "In the field view, ETAs are the twin's estimates from sensor data.",
    ],
  },
  'sop-facility': {
    title: 'Facility monitor and admin console',
    text: [
      'The facility monitor shows the equipment, vehicles on site and work progress at the port, airport, logistics park and store right now; the admin console changes berths, aircraft stands, rail tracks, dock doors, equipment and staffing, effective after the page reloads (the settings are kept in this browser).',
    ],
  },
  'sop-load': {
    title: 'What the load levels mean',
    text: [
      "For stress tests: four levels, normal, peak, high and extreme; demand, liner calls, intercontinental trains and freighter flights scale up together, and other companies' traffic at the port, the airport and on the roads gets denser too.",
    ],
  },
  'sop-drill': {
    title: 'Which drills there are',
    text: [
      'The drills use the five disruptions from the report: port congestion, airport closed, highway closed, supplier outage and demand surge; once one is picked, the animated day falls inside the disruption, so you can see how the dispatch board and the closed-loop twin respond.',
    ],
  },
  'sop-region': {
    title: 'How to change the region',
    text: [
      "The default region is the one the report's numbers use; a random region randomizes the side the sea is on, the river, the city size and the positions of the port, airport, logistics park, railway, highway exits and store; custom lets you set each item.",
    ],
  },
  'sop-server': {
    title: 'What the twin server is',
    text: [
      'The twin server runs the same simulation, dispatch board and closed-loop twin on a server in real time (which can be sped up), pushes vehicle positions, sensor data and recommendation cards to Unreal Engine, MATLAB and browsers over REST and WebSocket, and receives approvals, rejections and commands; the duty assistant has an endpoint too.',
      'It listens on this machine only.',
    ],
  },
  'sop-parking': {
    title: 'Parking lots and barriers',
    text: [
      'The port, airport, logistics park, passenger station and city all have parking lots; staff lots have a booth and a barrier, where cars stop briefly and drive on once the barrier lifts.',
      'The port and the airport also have truck holding areas.',
    ],
  },
  'sop-guardrails': {
    title: 'Duty assistant rules (guardrails)',
    text: [
      'The duty assistant only reads data and only proposes; anything it runs needs a person to click "Confirm", and requests in a question to skip confirmation or approval are ignored.',
      'Roles: viewers cannot run anything; dispatchers can directly run low-risk actions and those costing up to $100 extra; station managers up to $1,000; regional managers without limit.',
      'Cold-chain goods wait no more than 30 minutes at a dock, in a yard or at the roadside; an option that keeps cold-chain goods over temperature for 30 minutes or more is not proposed when another option avoids it.',
      'At most 6 proposals run in one batch.',
      'Every proposal is checked against the rules before it is shown, and the result goes into the audit log.',
    ],
  },
  'sop-dataquality': {
    title: 'What if the data feeds degrade',
    text: [
      'When GPS points or events are lost, arrive late or the link drops, the twin estimates positions from the plan and the last known delay.',
      'The duty assistant states in its answer how much was lost, the average lateness and the longest outage, and lowers its confidence by data quality; proposals are marked "Verify first, confirm item by item": run them only after checking with the driver or the cameras, not in a batch.',
    ],
  },
  'sop-rca': {
    title: 'How delay attribution works',
    text: [
      'Every minute the closed loop records how far behind plan each truck is.',
      "Each minute's increase goes to what was happening in that minute: a vehicle fault, a dispatch command holding the truck back, loading at the DC or waiting for a dock door, waiting for a receiving dock at the store, en-route stops, accidents, roadworks or congestion, or driving slower than planned; delay carried from the start counts as before departure, and time made up on the road counts as negative.",
      'The items add up to the total delay.',
      'Ask "Why is M02 late" or "Why is the store late today".',
    ],
  },
  'sop-appointment': {
    title: 'How appointment smoothing works',
    text: [
      "When the queue at a hub's docks gets too long, shift the appointment slots of trucks not yet arrived: only trucks due in more than 30 minutes, cold-chain trucks by at most 30 minutes and other trucks by at most 60 minutes, and cold-chain trucks wait no more than 30 minutes afterwards.",
      "The queue before and after the shift is compared (the store's receiving yard has a site layout and is scheduled truck by truck with the yard scheduler; other facilities are estimated with a first-come-first-served queue model, and the answer says which); after confirmation it goes into the audit log and the carriers are notified (arrival times in the twin do not change).",
      'Ask "Appointment smoothing at the port logistics center".',
    ],
  },
  'sop-hubs': {
    title: 'Which areas the hubs have',
    text: [
      'Port logistics center: container yard, gate queue lanes, CFS warehouse (unstuffing and stuffing LCL cargo), bonded warehouse, inspection yard, CFS docks.',
      'Air cargo terminal: ULD high-bay store, build-up/break-down area, cold store (2–8 °C), bulk store, landside docks and queue lanes.',
      'Logistics park: rail yard, transfer warehouse, docks, park gate queue, trailer drop area.',
      'Store: customer parking, online pickup spaces, receiving queue lane, receiving docks.',
      'Goods unloaded from ships, planes and trains go into these areas first and then onto road trucks; ask "How is the port logistics center", "Where are our goods" or "Where is the bottleneck".',
    ],
  },
};

/** 韧性预案库的预案也进资料库（触发条件、负责人、按时间的步骤、仿真里对应的设置） */
export function playbookPassages(list: readonly { key: string; title: string; trigger: string; owners: readonly string[]; steps: readonly { when: string; owner: string; text: string }[]; levers: string }[]): Passage[] {
  return list.map((p) => ({ id: `pb-${p.key}`, title: p.title, source: '韧性预案库', text: `触发：${p.trigger}。负责：${p.owners.join('、')}。步骤：${p.steps.map((s) => `${s.when}（${s.owner}）${s.text}`).join('；')}。仿真里对应的措施：${p.levers}。` }));
}

const HAN = /[一-鿿]/;
export function terms(s: string): string[] {
  const out: string[] = [];
  const lower = s.toLowerCase();
  for (const w of lower.match(/[a-z0-9][a-z0-9.-]*/g) ?? []) out.push(w);
  let run = '';
  const flush = () => {
    for (const c of run) out.push(c);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    run = '';
  };
  for (const c of lower) {
    if (HAN.test(c)) run += c;
    else flush();
  }
  flush();
  return out;
}

/** 常见的虚词不计分 */
const STOP = new Set(['的', '了', '是', '在', '和', '有', '吗', '呢', '么', '什', '怎', '么办', '怎么', '什么', '一', '个', '我', '你', '这', '那', '就', '也', '都', '要', '会', '能', '请问', '问', '请']);

/** 把 Markdown 文档按小节（## / ###）切开 */
export function splitDoc(title: string, text: string): Passage[] {
  const out: Passage[] = [];
  let head = title;
  let buf: string[] = [];
  let n = 0;
  const push = () => {
    const body = buf
      .join('\n')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*`>#|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (body.length > 40) out.push({ id: `${title}#${n++}`, title: head, source: `${title} · ${head}`, text: body });
    buf = [];
  };
  for (const line of text.split('\n')) {
    const m = /^(#{2,4})\s+(.+)/.exec(line);
    if (m) {
      push();
      head = (m[2] as string).trim();
    } else buf.push(line);
  }
  push();
  return out;
}

interface Index {
  docs: { p: Passage; tf: Map<string, number>; len: number }[];
  df: Map<string, number>;
  avg: number;
}

export function buildIndex(passages: readonly Passage[]): Index {
  const docs = passages.map((p) => {
    const tf = new Map<string, number>();
    const all = [...terms(p.title), ...terms(p.title), ...terms(p.text)];
    for (const w of all) if (!STOP.has(w)) tf.set(w, (tf.get(w) ?? 0) + 1);
    return { p, tf, len: all.length };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  return { docs, df, avg: docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length) };
}

/** BM25：返回最相关的几段（分数太低的不要） */
export function search(index: Index, query: string, k = 3): { p: Passage; score: number }[] {
  const q = terms(query).filter((w) => !STOP.has(w));
  const N = index.docs.length;
  const scored = index.docs.map((d) => {
    let s = 0;
    for (const w of q) {
      const f = d.tf.get(w);
      if (!f) continue;
      const n = index.df.get(w) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += (idf * (f * 2.2)) / (f + 1.2 * (0.25 + 0.75 * (d.len / index.avg)));
    }
    return { p: d.p, score: s };
  });
  const top = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const best = top[0]?.score ?? 0;
  return top.filter((x) => x.score >= Math.max(2, best * 0.45)).slice(0, k);
}

/** 片段：从和问题最相关的地方截一段 */
export function snippet(p: Passage, query: string, len = 140): string {
  if (p.text.length <= len) return p.text;
  const q = terms(query).filter((w) => w.length >= 2 && !STOP.has(w));
  let at = 0;
  for (const w of q) {
    const k = p.text.indexOf(w);
    if (k >= 0) {
      at = Math.max(0, k - 30);
      break;
    }
  }
  const cut = p.text.slice(at, at + len);
  return `${at > 0 ? '…' : ''}${cut}${at + len < p.text.length ? '…' : ''}`;
}
