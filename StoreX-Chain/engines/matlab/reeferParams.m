function p = reeferParams(zone)
%REEFERPARAMS 冷机模型的参数，和孪生里的 src/twin/models.ts（REEFER、reeferParams）一样。
%   单位：时间常数是分钟，rCool 是压缩机每分钟能降多少度，band 是启停的回差（°C）。
%   冷冻货的热容大得多：货物温度跟随空气的时间常数是冷藏的 2.5 倍。
%
%   p = reeferParams('chilled')   % 或 'frozen'
p = struct('tauIns', 300, 'tauDoor', 90, 'tauSeal', 22, 'rCool', 0.25, 'tauProd', 240, 'band', 0.8);
if nargin > 0 && strcmp(zone, 'frozen')
    p.tauProd = p.tauProd * 2.5;
end
end
