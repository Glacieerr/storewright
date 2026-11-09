# Blender：精细的车辆模型

`build_fleet.py` 在 Blender（4.2 以上）里无界面运行，用代码生成区域孪生里公路车辆的精细模型，导出两个 glTF 二进制文件：

```bash
Blender -b -P engines/blender/build_fleet.py -- web/public/assets/fleet.glb
```

| 文件 | 内容 | 谁用 |
| --- | --- | --- |
| `web/public/assets/fleet.glb` | 10 个零件：`tractor`、`trailerDry`、`trailerReefer`、`trailerPlain`、`trailerPlainReefer`、`evTruck`、`vanOnline`、`vanBakery`、`chassis`、`container` | 网页三维：启动后加载，替换同名的程序化零件（加载失败就继续用程序化的） |
| `engines/blender/out/vehicles_ue.glb` | 8 辆整车：牵引车和挂车按直行时的位置拼好（`SM_SemiReefer` 等） | 虚幻引擎（`engines/ue5/`） |

- **零件的坐标**和网页的程序化模型一样：原点在零件的车尾、地面，车头朝 +x，y 向上，z 是左右，单位米。网页把牵引车和挂车分开画（转弯时挂车绕牵引座转、倒车时挂车在前），所以零件文件直接替换几何体，运动和铰接都不用改。
- **整车的坐标**：原点在车头（前保险杠中间、地面），车头朝 +X；孪生服务发给虚幻引擎的位置就是车头。
- 比程序化模型多的细节：倒角的车身；圆柱车轮（轮胎、轮辋、轮毂）；牵引车的格栅、后视镜、遮阳板、油箱、排气管、牵引座、侧裙板；挂车的瓦楞侧板、冷机风扇格栅、后门门铰和锁杆、防钻撞护栏、支腿、挡泥板；集装箱的瓦楞墙板、角件和门锁杆。
- 颜色用材质（每种颜色一个材质）；网页加载时把材质颜色写进顶点颜色，和其他车用同一个实例化材质；牵引车车身和集装箱是白色，网页里按实例颜色上色。

模型由作者设计，不参照任何公司的车辆或涂装。改了脚本以后重新运行上面的命令即可（约 4 秒）。
