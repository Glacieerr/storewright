function s = reeferModel(s, p, u, dtMin)
%REEFERMODEL 冷机往前走 dtMin 分钟（内部按 1 分钟一步）。方程和孪生里的 reeferStep（src/twin/models.ts）一样：
%
%   车厢空气被外面漏进来的热、开门、密封不严加热，压缩机按设定温度上下 band 启停；
%   货物（探针）跟着空气慢慢变。
%     gap   = amb - air
%     heat  = gap/tauIns + door*gap/tauDoor + seal*gap/tauSeal + extra
%     dAir  = heat - cool*rCool + (product - air)/200
%     dProd = (air - product)/tauProd
%
%   s: 结构体 air、product（°C）、cool（逻辑值，压缩机在不在转）
%   p: reeferParams 的参数
%   u: 结构体 amb（环境温度）、set（设定温度）、door、seal、comp（逻辑值）、extra（可选，°C/分钟）
%
%   例：s = struct('air', 2, 'product', 2.4, 'cool', false);
%       s = reeferModel(s, reeferParams('chilled'), struct('amb', 25, 'set', 2, 'door', false, 'seal', false, 'comp', true), 5);
n = max(1, round(dtMin));
h = dtMin / n;
air = s.air;
product = s.product;
cool = logical(s.cool);
extra = 0;
if isfield(u, 'extra')
    extra = u.extra;
end
for i = 1:n
    if ~u.comp
        cool = false;
    elseif air > u.set + p.band
        cool = true;
    elseif air < u.set - p.band
        cool = false;
    end
    gap = u.amb - air;
    heat = gap / p.tauIns + double(u.door) * gap / p.tauDoor + double(u.seal) * gap / p.tauSeal + extra;
    dAir = heat - double(cool) * p.rCool + (product - air) / 200;
    dProd = (air - product) / p.tauProd;
    air = air + dAir * h;
    product = product + dProd * h;
end
s.air = air;
s.product = product;
s.cool = cool;
end
