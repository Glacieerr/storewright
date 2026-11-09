function d = etaAhead(kf, dt)
%ETAAHEAD 往后看 dt 秒的延误：增长速度按半小时衰减（和孪生的 filterAhead 一样）
d = kf.x(1) + kf.x(2) * 1800 * (1 - exp(-max(0, dt) / 1800));
end
