import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { useApp } from './state/store';
import { clock, setPlaying, setTime } from './state/clock';
import { currentTraffic } from './scene/traffic';
import { ensureLang, getLang, syncDocument } from './i18n';

// 英文界面先加载字典再渲染
await ensureLang(getLang());
syncDocument();

// 地址栏带 ?debug 时，把状态暴露给浏览器控制台，便于检查和自动化测试
if (new URLSearchParams(location.search).has('debug')) {
  Object.assign(window, { __sw: { useApp, clock, setTime, traffic: currentTraffic } });
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// 嵌在展示页里（?live=demo&bridge=…&store=…）：换成对应的门店模板，连到浏览器里的门店中枢，场景只显示实时数据
const q = new URLSearchParams(location.search);
const bridge = q.get('bridge');
if (q.get('live') === 'demo' && bridge) {
  const store = q.get('store') ?? 'demo';
  const project = q.get('project');
  if (store === 'hardware') useApp.getState().setTemplate('hardware');
  useApp.getState().setTab('ops');
  // 「你的商店」的实时沙盒：先载入访客自己搭的门店（场景的布局要和实时门店一致），再连接
  const ready = project
    ? import('./extensions').then(({ loadYourStore }) =>
        loadYourStore().then((ext) =>
          ext?.getProject(project).then((p) => {
            if (p) useApp.getState().openProject(p, false);
          }),
        ),
      )
    : Promise.resolve();
  void ready.then(() =>
    import('./live/link').then(({ connectDemoLive }) =>
      connectDemoLive(bridge, store).then(() => {
        if (useApp.getState().live.status !== 'off') useApp.getState().setLiveView(true);
      }),
    ),
  );
}

// 展示页的「全天仿真」（?template=…&autoplay=1）：换成对应模板，仿真算完后自动播放，
// 虚拟顾客、员工和车辆按策略跑完一整天，和门店实况同时运行、互不影响
// 「你的商店」：?project=<编号> 打开门店项目（&edit=1 进入搭建），?yours 打开项目页
if (!bridge) void import('./extensions').then(({ loadYourStore }) => loadYourStore().then((ext) => ext?.loadFromUrl()));

if (!bridge) {
  const tpl = q.get('template');
  if (tpl === 'small' || tpl === 'medium' || tpl === 'large' || tpl === 'hardware') useApp.getState().setTemplate(tpl);
  if (q.get('autoplay') === '1') {
    const stop = useApp.subscribe((st) => {
      if (st.timeline && st.status === 'ready') {
        stop();
        setPlaying(true);
      }
    });
  }
}
