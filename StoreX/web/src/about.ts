import { storex, storex2030 } from '../../src/world/config';

/** 「说明」页：StoreX 是什么、地图怎么看、员工和机器人怎么分工 */
export function renderAbout(el: HTMLElement): void {
  const s = storex();
  const y = storex2030();
  const lockers = (l: { ambient: number; chilled: number; frozen: number }) => `${l.ambient + l.chilled + l.frozen} 个格口（常温 ${l.ambient}、冷藏 ${l.chilled}、冷冻 ${l.frozen}）`;
  el.innerHTML = `
  <div class="about">
    <section>
      <h2>StoreX 是什么</h2>
      <p>一家面向 2030 年的中型超市的完整方案：门店布置、线上订单从下单到交付、货架补货、收货、结账、生鲜、能源，以及员工和机器人怎么分工。它在上一代方案（Storewright：员工用手机作业 + AI）的基础上重新设计，并用同一套离散事件仿真和上一代逐项对比。这个页面上的门店就是仿真本身：每个员工、机器人、顾客和货车都按仿真的结果移动。</p>
    </section>
    <section>
      <h2>一张订单怎么走</h2>
      <ul>
        <li>常温和冷藏的包装商品（约 3,600 种）存在后仓的<b>立体货格仓</b>里：机器人在货格顶上取出货箱送到站台，站台拣货员每行只要几秒钟。</li>
        <li>生鲜、冷冻和大件由<b>生鲜拣选员</b>推智能推车在卖场里拣，放到生鲜投放口，经输送线送到合流台。</li>
        <li>合流以后，<b>装柜机器人</b>把订单框放进分温区的自提柜（${lockers(s.pickup.lockers)}）；选免下车取货的顾客到了以后，<b>送框小车</b>把框送到车窗边。</li>
        <li>订单里有酒类等年龄限制商品时走免下车取货，由门店作业员核验身份；配送单在 10、13、16、19 点按班次装车。</li>
        <li>货格仓整体停机时可以<b>降级</b>：包装商品改由生鲜拣选员和门店作业员在卖场货架上拣（货架上也有这些商品）。可以在「孪生」页的「设备与演练」里试。</li>
      </ul>
    </section>
    <section>
      <h2>员工和机器人</h2>
      <ul>
        <li><b>开业（266 单 / 天）：</b>货格机器人 ${s.mfc.bots} 台、拣货站台 ${s.mfc.ports} 个、补货机器人 ${s.robots.amr} 台、盘点机器人 ${s.robots.scanners} 台、洗地机器人 ${s.robots.scrubbers} 台、自动托盘车 ${s.robots.palletMovers} 台、装柜机器人 ${s.robots.lockerLoaders} 台、送框小车 ${s.pickup.carts} 台。</li>
        <li><b>2030 年（532 单 / 天）：</b>货格机器人加到 ${y.mfc.bots} 台、送框小车 ${y.pickup.carts} 台、自提柜 ${lockers(y.pickup.lockers)}；其余不变。</li>
        <li><b>员工按工作内容排班：</b>站台拣货员（兼拆箱入格）、生鲜拣选员、门店作业员（补货、自提异常、年龄核验、配送装车、出口协助一个岗位全包）、收货员、收银员（2 条人工通道）、机器人值班员（每班 1 人），加上夜班上架和固定岗位（生鲜加工、服务台、管理）。</li>
        <li>出口：${s.checkout.gates} 条免排队通道、${s.checkout.selfCheckouts} 台视觉辅助自助结账、${s.checkout.staffedLanes} 条人工通道。</li>
        <li>能源：冷柜全部加门、二氧化碳制冷和热回收、LED 按日光调光，屋顶光伏 ${s.energy.solarKwp} 千瓦峰值、储能 ${s.energy.batteryKwh} 千瓦时（峰时放电）。</li>
      </ul>
    </section>
    <section>
      <h2>地图怎么看</h2>
      <ul>
        <li>圆点是人，方块是机器人；颜色是工作内容（见图例，点图例可以隐藏这一类）。外面多一圈的人是在原地干活（拣货、上架、核验）。</li>
        <li>灰色小点是到店顾客；浅蓝色货架是冷藏区，深一点的蓝是冷冻区，暖色是面包熟食。</li>
        <li>鼠标停在人或机器人上，可以看到是谁、正在做什么。</li>
        <li>「这一天」一栏是全天的结果，右边一列是比同一天的上一代好多少（同样的订单和顾客）。</li>
      </ul>
    </section>
    <section>
      <h2>数据和局限</h2>
      <p>所有门店、商品、订单、顾客都是合成的；上一代的作业时间按 Storewright 优化后流程的结果校准（每单约 30 分钟线上工时、拣货约 66 件 / 小时）。设备性能和价格取公开资料的常见区间，不是任何供应商的数据。仿真只覆盖文档里列出的作业，没有算的东西（例如防损、员工流失、顾客因体验变好而多下的单）在报告里单独说明。</p>
      <p><b>本项目与任何零售商、企业无隶属关系。</b>这是作者的作品集项目。</p>
    </section>
  </div>`;
}
