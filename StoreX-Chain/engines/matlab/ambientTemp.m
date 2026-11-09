function amb = ambientTemp(t)
%AMBIENTTEMP 环境温度（°C）：凌晨最低约 15.5 °C，下午 3 点最高约 28.5 °C。t 是当天 0 点起的秒。
h = t / 3600;
amb = 22 + 6.5 * sin(2 * pi * (h - 9) / 24);
end
