import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { useApp } from './state/store';
import { clock, setTime } from './state/clock';
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
  const store = q.get('store') === 'hardware' ? 'hardware' : 'demo';
  if (store === 'hardware') useApp.getState().setTemplate('hardware');
  useApp.getState().setTab('ops');
  void import('./live/link').then(({ connectDemoLive }) =>
    connectDemoLive(bridge, store).then(() => {
      if (useApp.getState().live.status !== 'off') useApp.getState().setLiveView(true);
    }),
  );
}
