/**
 * 演示门店的操作规范（本地助手检索用）。内容与工作流设计文档一致，按「遇到什么情况 → 怎么做」写，中英文对照。
 * 这是通用做法的整理，不对应任何零售商的内部规定。
 */

export interface SopEntry {
  id: string;
  tags: string[];
  zh: { title: string; text: string };
  en: { title: string; text: string };
}

/** 新人带教的小测验（决策记录 0024 · D4）：每题的问题、选项和正确答案的序号，中英文对照 */
export interface SopQuiz {
  q: { zh: string; en: string };
  options: Array<{ zh: string; en: string }>;
  answer: number;
}

export const SOP_QUIZ: Record<string, SopQuiz[]> = {
  'cold-chain': [
    {
      q: { zh: '冷链批次从什么时候开始计时？', en: 'When does the cold-chain clock start?' },
      options: [
        { zh: '领取批次时', en: 'When the walk is claimed' },
        { zh: '第一件冷藏 / 冷冻商品放进框时', en: 'When the first chilled or frozen item goes in a tote' },
        { zh: '到暂存区时', en: 'When reaching staging' },
      ],
      answer: 1,
    },
    {
      q: { zh: '超时了先做什么？', en: 'What do you do first when the limit is passed?' },
      options: [
        { zh: '把已拣的冷藏 / 冷冻框送回同温区的暂存格位', en: 'Take the picked chilled / frozen totes to a staging slot of the same zone' },
        { zh: '继续拣完再说', en: 'Finish picking first' },
        { zh: '放到常温格位', en: 'Put them in an ambient slot' },
      ],
      answer: 0,
    },
  ],
  'age-check': [
    {
      q: { zh: '顾客无法出示证件时怎么办？', en: 'What if the customer cannot show ID?' },
      options: [
        { zh: '整单拒交', en: 'Refuse the whole order' },
        { zh: '取出年龄限制商品，其余照常交付', en: 'Remove the age-restricted items and hand off the rest' },
        { zh: '先交付，之后补核验', en: 'Hand off now and check later' },
      ],
      answer: 1,
    },
  ],
  'code-failed': [
    {
      q: { zh: '验证码最多可以试几次，之后怎么办？', en: 'How many code attempts, and then what?' },
      options: [
        { zh: '3 次，之后核对姓名和订单短号人工核验', en: '3, then verify manually with the name and order short code' },
        { zh: '不限次数', en: 'Unlimited' },
        { zh: '1 次，之后取消订单', en: '1, then cancel the order' },
      ],
      answer: 0,
    },
  ],
  'staging-full': [
    {
      q: { zh: '冷冻格位满了，可以先放到冷藏格位吗？', en: 'Frozen slots are full — can you use a chilled slot?' },
      options: [
        { zh: '可以，临时放一下', en: 'Yes, temporarily' },
        { zh: '不可以，只能放同温区的其他格位，并告诉带班负责人', en: 'No — use another slot of the same zone and tell the team lead' },
      ],
      answer: 1,
    },
  ],
};

export const SOP: SopEntry[] = [
  {
    id: 'cold-chain',
    tags: ['冷链', '冷藏', '冷冻', 'cold', 'frozen', 'chilled'],
    zh: { title: '冷链时限', text: '冷藏 / 冷冻批次从第一件商品放进框开始计时，超过时限系统会提醒。超时后先把已拣的冷藏 / 冷冻框送回对应温区的暂存格位，再继续拣剩下的。' },
    en: { title: 'Cold-chain limit', text: 'Chilled and frozen walks are timed from the first item placed in a tote, and the app alerts when the limit is passed. If it is exceeded, take the picked chilled or frozen totes back to a staging slot of the right zone first, then continue.' },
  },
  {
    id: 'staging-full',
    tags: ['暂存', '满', '格位', 'staging', 'full', 'slot'],
    zh: { title: '暂存格位满了', text: '同温区的格位满了时，放到同温区的其他格位并扫描格位确认，系统会记下位置，交付时照样能找到；不要放到别的温区。冷冻格位紧张时，提醒带班负责人临时调整或尽快交付已到达的订单。' },
    en: { title: 'Staging slots are full', text: 'If the slots for a temperature zone are full, use another slot of the same zone and scan it so the system records the location; never use another zone. If frozen slots are tight, tell the team lead so they can adjust or hand off arrived orders first.' },
  },
  {
    id: 'code-failed',
    tags: ['验证码', '核验', '取货码', 'code', 'verify', 'pickup code'],
    zh: { title: '验证码不对', text: '验证码最多尝试 3 次。超过后改为人工核验：核对顾客姓名和订单短号，必要时请顾客出示订单页面，由交付员确认后完成交付。' },
    en: { title: 'Pickup code does not match', text: 'Up to 3 code attempts are allowed. After that, switch to manual verification: check the customer name and order short code, ask for the order screen if needed, and confirm before completing the handoff.' },
  },
  {
    id: 'age-check',
    tags: ['年龄', '酒', '身份证', 'age', 'id', 'alcohol'],
    zh: { title: '年龄限制商品', text: '订单里有年龄限制商品（例如酒类）时，交付前必须核验顾客证件。无法核验时，把这些商品取出放回，其余商品照常交付，系统会记录。' },
    en: { title: 'Age-restricted items', text: 'If the order has age-restricted items (for example alcohol), check the customer’s ID before handing off. If it cannot be verified, remove those items and hand off the rest; the system records it.' },
  },
  {
    id: 'substitution',
    tags: ['替代', '缺货', '找不到', 'substitute', 'substitution', 'out of stock'],
    zh: { title: '替代商品', text: '只有顾客下单时允许替代的商品才能替代。找不到时先看 AI 推荐的替代品（显示预计顾客接受的概率和理由），选一件扫描放进框；不允许替代时，转后仓补取（后仓有货时）或标记缺货。' },
    en: { title: 'Substitutions', text: 'Substitute only items the customer allowed. When an item is missing, check the AI-ranked substitutes (with the expected acceptance and reasons), scan one into the tote; if substitution is not allowed, send it to a backroom pick (if the backroom has stock) or mark it short.' },
  },
  {
    id: 'exception',
    tags: ['后仓补取', 'exception', '后仓', 'backroom pick'],
    zh: { title: '后仓补取', text: '只有永久授权的员工可以领取后仓补取。按系统列出的库位找箱子，扫描箱子确认找到，送到订单所在的暂存格位并扫描格位。没找到时点「没找到」，记录会被标为可疑并生成盘点任务。' },
    en: { title: 'Backroom pick (exception)', text: 'Only permanently authorized staff can claim backroom picks. Go to the listed bin, scan the case to confirm, take the item to the order’s staging slot and scan it. If not found, tap “Not found”: the record is flagged and a count task is created.' },
  },
  {
    id: 'cancelled-order',
    tags: ['取消', '回收', 'cancel', 'recovery'],
    zh: { title: '订单被取消', text: '暂存扫描时提示订单已取消，把框送到回收专区并扫描确认，商品按规定退回货架或后仓。拣货开始前取消的订单，标签会自动作废。' },
    en: { title: 'Cancelled order', text: 'If staging says the order was cancelled, take the tote to the recovery area and scan it; items go back to the shelf or backroom. Labels of orders cancelled before picking started are voided automatically.' },
  },
  {
    id: 'label-reprint',
    tags: ['标签', '重打', 'label', 'reprint'],
    zh: { title: '标签损坏或丢失', text: '在拣货页面重打标签：旧标签立即作废，新标签带新的版本号，扫描旧标签会被拒绝。' },
    en: { title: 'Damaged or lost label', text: 'Reprint from the pick screen: the old label is voided immediately and the new one carries a new version; scanning the old label is rejected.' },
  },
  {
    id: 'receiving-discrepancy',
    tags: ['收货', '差异', '短少', '多出', 'receiving', 'discrepancy', 'asn'],
    zh: { title: '收货差异', text: '逐箱扫描原有条码收货，系统为每箱生成内部箱号并打印标签。关闭收货单时与到货通知比较，短少、多出、损坏会自动记录；有差异的商品之后会优先盘点。' },
    en: { title: 'Receiving discrepancies', text: 'Scan each case’s original barcode; the system creates an internal case ID and prints a label. Closing the receipt compares it with the advance notice and records short, over and damaged cases; those items are counted with priority later.' },
  },
  {
    id: 'damaged-case',
    tags: ['损坏', '破损', '待检', 'damaged', 'hold'],
    zh: { title: '损坏的箱子', text: '收货或上架时发现损坏，标记为损坏，箱子进入待检状态，放到待检库位，不能用于补货或后仓补取。' },
    en: { title: 'Damaged case', text: 'Mark damaged cases when receiving or putting away; they go on QA hold in a hold bin and cannot be used for restocks or backroom picks.' },
  },
  {
    id: 'chemicals',
    tags: ['化学品', '隔离', '清洁剂', 'chemical', 'isolation'],
    zh: { title: '化学品隔离', text: '化学品不能和食品放在同一个框或同一个后仓库位。系统分框时自动分开，上架时如果库位冲突会拒绝并提示。' },
    en: { title: 'Chemical isolation', text: 'Chemicals never share a tote or a backroom bin with food. Totes are split automatically, and put-away rejects a conflicting bin.' },
  },
  {
    id: 'shelf-empty',
    tags: ['货架空', '补货', '缺货', 'shelf', 'empty', 'restock'],
    zh: { title: '货架空了', text: '拣货时找不到会自动通知补货；补货员领取同一通道的一批任务，到后仓取箱，扫描货位后输入上架件数，剩余的放回原库位。' },
    en: { title: 'Empty shelf', text: 'A missing item at pick time triggers a restock automatically; the restocker claims an aisle batch, takes a case from the backroom, scans the location, enters the units placed, and returns the rest to its bin.' },
  },
  {
    id: 'shelf-check',
    tags: ['核对', '幽灵库存', '货架', 'shelf check', 'phantom'],
    zh: { title: '核对货架', text: 'AI 发现「系统显示有货、但一直没有卖出」时会生成核对任务：到货位扫描标签，数一数货架上实际有几件（包括被挡住的）并提交；为 0 时系统会自动安排补货。' },
    en: { title: 'Shelf check', text: 'When the AI sees an item that should be on the shelf but has stopped selling, it creates a check: scan the location, count what is actually there (including hidden units) and submit; zero triggers a restock.' },
  },
  {
    id: 'late-customer',
    tags: ['顾客', '迟到', '早到', '等待', 'late', 'early', 'wait'],
    zh: { title: '顾客早到或晚到', text: '交付看板按到达先后服务，预计到达只用来提前准备。顾客点「我在路上」后，系统会按 AI 修正的到达时间提醒「即将到达」；顾客等待过久时看板变红。' },
    en: { title: 'Early or late customers', text: 'The handoff board serves in arrival order; ETAs are only used to prepare early. After a customer taps “On my way”, the board shows “approaching” based on the AI-corrected arrival time; it turns red when a wait is too long.' },
  },
  {
    id: 'staff-move',
    tags: ['调人', '调动', '人手', 'move', 'staff', 'dispatch'],
    zh: { title: '临时调动', text: 'AI 会在交付排队或拣货积压时建议调一个人，带班负责人采纳后员工端会自动切到新岗位。被固定的员工不会被建议调动；也可以在「AI → 模式与统计 → 人员」里手动调动或恢复。' },
    en: { title: 'Temporary moves', text: 'The AI suggests moving one person when the handoff queue or the pick backlog grows; once the team lead accepts, the associate app switches to the new role. Pinned staff are never suggested; leads can also move or restore people under AI → Modes & stats → Staff.' },
  },
];
