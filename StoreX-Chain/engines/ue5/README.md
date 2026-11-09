# 虚幻引擎 5：用孪生服务驱动的区域场景

> **状态：没有在本机编译和运行过。** 作者的电脑装不下虚幻引擎；引擎的安装和许可协议由使用者自己负责。插件按虚幻引擎 5.4 的接口写（WebSockets、Json、DeveloperSettings、分层实例化静态网格体），接口和网页、MATLAB 用的是同一份 `server/protocol.md`；孪生服务和测试客户端在本机跑通过。

## 这一层做什么

网页里的三维孪生（Three.js）适合在浏览器里看和调度；虚幻引擎负责更高画质的渲染（全局光照、阴影、天气）和像素流送。两边读的是同一个孪生服务：

```
现场（server 里的现场仿真）→ 感知数据 → 孪生（估计、推演、建议）→ 决定 / 指令 → 现场
                        └→ WebSocket：车辆位置、数据、建议卡 → 网页三维 / 虚幻引擎 / MATLAB
```

插件 `StoreXTwin/`：

| 类 | 作用 |
| --- | --- |
| `UStoreXTwinSubsystem`（游戏实例子系统） | 连孪生服务的 WebSocket，每一帧 tick 收车辆位置（换成虚幻厘米）和累计指标，收现场数据、建议卡；`Approve`、`Reject`、`SendCommandJson`、`SetSpeed` 发回去；`OnTick`、`OnCards`、`OnMessages` 给蓝图用 |
| `AStoreXFleetActor` | 用分层实例化静态网格体画所有的车，每种车型一个组件，两帧之间插值 |
| `UStoreXTwinLibrary` | 坐标换算（沙盘 ↔ 关卡）、时钟文字 |
| `UStoreXTwinSettings` | 项目设置 → 插件 → StoreX Twin：服务地址、比例、原点、镜像、车型网格体 |

## 步骤

1. **工程**：用虚幻引擎 5.4 以上建一个 C++ 工程，把 `engines/ue5/StoreXTwin` 拷到工程的 `Plugins/` 下，重新生成工程文件、编译。
2. **区域模型**：在网页三维孪生里点「导出 .glb」，得到此刻整个区域（道路、城市、港口、机场、物流园、综合店）的 glTF；在内容浏览器里导入（Interchange 的 glTF 导入器），放在关卡原点。
3. **车辆模型**：用 Blender 生成（`engines/blender/build_fleet.py`，见那里的说明），导入 `engines/blender/out/vehicles_ue.glb`，每个网格体导成一个静态网格体：`SM_SemiDry`、`SM_SemiReefer`、`SM_SemiPlain`、`SM_SemiPlainReefer`、`SM_EvTruck`、`SM_VanOnline`、`SM_VanBakery`、`SM_Drayage`。整车的原点在车头（前保险杠中间、地面），车头朝 +X，和孪生服务发的位置一致。
4. **设置**：项目设置 → StoreX Twin → Kind Meshes，键填上面的网格体名，值选导入的静态网格体；火车、船、飞机可以自己做网格体，键填 `train`、`ship`、`plane`。
5. **校准坐标**：孪生服务 `/api/model` 里有门店中心和 4 个收货口、配送中心 38 樘门的沙盘坐标；在关卡里用 `TwinToWorld` 放几个调试球，看是否落在导入的区域模型对应的位置上。导入器的坐标约定和这里不一致（南北反了）时打开 `bMirrorY`；区域模型挪过时改 `Origin`。
6. **运行**：在仓库目录启动孪生服务，再在编辑器里播放：

   ```bash
   npx tsx server/twinServer.ts --level rough --policy safe --speed 10 --start 4
   ```

   在关卡里放一个 `AStoreXFleetActor`；建议卡用一个控件蓝图绑定 `OnCards`，按钮调用 `Approve(Key, Option)` / `Reject(Key)`。
7. **像素流送**（可选）：打开 Pixel Streaming 插件，打包后带 `-PixelStreamingURL` 参数启动，再起信令服务；浏览器看到的是虚幻引擎渲染的画面，调度员的决定仍然发给同一个孪生服务。

## 坐标

孪生服务发的是沙盘坐标（米，x 向东、z 向南），`X = x × 100`、`Y = z × 100`、`Z = y × 100`（厘米），`Yaw = heading`（0 = 向东，从上往下看顺时针，和虚幻的 Yaw 方向一致）。车辆位置是车道级的，和网页三维用的是同一套道路网、停靠点和运动规划（开过门再倒车靠上）。

## 许可

这个插件（`engines/ue5/` 下的全部文件）使用 [MIT 许可](LICENSE)，和仓库里其他代码的 AGPL-3.0-only 不同。原因：虚幻引擎的许可协议不允许把引擎代码和 copyleft 许可（例如 GPL、AGPL）的代码组合在一起，而插件要和引擎一起编译；插件只通过网络协议（[`server/protocol.md`](../../server/protocol.md)）和 AGPL 许可的孪生服务通信，不包含、也不链接孪生服务的代码，所以单独使用宽松的 MIT 许可。虚幻引擎本身的下载、安装和许可协议由使用者自己负责。
