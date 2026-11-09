function mdl = buildReeferSimulink(zone)
%BUILDREEFERSIMULINK 用代码搭一个冷机的 Simulink 模型（reefer_twin.slx），方程和 reeferModel.m 一样：
%   两个积分器（车厢空气、货物），压缩机用继电器（Relay）模拟按设定温度上下 band 的启停。
%   输入（From Workspace，时间单位是分钟）：amb 环境温度、door 车门、seal 密封不严、extra 额外漏热。
%
%   mdl = buildReeferSimulink('chilled');
%   t = (0:240)';  amb = [t, 22 + 6.5*sin(2*pi*((t/60 + 4) - 9)/24)];
%   door = [t, double(t < 40 | (t >= 150 & t < 180))];  seal = [t, double(t >= 120)];  extra = [t, 0*t];
%   out = sim(mdl, 'StopTime', '240');  plot(out.tout, out.product)
if nargin < 1, zone = 'chilled'; end
p = reeferParams(zone);
set = 2;
if strcmp(zone, 'frozen'), set = -20; end
mdl = 'reefer_twin';
if bdIsLoaded(mdl), close_system(mdl, 0); end
new_system(mdl);
open_system(mdl);
b = @(name) [mdl '/' name];
add = @(lib, name, pos, varargin) add_block(lib, b(name), 'Position', pos, varargin{:});

% 输入
add('simulink/Sources/From Workspace', 'amb', [30 40 90 60], 'VariableName', 'amb');
add('simulink/Sources/From Workspace', 'door', [30 100 90 120], 'VariableName', 'door');
add('simulink/Sources/From Workspace', 'seal', [30 150 90 170], 'VariableName', 'seal');
add('simulink/Sources/From Workspace', 'extra', [30 200 90 220], 'VariableName', 'extra');
add('simulink/Sources/Constant', 'set', [30 260 90 280], 'Value', num2str(set));
add('simulink/Sources/Constant', 'kIns', [150 20 200 40], 'Value', num2str(1 / p.tauIns));

% 漏热系数 = 1/tauIns + door/tauDoor + seal/tauSeal，乘以 gap = amb - air
add('simulink/Math Operations/Gain', 'kDoor', [150 100 200 120], 'Gain', num2str(1 / p.tauDoor));
add('simulink/Math Operations/Gain', 'kSeal', [150 150 200 170], 'Gain', num2str(1 / p.tauSeal));
add('simulink/Math Operations/Sum', 'coef', [240 60 260 160], 'Inputs', '+++');
add('simulink/Math Operations/Sum', 'gap', [240 30 260 50], 'Inputs', '+-');
add('simulink/Math Operations/Product', 'leak', [300 40 330 100]);

% 压缩机：air - set 超过 band 开、低于 -band 关，开着时每分钟降 rCool
add('simulink/Math Operations/Sum', 'err', [240 250 260 290], 'Inputs', '+-');
add('simulink/Discontinuities/Relay', 'compressor', [300 250 340 290], 'OnSwitchValue', num2str(p.band), 'OffSwitchValue', num2str(-p.band), 'OnOutputValue', num2str(p.rCool), 'OffOutputValue', '0');

% 空气和货物的耦合
add('simulink/Math Operations/Sum', 'pa', [300 320 320 360], 'Inputs', '+-');
add('simulink/Math Operations/Gain', 'kCouple', [350 330 400 350], 'Gain', '1/200');

% dAir = leak + extra - compressor + coupling
add('simulink/Math Operations/Sum', 'dAir', [440 100 460 300], 'Inputs', '++-+');
add('simulink/Continuous/Integrator', 'air', [500 190 540 220], 'InitialCondition', num2str(set));
% dProd = (air - product) / tauProd
add('simulink/Math Operations/Sum', 'ap', [580 260 600 300], 'Inputs', '+-');
add('simulink/Math Operations/Gain', 'kProd', [630 270 680 290], 'Gain', num2str(1 / p.tauProd));
add('simulink/Continuous/Integrator', 'product', [720 265 760 295], 'InitialCondition', num2str(set + 0.4));

% 输出
add('simulink/Sinks/To Workspace', 'airOut', [600 190 660 210], 'VariableName', 'air', 'SaveFormat', 'Array');
add('simulink/Sinks/To Workspace', 'productOut', [800 265 860 285], 'VariableName', 'product', 'SaveFormat', 'Array');
add('simulink/Sinks/Scope', 'scope', [800 180 830 220], 'NumInputPorts', '2');

line = @(a, c) add_line(mdl, a, c, 'autorouting', 'smart');
line('amb/1', 'gap/1');
line('air/1', 'gap/2');
line('kIns/1', 'coef/1');
line('door/1', 'kDoor/1');
line('kDoor/1', 'coef/2');
line('seal/1', 'kSeal/1');
line('kSeal/1', 'coef/3');
line('gap/1', 'leak/1');
line('coef/1', 'leak/2');
line('air/1', 'err/1');
line('set/1', 'err/2');
line('err/1', 'compressor/1');
line('product/1', 'pa/1');
line('air/1', 'pa/2');
line('pa/1', 'kCouple/1');
line('leak/1', 'dAir/1');
line('extra/1', 'dAir/2');
line('compressor/1', 'dAir/3');
line('kCouple/1', 'dAir/4');
line('dAir/1', 'air/1');
line('air/1', 'ap/1');
line('product/1', 'ap/2');
line('ap/1', 'kProd/1');
line('kProd/1', 'product/1');
line('air/1', 'airOut/1');
line('product/1', 'productOut/1');
line('air/1', 'scope/1');
line('product/1', 'scope/2');
set_param(mdl, 'StopTime', '240', 'Solver', 'ode4', 'FixedStep', '0.1');
save_system(mdl, fullfile(fileparts(mfilename('fullpath')), [mdl '.slx']));
fprintf('Simulink 模型已保存：%s.slx（%s，设定 %g °C）\n', mdl, zone, set);
end
