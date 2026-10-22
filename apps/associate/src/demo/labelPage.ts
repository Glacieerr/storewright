import { installDemoTransport, link } from './transport';

/**
 * 浏览器内演示模式的标签页面：地址的 # 后面是原来的标签接口地址，向浏览器里的中枢取 SVG 或 HTML 后显示。
 */
installDemoTransport();
const api = decodeURIComponent(location.hash.slice(1));
const msg = document.getElementById('msg') as HTMLElement;
if (!api.includes('/api/')) msg.textContent = 'Missing label address';
else
  void link
    .fetch(api)
    .then(async (r) => {
      const text = await r.text();
      if (!r.ok) {
        msg.textContent = `Label not found (${r.status})`;
        return;
      }
      if ((r.headers.get('content-type') ?? '').includes('text/html')) {
        document.open();
        document.write(text);
        document.close();
      } else {
        msg.remove();
        document.body.insertAdjacentHTML('beforeend', text);
      }
    })
    .catch(() => (msg.textContent = 'Demo hub unavailable'));
