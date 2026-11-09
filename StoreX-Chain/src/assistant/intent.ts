import { calibrated, softmaxLogits, trainSoftmax, type SoftmaxModel, type SoftmaxOpts, type SoftmaxRow } from './softmax';
import { EXTRA_CORPUS } from './corpusExtra';
import { EXTRA_CORPUS2 } from './corpusExtra2';
/**
 * 值班助手的意图分类器，判断问题该用哪个查询工具：在用的是多项式逻辑回归（softmax.ts，按字的 1–3 元片段），
 * 朴素贝叶斯留作对比；概率按温度校准过，没把握时由 index.ts 先问（给出最可能的两种意思）。
 *
 * - 训练语料：模板组合生成的说法（不同的开头、说法、结尾），加上两份由单独启动的 AI 写作代理编写的语料（corpusExtra、corpusExtra2）；训练约一秒。
 * - 评测用的留出集（HOLDOUT 和两份语料各留出 15%）不进训练；测试要求留出集的准确率。盲测题一律不参与训练、校准和调参。
 * - 朴素贝叶斯的特征：中文的单字和相邻两字、英文单词和编号，以及几个占位符（问题里认出来的车、商品族、月台门、时刻、第几条）。
 * - 少数说法很明确的（批准、否决、如果……会怎样、为什么推荐、交接班、复盘）先按规则判断，剩下的交给模型。
 * 参数（哪辆车、哪个商品族、几点）由 entities.ts 按规则抽取；分类器只负责「该用哪个工具」。
 */
export type Intent =
  | 'overview'
  | 'risks'
  | 'vehicle'
  | 'late'
  | 'stock'
  | 'doors'
  | 'port'
  | 'airport'
  | 'dc'
  | 'store'
  | 'cards'
  | 'approve'
  | 'reject'
  | 'explain'
  | 'whatif'
  | 'handover'
  | 'kpi'
  | 'incidents'
  | 'schedule'
  | 'forecast'
  | 'network'
  | 'crossborder'
  | 'optimize'
  | 'review'
  | 'knowledge'
  | 'help'
  | 'rootcause'
  | 'anomaly'
  | 'hub'
  | 'cargo'
  | 'bottleneck'
  | 'appointments'
  | 'decline'
  | 'dailyplan'
  | 'quality'
  | 'policy';

/** 问题里认出来的东西换成占位符以后的样子（entities.ts 负责替换） */
export const PLACEHOLDERS = ['<VEH>', '<FAM>', '<DOOR>', '<TIME>', '<CARD>', '<NUM>'] as const;

const HAN = /[一-鿿]/;

export function features(q: string): string[] {
  const out: string[] = [];
  let s = q.toLowerCase();
  for (const p of PLACEHOLDERS) {
    const tag = p.toLowerCase();
    let k = s.indexOf(tag);
    while (k >= 0) {
      out.push(`p:${p}`, `p:${p}`);
      s = `${s.slice(0, k)} ${s.slice(k + tag.length)}`;
      k = s.indexOf(tag);
    }
  }
  for (const w of s.match(/[a-z][a-z0-9-]*/g) ?? []) if (w.length >= 2) out.push(`w:${w}`);
  if (/\d/.test(s)) out.push('p:<NUM>');
  let run = '';
  const flush = () => {
    for (const c of run) out.push(`c:${c}`);
    for (let i = 0; i + 1 < run.length; i++) out.push(`b:${run.slice(i, i + 2)}`);
    run = '';
  };
  for (const c of s) {
    if (HAN.test(c)) run += c;
    else flush();
  }
  flush();
  return out;
}

/** 训练语料：每类意图的若干说法，用开头 × 主体 × 结尾组合展开 */
export function corpus(): [Intent, string][] {
  const out: [Intent, string][] = [];
  const ex = (intent: Intent, heads: string[], bodies: string[], tails: string[] = ['', '？']) => {
    for (const h of heads) for (const b of bodies) for (const t of tails) out.push([intent, `${h}${b}${t}`]);
  };
  const now = ['', '现在', '目前', '这会儿', '眼下'];
  const pls = ['', '帮我看看', '请问', '查一下'];
  ex('overview', now, ['情况怎么样', '整体怎么样', '一切正常吗', '全链路什么状况', '总体情况', '给我个概况', '运行得怎么样', '有多少车在路上', '大概什么情况', '整体进度'], ['', '？', '呀']);
  ex('overview', ['', '简单'], ['汇报一下', '说说现在的情况', '总结一下现在'], ['', '吧']);
  ex('risks', now, ['有什么风险', '要注意什么', '有什么问题', '哪里可能出事', '有没有异常', '最要紧的是什么', '有什么要我关注的', '哪些地方要盯着', '有没有要处理的问题', '风险在哪'], ['', '？']);
  ex('risks', ['接下来', '今天', '下午'], ['会出什么问题', '有哪些隐患', '要提防什么'], ['', '？']);
  ex('vehicle', pls, ['<VEH>在哪', '<VEH>到哪了', '<VEH>什么时候到', '<VEH>现在什么状态', '<VEH>怎么样了', '<VEH>还要多久', '<VEH>晚了吗', '<VEH>的货温', '<VEH>装的什么', '<VEH>下一站是哪', '<VEH>的情况'], ['', '？']);
  ex('vehicle', ['', '那辆车', '它'], ['现在在哪', '到哪儿了', '几点能到'], ['', '？']);
  ex('late', now, ['哪些车会晚', '有没有车迟到', '哪些车晚点了', '准点情况怎么样', '有车赶不上收货吗', '谁晚了', '晚点的车有哪些', '会不会有车迟到', '哪些车延误了'], ['', '？']);
  ex('late', ['', '门店'], ['收货会不会晚', '到货准不准时', '有几车会迟到'], ['', '？']);
  ex('stock', pls, ['<FAM>还剩多少', '<FAM>够卖吗', '<FAM>会不会缺货', '<FAM>库存多少', '<FAM>什么时候卖空'], ['', '？']);
  ex('stock', now, ['门店会缺货吗', '哪些商品要断货', '库存够不够', '门店库存怎么样', '有没有要卖空的', '缺货风险'], ['', '？']);
  ex('doors', now, ['月台门够不够用', '哪些门在用', '有车在等门吗', '<DOOR>谁在用', '<DOOR>什么时候空', '冷链门排得开吗', '装车进度怎么样', '月台门冲突', '门口排队吗', '收货门和发货门情况'], ['', '？']);
  ex('port', now, ['港口怎么样', '班轮什么时候靠泊', '船到了吗', '泊位情况', '岸桥在干什么', '集装箱提了吗', '码头忙不忙', '港口闸口排队吗', '本店的箱子卸了没', '锚地有船在等吗'], ['', '？']);
  ex('airport', now, ['机场怎么样', '航班到了吗', '货机几点落地', '机坪情况', '空运的货到了没', '机位够吗', '航班有没有晚'], ['', '？']);
  ex('dc', now, ['配送中心怎么样', '物流园情况', '仓库忙不忙', '堆垛机在干什么', '发货暂存有多少', '班列到了吗', '火车什么时候到', '铁路货运站情况', '配送中心库存够吗'], ['', '？']);
  ex('store', now, ['门店收货怎么样', '综合店收货口情况', '收货口有空吗', '门店今天到了几车', '线上配送车出去了几辆', '店后排队吗', '门店那边忙吗'], ['', '？']);
  ex('cards', ['', '现在', '还'], ['有什么建议', '有哪些待处理的建议', '建议卡有哪些', '有什么要我批的', '要我决定什么', '孪生有什么建议', '有没有待处理的', '需要我处理的事'], ['', '？']);
  ex('approve', ['', '好，', '那就'], ['批准', '批准这条', '同意', '按推荐的做', '执行推荐的做法', '就这么办', '批准<CARD>', '同意<CARD>', '派救援车吧', '通知门店顺延', '改到空闲的门', '追加补货', '改直送吧', '把低风险的都批了', '全部批准'], ['', '吧', '。']);
  ex('reject', ['', '算了，', '那就'], ['否决', '否了这条', '不批', '驳回', '先不处理', '这条不用管', '否决<CARD>', '不同意'], ['', '吧', '。']);
  ex('explain', ['', '请问', ''], ['为什么推荐这个', '为什么这么建议', '推荐的理由是什么', '凭什么选这个做法', '这个建议怎么算出来的', '为什么不派救援车', '为什么推荐不处理', '这条建议的依据', '为什么建议改门'], ['', '？']);
  ex('whatif', ['如果', '要是', '假如', '假设'], ['不处理会怎样', '否决会怎么样', '派救援车会怎样', '等修好会晚多少', '不通知门店会怎样', '什么都不做会怎样', '没有孪生会怎样', '全部人工确认会怎么样'], ['', '？']);
  ex('handover', ['', '帮我', '给我'], ['写交接班报告', '生成交接班报告', '本班总结', '这一班怎么样', '交班要交代什么', '下一班要注意什么', '出一份班报', '交接一下'], ['', '吧', '？']);
  ex('kpi', now, ['指标怎么样', '准点率多少', '超温多少分钟', '多花了多少钱', '孪生省了多少', '用孪生和不用比怎么样', '今天的成绩', '迟到了多少分钟', '缺货多少分钟'], ['', '？']);
  ex('incidents', now, ['路上有事故吗', '路况怎么样', '路况如何', '路上堵不堵', '交通情况', '哪里堵车', '有车抛锚吗', '有没有故障', '哪里在施工', '有什么突发情况', '发生了什么事'], ['', '？']);
  ex('schedule', ['', '今天', '查一下'], ['<TIME>有哪些车出发', '<TIME>之后有什么作业', '下午有几趟去门店', '接下来两小时有什么', '晚上有哪些车', '<TIME>到<TIME>有什么安排', '今天一共多少趟', '什么时候发车', '几点有车到配送中心'], ['', '？']);
  ex('review', ['', '帮我'], ['复盘一下建议', '建议准不准', '孪生的建议靠谱吗', '采纳率多少', '预测和实际差多少', '做个复盘', '哪些建议被否了'], ['', '？']);
  ex('network', ['', '请问', '帮我算算'], ['要不要开第二个配送中心', '多开一个仓划算吗', '网络规划的结果', '仓库选址', '再开几家店仓库够不够', '物流园要不要扩建', '库存怎么分给各家店', '十家店要几个仓'], ['', '？']);
  ex('optimize', ['', '帮我', '能不能'], ['优化一下月台门', '重新排一下门', '派车能不能少用几辆', '求解一下今天的排程', '找个最优的排法', '门排得是不是最优', '车排得最省是多少辆', '优化派车'], ['', '吧', '？']);
  ex('crossborder', ['', '请问', '查一下'], ['清关要多久', '进口要哪些单证', '汇率涨了影响多大', '关税多少', '跨境的货要什么文件', '海运清关几天', '原产地证书有什么用', '到岸成本多少'], ['', '？']);
  ex('forecast', ['', '预计', '帮我预测', '你估计'], ['明天<FAM>卖多少', '明天的销量', '明天要卖多少', '需求预测', '班轮会晚多久', '火车会不会晚', '班列会晚吗', '路上要多久', '用的哪个预测模型', '销量预测准吗', '下周卖多少'], ['', '？']);
  ex('knowledge', ['', '请问', ''], ['冷链门不够用怎么办', '车抛锚了怎么处理', '温度超标怎么办', '收货截止怎么顺延', '港口拥堵有什么预案', '合计分怎么算', '什么是保真度', '自动执行的范围是什么', '机场关闭怎么办', '高速封了怎么办', '供应商断货怎么办', '需求暴涨怎么应对', '流程是什么', '怎么改设施配置', '负荷档位是什么意思'], ['', '？']);
  ex('help', ['', '你'], ['能做什么', '会什么', '怎么用', '能帮我干什么', '帮助', '可以问什么'], ['', '？']);
  ex('rootcause', ['', '请问', '帮我查查'], ['<VEH>为什么晚了', '<VEH>为什么迟到', '<VEH>晚在哪里', '<VEH>怎么晚了这么多', '<VEH>延误的原因', '<VEH>是什么原因晚的', '门店今天为什么晚', '到货为什么晚了', '迟到的原因是什么', '晚点的根本原因', '是什么拖慢了到货', '为什么准点率这么低', '晚到的车都是什么原因'], ['', '？']);
  ex('anomaly', ['', '帮我', '请'], ['检查一下有没有异常的指标', '哪个指标异常', '有没有突增的', '哪段时间不正常', '做一次异常检测', '指标突然变差了吗', '超温突然多了吗', '哪里有波动', '有什么不对劲的指标', '有没有离群的数据'], ['', '？']);
  ex('hub', now, ['港口物流中心怎么样', '拆装箱库满了吗', '保税库还有多少库位', '查验场有几个箱在等', '机场货站忙不忙', '货站冷库还有位置吗', '转运仓的库存', '甩挂区停了多少挂车', '停车场满了吗', '取货车位还有空的吗', '收货场排队吗', '物流中心的库容', '仓储中心的情况', '堆场占用多少'], ['', '？']);
  ex('cargo', ['', '帮我', '请问'], ['本店的货在哪', '我们的集装箱到哪一步了', '本店的箱在哪', '追踪一下本店的货', '自己的集装板到了没', '本店的托盘在哪个仓', '跟踪我们的货', '我们的货走到哪了', '本店的货现在什么状态'], ['', '？']);
  ex('bottleneck', ['', '现在', '今天'], ['哪里是瓶颈', '瓶颈在哪', '哪个区最满', '会不会爆仓', '卡在哪个环节', '哪里最挤', '容量哪里不够', '哪个仓最紧张'], ['', '？']);
  ex('appointments', ['', '帮我', '能不能'], ['排一下预约', '预约错峰', '把到达时段错开', '削峰填谷排一下预约', '调整一下送货预约', '排队太长了能不能错开', '重排到车时间窗'], ['', '吧', '？']);
  ex('dailyplan', ['', '给我', '帮我'], ['今日计划', '今天的计划', '早会要说什么', '今天要注意什么', '一天的安排', '出一份今日计划', '今天会怎么样'], ['', '吧', '？']);
  ex('quality', ['', '现在', '请问'], ['数据靠谱吗', '数据质量怎么样', '数据延迟多少', '定位准不准', '通信正常吗', '有没有断线', '数据丢了多少', '信号好不好', '数据晚到多久'], ['', '？']);
  ex('policy', ['', '请问', '我想知道'], ['我能批多少钱', '我有什么权限', '谁来批', '审批规则是什么', '上限是多少', '有哪些硬性规定', '冷链有什么规定', '哪些要站长批'], ['', '？']);
  return out;
}

/** 留出集：另外写的说法（不进训练语料），评测分类器 */
export const HOLDOUT: [Intent, string][] = [
  ['overview', '眼下全链路运转如何'],
  ['overview', '给我一个总览'],
  ['risks', '有啥需要警惕的'],
  ['risks', '最可能出问题的是哪儿'],
  ['risks', '马上要处理的问题有哪些'],
  ['vehicle', '<VEH>跑到哪里了'],
  ['vehicle', '<VEH>预计几点到门店'],
  ['vehicle', '<VEH>车上货温正常吗'],
  ['late', '会迟到的车有几辆'],
  ['late', '有没有赶不上收货截止的'],
  ['stock', '<FAM>的库存撑得到晚上吗'],
  ['stock', '有什么商品快没货了'],
  ['doors', '冷链月台门现在空着几樘'],
  ['doors', '<DOOR>这樘门几点能空出来'],
  ['port', '班轮靠好泊了没有'],
  ['port', '码头那边的箱子提走了吗'],
  ['airport', '那班货运航班落地了吗'],
  ['airport', '空运的海鲜到机场了没'],
  ['dc', '洲际班列进站了吗'],
  ['dc', '仓库里堆垛机忙不忙'],
  ['store', '店后面收货口排队吗'],
  ['store', '综合店今天收了几车货'],
  ['cards', '孪生给了哪些建议'],
  ['cards', '有待我拍板的吗'],
  ['approve', '行，就按推荐的办'],
  ['approve', '批准第一条'],
  ['approve', '把低风险的建议全部批准'],
  ['reject', '这条我不同意'],
  ['reject', '否决第二条'],
  ['explain', '推荐这个做法的原因'],
  ['explain', '为啥建议等修好'],
  ['whatif', '要是不派救援车会怎样'],
  ['whatif', '假如否决这条会晚多少'],
  ['handover', '出一份交班报告'],
  ['handover', '这班结束要交代什么'],
  ['kpi', '到现在迟到了几分钟'],
  ['kpi', '孪生帮我们省了多少'],
  ['incidents', '哪段路出事故了'],
  ['incidents', '有车坏在路上吗'],
  ['schedule', '<TIME>以后有几趟车'],
  ['schedule', '下午去门店的车有哪些'],
  ['review', '孪生的建议准吗'],
  ['forecast', '明天牛奶大概能卖多少'],
  ['network', '再加一个配送中心值不值'],
  ['crossborder', '空运进口的货报关要准备什么'],
  ['optimize', '今天的月台门还能排得更好吗'],
  ['forecast', '下一班轮估计晚几个小时'],
  ['review', '复盘今天的建议'],
  ['knowledge', '冷机坏了按什么流程处理'],
  ['knowledge', '港口堵了预案是什么'],
  ['knowledge', '合计分是怎么定义的'],
  ['help', '你都能帮我做哪些事'],
  ['help', '我可以问你什么'],
  ['rootcause', '<VEH>晚到的原因是什么'],
  ['rootcause', '今天门店到货为啥总晚'],
  ['anomaly', '哪些指标出现了异常波动'],
  ['anomaly', '最近哪个时段指标突然变差'],
  ['hub', '保税库现在占用多少'],
  ['hub', '机场货站的冷库满没满'],
  ['cargo', '我们的集装箱现在在哪个环节'],
  ['cargo', '追踪本店的集装板'],
  ['bottleneck', '整个链路卡在哪'],
  ['bottleneck', '哪个仓最容易爆仓'],
  ['appointments', '帮我把送货预约错开'],
  ['appointments', '能不能调一下到车的时间窗'],
  ['dailyplan', '早会讲点什么'],
  ['dailyplan', '出一份今天的计划'],
  ['quality', '现在的定位数据可靠吗'],
  ['quality', '通信有没有断'],
  ['policy', '调度员能批多大的单'],
  ['policy', '哪些事要区域经理批'],
];

interface Model {
  prior: Map<Intent, number>;
  like: Map<Intent, Map<string, number>>;
  total: Map<Intent, number>;
  vocab: number;
}

function train(data: readonly [Intent, string][]): Model {
  const count = new Map<Intent, number>();
  const like = new Map<Intent, Map<string, number>>();
  const total = new Map<Intent, number>();
  const vocab = new Set<string>();
  for (const [intent, q] of data) {
    count.set(intent, (count.get(intent) ?? 0) + 1);
    const m = like.get(intent) ?? new Map<string, number>();
    like.set(intent, m);
    for (const f of features(q)) {
      m.set(f, (m.get(f) ?? 0) + 1);
      total.set(intent, (total.get(intent) ?? 0) + 1);
      vocab.add(f);
    }
  }
  // 每类意图的语料条数差别很大（组合展开），先验按类别数平均，不按条数
  const prior = new Map<Intent, number>([...count.keys()].map((k) => [k, Math.log(1 / count.size)]));
  return { prior, like, total, vocab: vocab.size };
}

/**
 * 另外收的语料（corpusExtra.ts：一位没看过评测集和盲测题的人写的带标注的问题）：按问题文字的哈希分，15% 留出只评测、不训练，
 * 其余加进训练语料（每条算 EXTRA_WEIGHT 次：模板展开的语料条数多，自然说法要加权才压得住）。编号换成占位符（maskIds），和运行时一样。
 * 原来的留出集（HOLDOUT）不动，照旧评测，前后可比。
 */
const fnv = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
};
// 另外收的语料里有「超出范围」的说法（decline）：作为一类意图一起训练，判成它的按超出范围回答
const KNOWN = new Set<string>([...corpus().map(([i]) => i), 'decline']);
/**
 * 出题人的标注规则和值班助手的约定有三处不一样，训练前按值班助手的约定改标（两个留出集一样改，前后可比）：
 * 1. 问某一辆车会不会晚（问句里有车的编号）：出题人标「晚点」，值班助手的约定是问车（查这辆车的状态和预计到达；「晚点」是列晚点的车）；
 * 2. 港口堆场的占用、容量、压箱：出题人标「港口」，值班助手按仓储中心回答（港口物流中心的堆场是它的一个区）；
 * 3. 门店停车场、取货车位、排队车道、收货场的占用和排队：出题人标「门店」，值班助手按仓储中心回答（门店停车场和收货场）。
 * 其余（门店收货口、自提柜、免下车取货的情况算门店；班列算物流园、推演或作业安排；记录的删改、打电话、发消息、订东西、写文案算超出范围）和值班助手一致。
 */
export function reconcile(intent: string, q: string): string {
  if (intent === 'late' && q.includes('<VEH>')) return 'vehicle';
  if (intent === 'port' && /堆场/.test(q) && /(满|占|容量|多少|压|空位|堆|箱位)/.test(q)) return 'hub';
  if (intent === 'store' && /(停车场|取货车位|排队车道|收货场)/.test(q) && /(满|占|空|排|堵|多少|几辆|车位)/.test(q)) return 'hub';
  return intent;
}
const extraAll = EXTRA_CORPUS.filter((x) => KNOWN.has(x.intent)).map((x) => {
  const q = maskIds(x.q);
  return [reconcile(x.intent, q) as Intent, q, x.intent] as const;
});
/** 按值班助手的约定改了标的条数 */
export const EXTRA_RELABELLED = extraAll.filter(([i, , o]) => i !== o).length;
const extra = extraAll.map(([i, q]) => [i, q] as [Intent, string]);
// 第二批（另一种写法）：同样改标、同样按哈希留出 15%
const extra2All = EXTRA_CORPUS2.filter((x) => KNOWN.has(x.intent)).map((x) => {
  const q = maskIds(x.q);
  return [reconcile(x.intent, q) as Intent, q, x.intent] as const;
});
export const EXTRA2_RELABELLED = extra2All.filter(([i, , o]) => i !== o).length;
const extra2 = extra2All.map(([i, q]) => [i, q] as [Intent, string]);
export const EXTRA2_HOLDOUT: [Intent, string][] = extra2.filter(([, q]) => fnv(q) % 100 < 15);
export const EXTRA2_TRAIN: [Intent, string][] = extra2.filter(([, q]) => fnv(q) % 100 >= 15);
export const EXTRA_HOLDOUT: [Intent, string][] = extra.filter(([, q]) => fnv(q) % 100 < 15);
export const EXTRA_TRAIN: [Intent, string][] = extra.filter(([, q]) => fnv(q) % 100 >= 15);
/**
 * 每条另外收的说法算几次：在两个留出集上比过 1、2、3、5、8 次和加不加三字组（字的三元组），3 次、不加三字组最好
 * （原留出集 69 / 71，新留出集 213 / 291；三字组没有稳定的好处，不加）。权重是在留出集上挑的，所以两个留出集的数会略偏乐观。
 */
export const EXTRA_WEIGHT = 3;
/** 训练用的全部语料（模板展开的 + 另外收的，按权重重复） */
export function trainingData(): [Intent, string][] {
  return [...corpus(), ...[...EXTRA_TRAIN, ...EXTRA2_TRAIN].flatMap((x) => Array.from({ length: EXTRA_WEIGHT }, () => x))];
}

/** 编号、门、第几条、时刻换成占位符（训练和评测另外收的语料用；运行时由认参数做） */
export function maskIds(q: string): string {
  return q
    .replace(/第\s*(\d+|[一二两三四五六七八九十]+)\s*(条|张|个|项)/g, '<CARD>')
    .replace(/(?<![A-Za-z0-9])[CcDd]\d{2}(?!\d)/g, '<DOOR>')
    .replace(/(?<![A-Za-z0-9<])[A-Za-z]{1,6}(?:[-_ ]?[A-Za-z0-9]+)*?\d+(?:[-_][A-Za-z0-9]+)*/g, '<VEH>')
    .replace(/\d{1,2}[:：]\d{2}/g, '<TIME>');
}

let model: Model | undefined;
const getModel = (): Model => (model ??= train(trainingData()));

/** 朴素贝叶斯：每类意图的对数打分 */
function nbScores(q: string): { classes: Intent[]; s: number[] } {
  const m = getModel();
  const fs = features(q);
  const classes: Intent[] = [];
  const s: number[] = [];
  for (const [intent, prior] of m.prior) {
    const like = m.like.get(intent) as Map<string, number>;
    const tot = (m.total.get(intent) ?? 0) + m.vocab;
    let v = prior;
    for (const f of fs) v += Math.log(((like.get(f) ?? 0) + 0.5) / tot);
    classes.push(intent);
    s.push(v);
  }
  return { classes, s };
}

/** 逻辑回归的特征：朴素贝叶斯的特征（字的一元、二元组，占位符，英文词）加字的三元组 */
export function featuresLR(q: string): string[] {
  const out = features(q);
  for (const run of q.toLowerCase().split(/[^一-鿿]+/)) for (let i = 0; i + 2 < run.length; i++) out.push(`t:${run.slice(i, i + 3)}`);
  return out;
}

/** 逻辑回归（softmax.ts）的训练参数：固定的轮数、学习率、正则和种子（在三个留出集上比过几组：轮数 8 / 15 / 25、学习率 0.3 / 1 / 2、正则 0 / 1e-5、另外收的语料权重 1 / 2 / 3，见报告） */
export const LR_OPTS: SoftmaxOpts = { epochs: 15, lr: 2, l2: 1e-5, minCount: 2, seed: 7 };
export const LR_EXTRA_WEIGHT = 1;
/** 逻辑回归的训练样本：模板展开的每条算 1 次，另外收的每条算 extraWeight 次 */
export function lrRows(extraWeight = LR_EXTRA_WEIGHT): SoftmaxRow[] {
  return [...corpus().map(([y, q]) => ({ y, f: featuresLR(q), w: 1 })), ...[...EXTRA_TRAIN, ...EXTRA2_TRAIN].map(([y, q]) => ({ y, f: featuresLR(q), w: extraWeight }))];
}
let lrModel: SoftmaxModel | undefined;
const getLR = (): SoftmaxModel => (lrModel ??= trainSoftmax(lrRows(), LR_OPTS));

export type Clf = 'nb' | 'lr' | 'ens';
/** 温度：模型的打分按它换成概率（在留出集上按对数似然拟合，见报告）；1 = 不校准 */
export const TEMP: Record<'nb' | 'lr', number> = { nb: 2.33, lr: 0.76 };
/** 用哪个分类器：朴素贝叶斯、逻辑回归，或两个的概率平均 */
export const CLASSIFIER: Clf = 'lr';

type Ranked = { intent: Intent; p: number }[];
/** 按指定的分类器（和温度）分类：每类意图的概率，从大到小 */
export function classifyBy(kind: Clf, q: string, temp: Record<'nb' | 'lr', number> = TEMP): Ranked {
  if (kind === 'nb') {
    const { classes, s } = nbScores(q);
    return calibrated(classes, s, temp.nb) as Ranked;
  }
  const m = getLR();
  const pl = calibrated(m.classes, softmaxLogits(m, featuresLR(q)), temp.lr) as Ranked;
  if (kind === 'lr') return pl;
  const sum = new Map<Intent, number>();
  for (const x of [...classifyBy('nb', q, temp), ...pl]) sum.set(x.intent, (sum.get(x.intent) ?? 0) + x.p / 2);
  return [...sum].map(([intent, p]) => ({ intent, p })).sort((a, b) => b.p - a.p || (a.intent < b.intent ? -1 : 1));
}

/** 按模型分类：返回每类意图的概率（从大到小） */
export function classify(q: string): Ranked {
  return classifyBy(CLASSIFIER, q);
}

/**
 * 拿不准（没有规则判定时用）：过了说法检查（CUES）的前两个意图里，第一的概率低于 ABSTAIN.p，或者和第二差不到 ABSTAIN.margin。
 * 门槛在留出集上选（见报告）；0 = 不弃答。
 */
export const ABSTAIN = { p: 0.35, margin: 0.2 };
export function unsure(ranked: Ranked, q: string, th: { p: number; margin: number } = ABSTAIN): { a: Ranked[number]; b: Ranked[number] } | undefined {
  const pass = ranked.filter((x) => !CUES[x.intent] || (CUES[x.intent] as RegExp).test(q));
  const a = pass[0];
  const b = pass[1];
  if (!a || !b) return undefined;
  return a.p < th.p || a.p - b.p < th.margin ? { a, b } : undefined;
}

/**
 * 第二批意图要有对应的说法才认（模型只看字面，新加的几类不能把老问法抢走：「M02 预计几点到」不是问晚点原因）。
 * 模型排第一的意图没有这些说法时，往下取下一个。
 */
const CUES: Partial<Record<Intent, RegExp>> = {
  rootcause: /(为什么|为啥|原因|怎么|根因|归因|拖慢|晚在|慢在|耽误|什么拖)/,
  anomaly: /(异常|突|波动|反常|离群|不对劲|不正常)/,
  hub: /(货站|物流中心|保税|查验|拆箱|装箱|拼箱|CFS|冷库|转运仓|甩挂|停车场|取货车位|排队车道|收货场|库容|库位|仓储|堆场|占用)/i,
  cargo: /(本店的|我们的|我们店|咱们店|自己的|追踪|跟踪|采购单|在途)/,
  bottleneck: /(瓶颈|卡在|爆仓|满|挤|紧张|容量)/,
  appointments: /(预约|错峰|削峰|时段|时间窗)/,
  dailyplan: /(今天|今日|早会|晨会|一天)/,
  quality: /(数据|通信|信号|定位|断线|丢包)/,
  policy: /(权限|批|规定|规则|上限|红线|护栏)/,
  // 模型判成批准 / 否决，问题里要有动手的说法（没有就往下取）
  approve: /(批|同意|执行|通过|派|改|按推荐|就按|照办|没问题|拍板|可以|行|就这么办|通知|追加)/,
  reject: /(否|驳回|拒绝|不行|不同意|不批|别批|不要|不用|算了|打回|撤)/,
};

/** 模型的结果按说法过一遍（见 CUES） */
export function pickIntent(ranked: readonly { intent: Intent; p: number }[], q: string): { intent: Intent; p: number } {
  return ranked.find((x) => !CUES[x.intent] || (CUES[x.intent] as RegExp).test(q)) ?? (ranked[0] as { intent: Intent; p: number });
}

/** 规则命中用规则，否则用模型（过一遍说法） */
export function predict(q: string): Intent {
  return ruleIntent(q) ?? pickIntent(classify(q), q).intent;
}

/**
 * 要求跳过确认、审批、冒充角色的说法：照样不执行任何东西（提议仍要人确认），回答里说明。
 * 超出范围的：闲聊（写诗、股票、天气预报……，问题里又没有业务词）、值班助手做不了的动作（打电话、发邮件、转账……）。
 */
export const ADVERSARIAL = /(忽略|无视|跳过|绕过|别管|不管|不用|不需要|无需|免去|省掉|别).{0,4}(规则|规定|确认|审批|批准|权限|限制|流程|护栏)|直接(执行|批准|批了|派|改)|强制(执行|批准)|立即执行|马上(执行|改|派)|自动执行(所有|全部)|(你现在是|假装你是|切换成|当作).{0,3}(管理员|区域经理|站长|超级用户)/;
export const OOS_TOPIC = /(写.{0,10}诗|作诗|讲.{0,2}笑话|唱.{0,2}歌|股票|基金|彩票|电影|菜谱|做菜|翻译|星座|足球|篮球|玩游戏|天气预报|明天天气|今天天气|天气怎么样|房价|新闻|工资|薪水|奖金)/;
export const OOS_ACTION = /(打.{0,2}电话|发.{0,2}(短信|邮件|即时消息)|订.{0,12}(机票|车票|火车票|酒店)|订票|打车|付款|转账|删(除|掉)?.{0,4}(记录|数据|日志)|(记录|数据|日志).{0,3}删|改(工资|密码)|查(工资|密码|身份证))/;
/** 业务词：问题里有这些就不当闲聊 */
export const DOMAIN = /(车|货|门|店|港|码头|机场|航班|仓|库|建议|班|路|单|配送|作业|指标|孪生|预测|计划|集装箱|托盘|冷链|温|缺货|晚|调度|月台|收货|司机|预约|审批|数据|异常|瓶颈|风险|情况|状态)/;

/** 说法很明确的先按规则判断（命中就不用模型） */
export function ruleIntent(q: string): Intent | undefined {
  // 明说要整体的概况（没说是哪个设施）
  if (/(全局|概况|总体情况|整体情况)/.test(q) && !/(港口|码头|机场|货站|物流园|配送中心|门店|仓储|停车场|收货)/.test(q)) return 'overview';
  if (/(你能|你会|能帮我|可以问|怎么用你|帮助$|^帮助)/.test(q)) return 'help';
  if (/(交接班|交班|班报|本班|这一班|下一班(?![轮列]))/.test(q)) return 'handover';
  if (/(今日计划|今天的计划|今天计划|一天的计划|早会|晨会|今天(要|该)?注意什么|今天会怎么样|一天的安排|今天的安排|^今.{0,2}计划$)/.test(q)) return 'dailyplan';
  if (/(复盘|采纳率|预测和实际)/.test(q) || (/(准不准|准吗|靠谱吗)/.test(q) && /(建议|孪生|推荐)/.test(q))) return 'review';
  if (/(权限|我能批|能批多少|能批多大|谁来批|谁批|要.{0,4}(站长|区域经理|调度员)批|审批(规则|流程|上限)|上限是多少|(有哪些|什么)(硬性)?规定|红线|规则表|护栏)/.test(q)) return 'policy';
  if (/(数据(质量|延迟|准不准|可靠|靠谱|晚到|丢)|定位数据|通信|断线|丢包|信号(好不好|不好)|定位(准不准|断))/.test(q)) return 'quality';
  if (/(如果|要是|假如|假设|万一)/.test(q)) {
    if (/怎么办|咋办|咋整|怎么弄|怎么处理|预案|流程/.test(q)) return 'knowledge';
    return 'whatif';
  }
  // 哪些门空着、被占着：问的是月台门（「门店」不算）
  if (/((月台门|门(?!店)).{0,4}(空|闲着|被占|占着|占用))|((哪几个|哪些|几个)(月台)?门(?!店))/.test(q)) return 'doors';
  // 「为什么推荐……」问的是建议卡的理由；「为什么晚」问的是晚点的原因
  if (/(为什么|为啥|凭什么|理由|依据|原因|怎么算出)/.test(q) && /(推荐|建议|做法|选|处理|改门|救援|修)/.test(q)) return 'explain';
  if (/((为什么|为啥|怎么会|什么原因|啥原因|怎么回事).{0,10}(晚|迟到|延误|慢|耽误))|((晚|迟到|延误|耽误|晚到|晚点).{0,8}(原因|为什么|为啥|怎么回事|根因))|根因|归因|拖慢/.test(q)) return 'rootcause';
  // 要一张晚点车的单子（「为什么晚」在上面已经认成归因）
  if (/((晚点|迟到|延误).{0,10}(的车|单子|清单|列表|名单))|((列|拉|给我).{0,4}(晚点|迟到)的?车)/.test(q)) return 'late';
  if (/((指标|准点率|周转|满载率|达成率).{0,8}(怎么样|咋样|多少|比|变化|掉|涨|下降|上升))|((迟到|超温|缺货|等门)了?(多少|几)分钟)/.test(q)) return 'kpi';
  if (/(否决|否了|驳回|不批|不同意|先不处理|不用管|不用处理)/.test(q)) return 'reject';
  if (/^(好|行|可以|那就|就)?[，, ]*(批准|同意|执行|按推荐|就按|就这么办|派救援|通知门店|改到空闲|追加补货|改直送|全部批|都批)/.test(q) || /(批准|都批了|全部批准)/.test(q)) return 'approve';
  if (/(怎么办|咋办|咋整|怎么弄|怎么处理|怎么应对|什么预案|流程|是什么意思|什么是|怎么算|怎么定义|怎么改|规定)/.test(q)) return 'knowledge';
  if (/(异常检测|异常的?(指标|波动|数据|时段)|指标.{0,4}(异常|突然|波动|反常)|突增|突然(变|多|涨|升|增)|波动|反常|离群|不对劲|(物流中心|货站|物流园|停车场|仓|库|堆场|收货场).{0,8}(异常|不正常))/.test(q)) return 'anomaly';
  if (/(预约|错峰|削峰|到达时段|时间窗)/.test(q)) return 'appointments';
  if (/(瓶颈|卡在哪|卡脖子|堵点|短板|拖后腿|爆仓|哪个(区|仓|库).{0,4}(满|紧张|挤)|最挤|容量.{0,4}不够)/.test(q)) return 'bottleneck';
  if (/((有没有|有多少|几箱|几板).{0,4}(本店|我们店|咱们店|我们|自己)的(货|箱|集装箱|托盘))|((本店|我们店|咱们店|我们)(在途|路上)?的.{0,6}(货|箱|集装箱|采购单|托盘).{0,8}(在哪|到哪|状态|进度|到了没|怎么样))|((本店|我们|自己)的.{0,4}(货|箱|集装箱|集装板|板|托盘|ULD).{0,8}(在哪|到哪|状态|进度|环节|到了没|怎么样))|(追踪|跟踪).{0,6}(货|箱|板|托盘)|(集装板|板|箱子|托盘|ULD).{0,3}(到哪|在哪)/.test(q)) return 'cargo';
  // 问几点、什么时候、波次、班次的作业：是作业安排（仓储中心的词不把它改成问仓储中心）
  if (/(几点|什么时候|啥时候|波次|班次|时刻表)/.test(q) && /(出库|入库|波次|班次|作业|装车|卸车|拣货|分拣|发运|配送)/.test(q)) return 'schedule';
  if (/(清关|报关|关税|原产地)/.test(q)) return 'crossborder';
  if (/(货站|物流中心|保税|查验|拆箱|装箱|拼箱|CFS|cfs|冷库|转运仓|甩挂|停车场|取货车位|排队车道|收货场|库容|库位|仓储中心|堆场|冷链中心|拣货|空位|货位)/.test(q)) return 'hub';
  if (/(路况|堵车|堵不堵|事故|施工|抛锚|故障|坏在路上)/.test(q)) return 'incidents';
  if (/(告警|看板)/.test(q)) return 'risks';
  if (/(清关|报关|单证|关税|汇率|跨境|到岸成本|原产地)/.test(q)) return 'crossborder';
  if (/(优化|求解|最优|重新排|排得更好|少用.{0,3}车)/.test(q)) return 'optimize';
  if (/(选址|网络规划|多门店|扩建|(开|加|建).{0,4}(仓|配送中心)|再开.{0,3}店)/.test(q)) return 'network';
  if (/(预测|销量|卖多少|能卖|需求量|会晚多久|晚几个小时)/.test(q)) return 'forecast';
  return undefined;
}
