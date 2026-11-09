function [h, pred] = estimateLeak(h, prev, reading, p, comp, dtMin)
%ESTIMATELEAK 用模型残差估计「解释不了的漏热」h（°C/分钟），和孪生（src/twin/twin.ts 的 temp 消息）一样：
%   用自己的模型从上一次读数推到这一次，和读数比；两次读数之间车门一直开着或一直关着、压缩机在转时，
%   空气比模型高的部分按 0.8 的增益记进 h（限制在 0–2）；货温一下跳了一度多（救援车刚转进一车货）不学。
%
%   prev、reading: 结构体 air、product、cool、set、door、t（秒）
%   comp: 压缩机好不好
amb = ambientTemp(reading.t);
s = struct('air', prev.air, 'product', prev.product, 'cool', prev.cool);
u = struct('amb', amb, 'set', prev.set, 'door', prev.door, 'seal', false, 'comp', comp, 'extra', h);
pred = reeferModel(s, p, u, dtMin);
resid = reading.air - pred.air;
jump = abs(reading.product - pred.product) > 1;
if ~jump && reading.door == prev.door && comp
    h = min(2, max(0, h + 0.8 * resid / max(1, dtMin)));
else
    h = h * 0.9;
end
end
