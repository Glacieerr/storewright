import { describe, expect, it } from 'vitest';
import { isSoftwareRenderer } from './softwareGl';

describe('software WebGL detection (low quality by default)', () => {
  it('recognizes CPU renderers and leaves real GPUs alone', () => {
    // 没有显卡加速时浏览器报的渲染器名称：Chrome（SwiftShader）、Firefox 和 Linux 上的 WebKit（llvmpipe）、Windows、macOS 虚拟机
    const software = [
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'llvmpipe (LLVM 19.1.1, 256 bits)',
      'llvmpipe, or similar',
      'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'Apple Software Renderer',
    ];
    const gpu = ['ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)', 'Apple GPU', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Mali-G78', 'Adreno (TM) 740'];
    expect(software.filter(isSoftwareRenderer)).toEqual(software);
    expect(gpu.filter(isSoftwareRenderer)).toEqual([]);
  });
});
