function kf = etaKalman(kf, t, z)
%ETAKALMAN 车辆延误的卡尔曼滤波（状态：延误 d 秒、延误增长的速度 r 秒/秒）。
%   孪生里用的是 alpha-beta 滤波（src/twin/models.ts 的 filterUpdate），这里是同一个思路的卡尔曼版本，
%   增长速度按半小时的时间常数衰减（堵车、等门都是一阵子的事）。
%
%   kf = etaKalman();            % 初始化
%   kf = etaKalman(kf, t, z);    % t 秒时量到延误 z 秒（定位对回计划、到站事件）
%   d  = etaAhead(kf, 1800);     % 往后看半小时的延误
if nargin == 0
    kf = struct('x', [0; 0], 'P', diag([600^2, 0.05^2]), 't', 0, 'R', 20^2, 'q', [5^2, 1e-5]);
    return
end
dt = max(1, t - kf.t);
a = exp(-dt / 1800);
F = [1, 1800 * (1 - a); 0, a];
Q = diag(kf.q * dt / 60);
x = F * kf.x;
P = F * kf.P * F' + Q;
H = [1, 0];
S = H * P * H' + kf.R;
K = P * H' / S;
kf.x = x + K * (z - H * x);
kf.x(2) = min(1, max(-0.5, kf.x(2)));
kf.P = (eye(2) - K * H) * P;
kf.t = t;
end
