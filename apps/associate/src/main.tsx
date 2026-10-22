import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getLang } from './i18n';
import './styles.css';
import { installDemoTransport } from './demo/transport';

// 浏览器内演示模式：/api 请求转给浏览器里的门店中枢（必须在其他代码发请求之前）
installDemoTransport();

document.documentElement.lang = getLang() === 'zh' ? 'zh-CN' : 'en';
// 嵌在展示页里：控制台把下单表单放到最上面
if (new URLSearchParams(location.search).has('embed')) document.body.classList.add('embed');
createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 离线时也能打开应用外壳（只在生产构建中注册）
// 嵌在展示页的 iframe 里时不注册（由顶层页面决定）
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.top === window) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
