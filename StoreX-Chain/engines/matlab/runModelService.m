function runModelService(baseUrl, minutes)
%RUNMODELSERVICE MATLAB 当闭环里的一个「模型服务」：从孪生服务取冷机读数，用自己的模型（reeferModel、estimateLeak）
%   独立估计每辆冷机车的漏热、往后推 60 分钟；预计货温超标、而且还没调过的车，发一条「设定温度调低 2 °C」的指令。
%   孪生服务里自己的孪生也在做同样的判断——这里演示外部的机理模型怎么接进同一个闭环（指令直接发给现场）。
%
%   runModelService("http://127.0.0.1:8787", 30)   % 跑 30 秒（真实时间），孪生服务开着加速
if nargin < 1, baseUrl = "http://127.0.0.1:8787"; end
if nargin < 2, minutes = 30; end
c = StoreXTwinClient(baseUrl);
next = 0;
veh = containers.Map('KeyType', 'double', 'ValueType', 'any');
sent = [];
limitOf = struct('chilled', 5, 'frozen', -15);
t0 = tic;
while toc(t0) < minutes
    [msgs, next] = c.messages(next, 2000);
    for i = 1:numel(msgs)
        m = msgs{i};
        if ~strcmp(m.kind, 'temp'), continue; end
        zone = 'chilled';
        if m.set < -5, zone = 'frozen'; end
        p = reeferParams(zone);
        reading = struct('air', m.air, 'product', m.product, 'cool', m.cool, 'set', m.set, 'door', m.door, 't', m.t);
        if isKey(veh, m.vid)
            v = veh(m.vid);
            [v.h, ~] = estimateLeak(v.h, v.last, reading, p, true, (m.t - v.last.t) / 60);
        else
            v = struct('h', 0, 'last', reading);
        end
        v.last = reading;
        veh(m.vid) = v;
        % 往后推 60 分钟（车门关着、按现在的设定温度、带上估计的漏热）
        s = struct('air', m.air, 'product', m.product, 'cool', m.cool);
        peak = m.product;
        for k = 1:12
            u = struct('amb', ambientTemp(m.t + k * 300), 'set', m.set, 'door', false, 'seal', false, 'comp', true, 'extra', v.h);
            s = reeferModel(s, p, u, 5);
            peak = max(peak, s.product);
        end
        % 设定温度最多比标准低 2 °C（已经调过的不再调）
        minSet = -21.9;
        if strcmp(zone, 'chilled'), minSet = 0.1; end
        if peak > limitOf.(zone) && ~any(sent == m.vid) && m.set > minSet
            c.command(struct('kind', 'setpoint', 'vid', m.vid, 'delta', -2));
            sent(end + 1) = m.vid; %#ok<AGROW>
            fprintf('%02d:%02d 车 %d：漏热估计 %.2f °C/分钟，60 分钟内货温最高 %.1f °C → 设定温度调低 2 °C\n', floor(m.t / 3600), floor(mod(m.t, 3600) / 60), m.vid, v.h, peak);
        end
    end
    pause(1);
end
fprintf('模型服务结束：看了 %d 辆冷机车，发了 %d 条指令\n', veh.Count, numel(sent));
end
