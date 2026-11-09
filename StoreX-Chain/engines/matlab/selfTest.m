function ok = selfTest()
%SELFTEST 用孪生的冷机模型（TypeScript）生成的参考数据核对 reeferModel.m：同样的输入逐分钟重算，误差应在 1e-6 以内。
%   参考数据：reference/reefer_reference.csv（npx tsx engines/matlab/reference/make.ts 生成）。
here = fileparts(mfilename('fullpath'));
T = readtable(fullfile(here, 'reference', 'reefer_reference.csv'), 'TextType', 'string');
cases = unique(T.case, 'stable');
ok = true;
for c = 1:numel(cases)
    R = T(T.case == cases(c), :);
    p = reeferParams(char(R.zone(1)));
    s = struct('air', R.set(1), 'product', R.set(1) + 0.4, 'cool', false);
    errA = 0;
    errP = 0;
    errC = 0;
    for i = 1:height(R)
        u = struct('amb', R.amb(i), 'set', R.set(i), 'door', R.door(i) == 1, 'seal', R.seal(i) == 1, 'comp', R.comp(i) == 1, 'extra', R.extra(i));
        s = reeferModel(s, p, u, 1);
        errA = max(errA, abs(s.air - R.air(i)));
        errP = max(errP, abs(s.product - R.product(i)));
        errC = errC + (double(s.cool) ~= R.cool(i));
    end
    pass = errA < 1e-6 && errP < 1e-6 && errC == 0;
    ok = ok && pass;
    fprintf('%-14s %3d 分钟：空气最大误差 %.2e °C，货温 %.2e °C，压缩机状态不同 %d 次 → %s\n', cases(c), height(R), errA, errP, errC, string(pass));
end
end
