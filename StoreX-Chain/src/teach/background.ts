/**
 * 每道练习的背景知识和课后讨论题（只用公开的通用知识；实验指导书 docs/teaching/lab-manual*.md 由 npm run teach -- manual --write 按这里和练习定义生成，
 * 练习面板也显示背景知识）。讨论题不批改，供课堂讨论和报告用。
 * Background notes and discussion questions per exercise (general public knowledge only).
 */
export interface Background {
  background: { zh: string; en: string };
  think: { zh: string; en: string }[];
}

export const BACKGROUND: Record<string, Background> = {
  ex01: {
    background: {
      zh: '运营看三类指标：服务（门店服务水平 = 卖出的件数 ÷ 顾客想买的件数；到店准点）、效率（每箱的供应链成本 = 供应链一天的总成本 ÷ 当天送到门店的箱数）、资源（车队、工时、库存天数）。同一个指标要分清口径：孪生左侧的「这次运行（18 周平均）」表是 18 周的日平均，调度台是动画那一天的作业，两者回答的是不同的问题。',
      en: 'Operations track three kinds of indicators: service (store service level = units sold ÷ units customers wanted; on-time arrival), efficiency (cost per case = total daily supply-chain cost ÷ cases delivered to the store) and resources (fleet, labour hours, days of inventory). Always check the basis of a figure: the "This run (18-week average)" table shows 18-week daily averages, while the Dispatch board shows the jobs of the animated day, and they answer different questions.',
    },
    think: [
      {
        zh: '服务水平已经 99% 以上了，再往上提一个百分点值不值？要付出什么代价？',
        en: 'Service is already above 99%. Is one more point worth it, and what would it cost?',
      },
      {
        zh: '为什么调度台上有一站迟到，18 周平均的准时送达却可能是 100%？',
        en: 'How can the Dispatch board show a late stop while the 18-week on-time figure is still 100%?',
      },
    ],
  },
  ex02: {
    background: {
      zh: '进口集装箱的典型流程：卸船进堆场 → 报关、查验、放行 → 预约提箱，拖车拉走（或上铁路）。码头给一段免费堆存期，超过以后按天收滞箱费（demurrage）和堆存费。缩短停留的常见办法：货到港前先申报（预清关）、提箱预约、海铁联运（铁路接驳）把箱子直接从港区拉走。',
      en: 'A typical import flow: discharge into the yard → declaration, inspection, release → booked pick-up by truck (or onto rail). Terminals allow some free time; beyond it demurrage and storage charges accrue per day. Common ways to cut dwell: declare before the ship arrives (pre-clearance), pick-up appointments, and sea-rail intermodal shuttles that take boxes straight out of the port.',
    },
    think: [
      {
        zh: '滞箱费几乎降到零以后，堆场停留还值得继续缩短吗？还有哪些好处（库存、场地、碳排放）？',
        en: 'Once demurrage is near zero, is it still worth cutting dwell? What else improves (inventory, yard space, emissions)?',
      },
      {
        zh: '铁路接驳的箱子在物流园货运站还要停一段时间，这段时间该算谁的「停留」？',
        en: 'Rail-shuttled boxes wait again at the logistics-park terminal. Whose "dwell" is that?',
      },
    ],
  },
  ex03: {
    background: {
      zh: '估算车队：需要的车数 ≈ 一天所有车次的用时之和 ÷ 每辆车一天能用的时间；一趟的用时 = 装车 + 去程 + 在门店卸货 + 回程。利特尔法则（L = λW）给出同样的直觉：在途的车数 = 发车频率 × 每趟用时。卸货慢一点，每趟就长一点，同样的车次就要更多的车。',
      en: "Fleet sizing: trucks needed ≈ total time of all trips in a day ÷ time one truck is available; trip time = loading + outbound + unloading at the store + return. Little's law (L = λW) gives the same intuition: trucks on the road = dispatch rate × time per trip. Slower unloading lengthens every trip, so the same trips need more trucks.",
    },
    think: [
      {
        zh: '多雇一个收货员和多买 / 租一辆车，哪个更划算？需要哪些数据才能算清楚？',
        en: 'Is one more receiver cheaper than one more truck? Which data would you need to decide?',
      },
      {
        zh: '除了加人，还有哪些办法能缩短在门店的卸货时间（托盘化、无人值守收货、预约）？',
        en: 'Besides adding staff, how else can unloading at the store be shortened (unitised loads, unattended receiving, appointments)?',
      },
    ],
  },
  ex04: {
    background: {
      zh: '月台门按「同时在用的峰值」规划：把每辆车占门的时间段画在时间轴上，数一数最多同时有几辆，再留一点余量。全天平均利用率低并不说明门多余——车往往集中在几个小时里到和发。排队论的直觉：资源越接近满负荷，等待时间增长得越快；预约错峰可以削低峰值。',
      en: "Dock doors are planned for the concurrent peak: draw each truck's door occupancy on a timeline, count the maximum overlap and add a margin. Low average utilisation does not mean spare doors — arrivals bunch into a few hours. Queueing intuition: as a resource nears full load, waiting grows ever faster; appointment slots flatten the peak.",
    },
    think: [
      {
        zh: '如果给到车加上预约、把峰值削平，冷链门还能再少开几樘？要付出什么（司机等待、灵活性）？',
        en: 'With appointments that flatten the peak, how many more cold doors could close, and at what price (driver waiting, flexibility)?',
      },
      { zh: '门开得少，节省的是什么成本（人员、能耗、冷量）？', en: 'What exactly is saved by opening fewer doors (staff, energy, refrigeration)?' },
    ],
  },
  ex05: {
    background: {
      zh: '冷链按温区管理（冷藏约 0–4 °C，冷冻 −18 °C 以下），任何一段断链都会缩短保质期。「到店剩余保质期」= 到店时还剩的保质期 ÷ 总保质期，剩得越多，门店卖完前报废的越少。越库（cross-docking）是货到配送中心马上分拣、装车发走，不入库存储；夜间集货 + 越库可以让生鲜少在配送中心过一夜。',
      en: 'Cold chains are managed by temperature zone (chilled about 0–4 °C, frozen below −18 °C); any break shortens shelf life. Remaining shelf life at the store = shelf life left on arrival ÷ total shelf life; the more is left, the less is wasted before it sells. Cross-docking sorts goods on arrival at the DC and ships them straight out without storage; night consolidation plus cross-docking saves fresh goods one night in the DC.',
    },
    think: [
      {
        zh: '剩余保质期提高十几个百分点，对顾客、对门店的报废和打折分别意味着什么？',
        en: 'What do some 16 more points of remaining shelf life mean for customers, and for store waste and markdowns?',
      },
      {
        zh: '越库对配送中心的作业提出了什么要求（时间窗、信息、分拣能力）？',
        en: 'What does cross-docking demand of DC operations (time windows, information, sorting capacity)?',
      },
    ],
  },
  ex06: {
    background: {
      zh: '门店收货的能力由三样东西决定：收货口个数、每个口的卸货速度（人和设备）、车到店的时间分布。车到得越集中，同时要卸的车就越多。常见的做法：给配送车排到店时段（预约、错峰），按高峰排收货班次，必要时加口。',
      en: 'Store receiving capacity depends on three things: the number of docks, the unloading speed at each dock (people and equipment), and when trucks arrive. The more arrivals bunch up, the more trucks need a dock at once. Usual remedies: book delivery slots (staggering), staff receiving shifts for the peak, and add docks only when needed.',
    },
    think: [
      {
        zh: '加一个收货口（土建、场地）和调整配送车的到店时间，各自的成本和难度如何？',
        en: 'Compare adding a dock (construction, space) with re-timing deliveries: cost and difficulty?',
      },
      { zh: '「极限」负荷一年只有几天，收货口应该按哪一天来配？', en: 'Extreme days happen only a few times a year. Which day should the docks be sized for?' },
    ],
  },
  ex07: {
    background: {
      zh: '供应链韧性看三件事：扰动对服务的影响有多大、能顶多久、多快恢复。港口拥堵会拉长海运的提前期；配送中心和门店的安全库存就是用来顶住这种波动的——库存天数下降说明库存在起作用。应急预案（改走铁路、空运、临时采购）是库存顶不住时的第二道防线。',
      en: 'Supply-chain resilience asks three things: how much a disruption hurts service, how long the system can absorb it, and how fast it recovers. Port congestion lengthens sea lead times; safety stock in the DC and store exists to absorb such swings — falling days of inventory show it working. Contingency playbooks (rail, air, spot buying) are the second line of defence when stock runs out.',
    },
    think: [
      { zh: '如果拥堵持续 30 天而不是 10 天，哪一环最先顶不住？', en: 'If the congestion lasted 30 days instead of 10, what would give out first?' },
      { zh: '安全库存放多少才合适？放多了、放少了各有什么代价？', en: 'How much safety stock is right? What does too much or too little cost?' },
    ],
  },
  ex08: {
    background: {
      zh: '压力测试是一步一步加大负荷，看哪一种资源最先饱和（瓶颈）、问题最先出现在哪里。负荷变大时，配送中心、车队这类固定的投入被更多的箱数分摊，每箱成本会下降（规模效应），但到了容量边界，排队、加班、迟到会让边际成本陡增。',
      en: 'A stress test raises the load step by step to see which resource saturates first (the bottleneck) and where problems appear first. As volume grows, fixed resources such as the DC and fleet are spread over more cases, so cost per case falls (economies of scale) — until capacity limits bring queues, overtime and lateness that make marginal cost climb steeply.',
    },
    think: [
      { zh: '每箱成本一路下降，说明可以无限加量吗？到哪一步会掉头？', en: 'Cost per case keeps falling. Can volume grow forever? Where would it turn?' },
      {
        zh: '「高峰拥堵」这类外部因素，调度能做什么（错峰发车、改路线）？',
        en: 'What can dispatching do about external factors such as rush-hour congestion (earlier departures, other routes)?',
      },
    ],
  },
  ex09: {
    background: {
      zh: '供应链各环节各自补货时，需求的波动会逐级放大（牛鞭效应），每一级都要多放库存。共享门店的销售数据、协同补货（类似 VMI、CPFR 的思路）、缩短补货周期，能让上游按真实需求补货，整条链的库存一起降下来。只升级某一个环节，效果往往停在这一环。',
      en: 'When each stage replenishes on its own, demand swings amplify upstream (the bullwhip effect) and every stage holds extra stock. Sharing store sales data, collaborative replenishment (in the spirit of VMI and CPFR) and shorter review cycles let the upstream replenish to real demand, so inventory falls along the whole chain. Upgrading a single stage usually helps that stage only.',
    },
    think: [
      {
        zh: '全链路方案的投入（自动化、铁路、信息系统）要多久才能靠省下的成本收回？还缺哪些数据？',
        en: "How long would the Chain scheme's investment (automation, rail, IT) take to pay back from the savings? What data is missing?",
      },
      { zh: '排放和成本的改进方向一致吗？有没有相互冲突的地方？', en: 'Do emissions and cost improve together, or do they conflict anywhere?' },
    ],
  },
  ex10: {
    background: {
      zh: '运营里用 AI 助手，关键是「可审计」：回答里的每个数字都要能追到来源（调度台、看板、仓储中心计划），工具只读，涉及花钱和改计划的事只生成待确认的提议，由有权限的人确认后才执行，并留下记录。根因分析要把「晚了多少」拆到具体环节，再用原始记录核对。',
      en: 'The key to using an AI assistant in operations is auditability: every number traces to a source (Dispatch board, KPI board, hub plans), tools are read-only, and anything that spends money or changes a plan becomes a proposal that a person with the right role must confirm, with a record kept. Root-cause analysis splits "how late" into specific stages and is then checked against the raw records.',
    },
    think: [
      {
        zh: '如果助手的回答和调度台对不上，你会怎么处理？该相信哪一个？',
        en: 'If the assistant and the Dispatch board disagree, what do you do, and which do you trust?',
      },
      {
        zh: '哪些决定可以放心交给自动化执行，哪些必须有人确认？划线的标准是什么？',
        en: 'Which decisions can safely be automated, and which must a person confirm? Where would you draw the line?',
      },
    ],
  },
};
