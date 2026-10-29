/**
 * 浏览器是不是在用 CPU 软件渲染 WebGL。没有显卡加速时（虚拟机、远程桌面、关掉了硬件加速、持续集成的机器），
 * Chrome 用 SwiftShader，Firefox 和 Linux 上的 WebKit 用 llvmpipe，Windows 用 Basic Render Driver。
 * 软件渲染下高画质一帧要好几秒，整个页面跟着卡（展示页里同一页的控制台和手机也点不动），所以默认用低画质。
 */
export function isSoftwareRenderer(name: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
}

export function softwareWebGL(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return false;
    // Firefox 的 RENDERER 直接给出渲染器名称；Chrome、Safari 只给「WebKit WebGL」，要从调试扩展读真实名称
    const plain = String(gl.getParameter(gl.RENDERER));
    const ext = /webkit webgl/i.test(plain) ? gl.getExtension('WEBGL_debug_renderer_info') : null;
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : plain;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return isSoftwareRenderer(name);
  } catch {
    return false;
  }
}
