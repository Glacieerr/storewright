"""
用 Blender（4.2 以上，无界面运行）生成区域孪生里公路车辆的精细模型，导出一个 glTF 二进制文件：

    Blender -b -P engines/blender/build_fleet.py -- web/public/assets/fleet.glb

每个零件一个顶层节点，名字就是网页里的零件名（tractor、trailerReefer、trailerDry、trailerPlain、
trailerPlainReefer、evTruck、vanOnline、vanBakery、chassis、container）。零件的坐标和网页的程序化模型一样：
原点在零件的车尾，车头朝 +x，y 向上，z 是左右，单位米（导出成 glTF 的 Y 向上）。所以网页加载以后直接替换
同名零件的几何体，运动和铰接不用改；虚幻引擎按 engines/ue5/README.md 导入。

比程序化模型多的细节：倒角的车身、圆柱车轮（轮胎、轮辋、轮毂）、牵引车的格栅、后视镜、遮阳板、油箱、排气管、
牵引座、侧裙板；挂车的瓦楞侧板、冷机（风扇格栅）、后门的门铰和锁杆、防钻撞护栏、支腿、挡泥板；
集装箱的瓦楞墙板、角件和门锁杆。

模型由作者设计，不参照任何公司的车辆或涂装。
"""
import math
import sys

import bpy

OUT = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else 'fleet.glb'

bpy.ops.wm.read_factory_settings(use_empty=True)
MATS = {}


def mat(color, metal=0.0, rough=0.55):
    """按颜色复用材质（网页加载时把材质颜色写进顶点颜色）"""
    key = (color, metal, rough)
    if key in MATS:
        return MATS[key]
    m = bpy.data.materials.new(name=f'c{color.lstrip("#")}')
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    h = color.lstrip('#')
    rgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    bsdf.inputs['Base Color'].default_value = (*lin, 1)
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    MATS[key] = m
    return m


class Part:
    """一个零件：往里加方块、圆柱，最后合并成一个物体"""

    def __init__(self, name):
        self.name = name
        self.objs = []

    def _place(self, o, x, y, z):
        # 零件坐标 (x 前, y 上, z 侧) → Blender (X = x, Y = -z, Z = y)，导出 glTF（Y 向上）后又回到 (x, y, z)
        o.location = (x, -z, y)
        self.objs.append(o)

    def box(self, sx, sy, sz, color, cx, y0, cz, bevel=0.0, metal=0.0, rough=0.55):
        """sx × sy × sz 的方块，中心 x = cx、z = cz，底面在 y0（和网页的 box() 一样）"""
        bpy.ops.mesh.primitive_cube_add(size=1)
        o = bpy.context.active_object
        o.scale = (sx, sz, sy)
        bpy.ops.object.transform_apply(scale=True)
        if bevel > 0:
            mod = o.modifiers.new('b', 'BEVEL')
            mod.width = min(bevel, min(sx, sy, sz) * 0.45)
            mod.segments = 2
            bpy.ops.object.modifier_apply(modifier=mod.name)
        o.data.materials.append(mat(color, metal, rough))
        self._place(o, cx, y0 + sy / 2, cz)
        return o

    def cyl(self, r, depth, color, cx, cy, cz, axis='z', verts=20, metal=0.0, rough=0.6):
        """圆柱：axis = 'z'（左右，车轮）、'y'（竖直，排气管）、'x'（前后）"""
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth)
        o = bpy.context.active_object
        if axis == 'z':
            # Blender 的圆柱沿 Z 轴；零件的 z（左右）对应 Blender 的 Y，转 90 度
            o.rotation_euler = (math.pi / 2, 0, 0)
        elif axis == 'x':
            o.rotation_euler = (0, math.pi / 2, 0)
        bpy.ops.object.transform_apply(rotation=True)
        o.data.materials.append(mat(color, metal, rough))
        self._place(o, cx, cy, cz)
        return o

    def wheel(self, x, r, half, dual=False):
        """一对车轮（左右），双胎的宽一些：轮胎、轮辋、轮毂"""
        w = 0.5 if dual else 0.32
        for s in (-1, 1):
            self.cyl(r, w, '#1d1d1d', x, r, s * half, verts=28, rough=0.9)
            self.cyl(r * 0.6, w + 0.02, '#c4c6c9', x, r, s * half, verts=20, metal=0.8, rough=0.35)
            self.cyl(r * 0.22, w + 0.06, '#8a8d91', x, r, s * half, verts=12, metal=0.8, rough=0.4)

    def build(self):
        bpy.ops.object.select_all(action='DESELECT')
        for o in self.objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = self.objs[0]
        bpy.ops.object.join()
        o = bpy.context.active_object
        # 合并后原点在第一块的中心：把原点放回零件坐标的原点（车尾、地面），几何体不动
        bpy.context.scene.cursor.location = (0, 0, 0)
        bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
        o.name = self.name
        o.data.name = self.name
        return o


GLASS = '#26313c'
DARK = '#2d2f33'


def tractor():
    p = Part('tractor')
    p.box(6.0, 0.32, 0.95, DARK, 3.0, 0.72, 0, metal=0.3)  # 大梁
    p.box(2.3, 2.55, 2.48, '#ffffff', 4.75, 1.05, 0, bevel=0.12)  # 驾驶室
    p.box(1.7, 0.55, 2.3, '#ffffff', 4.55, 3.6, 0, bevel=0.15)  # 导流罩
    p.box(0.06, 1.05, 2.2, GLASS, 5.92, 2.3, 0, rough=0.1)  # 前挡风
    for z in (-1.255, 1.255):
        p.box(0.95, 0.75, 0.04, GLASS, 5.25, 2.45, z, rough=0.1)  # 侧窗
    # 格栅：一排横条
    for k in range(6):
        p.box(0.05, 0.06, 1.7, '#3a3c40', 5.99, 0.62 + k * 0.1, 0, metal=0.4)
    p.box(0.16, 0.3, 2.42, '#3a3c40', 5.98, 0.3, 0, bevel=0.04)  # 保险杠
    for z in (0.84, -0.84):
        p.box(0.05, 0.2, 0.42, '#f6f2df', 6.01, 0.98, z)  # 大灯
        p.box(0.05, 0.08, 0.16, '#f0a030', 6.01, 1.22, z * 1.1)  # 转向灯
    p.box(0.12, 0.14, 2.3, '#2b2d30', 5.9, 3.42, 0)  # 遮阳板
    for z in (1.38, -1.38):
        p.box(0.1, 0.45, 0.1, '#222222', 5.55, 2.25, z)  # 后视镜杆
        p.box(0.08, 0.38, 0.22, '#222222', 5.6, 2.55, z * 1.04, bevel=0.02)  # 后视镜
        p.box(0.6, 0.1, 0.25, '#55595e', 4.2, 0.88, z * 0.92, metal=0.5)  # 上车踏板
    p.cyl(0.3, 1.2, '#b9bcc0', 3.1, 0.72, 1.05, axis='x', metal=0.85, rough=0.25)  # 油箱
    p.box(1.0, 0.55, 0.46, '#4a4f55', 3.0, 0.5, -1.0, bevel=0.05)  # 电瓶箱
    p.box(1.1, 0.14, 1.1, '#4a4a4a', 1.6, 1.08, 0, metal=0.6)  # 牵引座
    p.cyl(0.08, 1.6, '#9a9a9a', 3.45, 2.3, 1.1, axis='y', verts=10, metal=0.9, rough=0.3)  # 排气管
    for z in (1.2, -1.2):
        p.box(2.0, 0.45, 0.04, '#e9eaec', 2.0, 0.55, z)  # 侧裙板
    p.wheel(4.9, 0.52, 1.02)
    p.wheel(1.6, 0.52, 0.95, dual=True)
    p.wheel(0.35, 0.52, 0.95, dual=True)
    return p.build()


def trailer(name, stripe, reefer):
    """13.6 米厢式挂车：牵引座在 x = 12.4，三轴在 x = 1.6 / 2.9 / 4.2"""
    p = Part(name)
    p.box(13.6, 2.7, 2.5, '#f3f3f0', 6.8, 1.25, 0, bevel=0.04)  # 厢体
    p.box(13.6, 0.08, 2.52, '#dcdcd8', 6.8, 3.95, 0)  # 顶板
    # 瓦楞侧板：每 0.6 米一条竖肋
    for k in range(22):
        for z in (1.262, -1.262):
            p.box(0.05, 2.6, 0.03, '#e2e2de', 0.4 + k * 0.6, 1.3, z)
    p.box(13.2, 0.22, 2.3, DARK, 6.6, 1.03, 0, metal=0.3)  # 底架
    p.box(0.06, 2.6, 2.42, '#d9d9d5', 0.0, 1.3, 0)  # 后门
    p.box(0.07, 2.6, 0.06, '#8f8f8a', -0.01, 1.3, 0)  # 门缝
    for z in (0.62, -0.62):
        p.cyl(0.025, 2.4, '#7d8186', -0.06, 1.3, z, axis='y', verts=8, metal=0.9)  # 锁杆
    for y in (1.6, 2.6, 3.6):
        for z in (1.18, -1.18):
            p.box(0.06, 0.1, 0.12, '#55595e', -0.04, y, z, metal=0.7)  # 门铰
    p.box(0.16, 0.24, 2.3, '#333333', 0.2, 0.62, 0, metal=0.4)  # 防钻撞护栏
    for z in (1.0, -1.0):
        p.box(0.05, 0.16, 0.32, '#d83b2f', -0.03, 1.08, z)  # 尾灯
        p.box(0.4, 0.55, 0.03, '#1d1d1d', 0.9, 0.2, z * 1.16)  # 挡泥板
    for z in (1.2, -1.2):
        p.box(5.5, 0.42, 0.05, '#b8bcc0', 8.2, 0.62, z, metal=0.6)  # 侧防护
    for z in (0.9, -0.9):
        p.box(0.16, 0.95, 0.16, '#555555', 10.8, 0.3, z, metal=0.5)  # 支腿
        p.box(0.3, 0.06, 0.3, '#444444', 10.8, 0.27, z)  # 支腿脚
    for x in (1.6, 2.9, 4.2):
        p.wheel(x, 0.5, 0.95, dual=True)
    if stripe:
        for z in (1.265, -1.265):
            p.box(12.8, 0.38, 0.03, stripe, 6.9, 2.55, z)
            p.box(12.8, 0.08, 0.03, stripe, 6.9, 3.05, z)
    if reefer:
        p.box(0.55, 1.5, 1.9, '#9aa5b1', 13.85, 2.35, 0, bevel=0.05)  # 冷机
        p.box(0.05, 1.1, 1.5, '#3d4650', 14.13, 2.55, 0)  # 前面板
        for k in range(2):
            p.cyl(0.32, 0.06, '#2b3138', 14.16, 2.7 + k * 0.0, -0.4 + k * 0.8, axis='x', verts=18)  # 风扇格栅
        p.box(0.08, 0.2, 0.5, '#5bb26a', 14.14, 2.05, 0.55)  # 状态灯面板
    return p.build()


def ev_truck():
    p = Part('evTruck')
    p.box(11.0, 0.3, 0.95, DARK, 5.5, 0.72, 0, metal=0.3)
    p.box(8.2, 2.75, 2.5, '#f4f6f7', 4.1, 1.08, 0, bevel=0.05)
    p.box(8.2, 0.08, 2.52, '#dfe3e5', 4.1, 3.83, 0)
    for z in (1.262, -1.262):
        p.box(8.0, 0.42, 0.03, '#1baf7a', 4.1, 2.35, z)
    p.box(0.06, 2.6, 2.42, '#dadedf', 0.0, 1.15, 0)
    p.box(0.5, 0.75, 1.6, '#9aa5b1', 8.45, 2.85, 0, bevel=0.04)
    p.box(2.3, 2.45, 2.45, '#eef2f3', 9.75, 1.0, 0, bevel=0.12)
    p.box(2.32, 0.32, 2.47, '#1baf7a', 9.75, 1.0, 0)
    p.box(0.06, 0.95, 2.15, GLASS, 10.92, 2.15, 0, rough=0.1)
    for z in (1.24, -1.24):
        p.box(0.9, 0.7, 0.04, GLASS, 10.3, 2.25, z, rough=0.1)
        p.box(0.08, 0.34, 0.2, '#222222', 10.8, 2.35, z * 1.06)
    p.box(0.14, 0.5, 2.4, '#3a3c40', 10.95, 0.5, 0, bevel=0.03)
    for z in (0.85, -0.85):
        p.box(0.05, 0.18, 0.4, '#f6f2df', 10.98, 0.85, z)
        p.box(0.05, 0.16, 0.32, '#d83b2f', -0.03, 1.1, z * 1.18)
    for z in (0.95, -0.95):
        p.box(3.6, 0.62, 0.5, '#2b3a46', 6.3, 0.42, z, bevel=0.05)  # 电池包
    p.wheel(9.6, 0.5, 1.0)
    p.wheel(3.4, 0.5, 0.95, dual=True)
    return p.build()


def van(name, stripe):
    p = Part(name)
    p.box(4.3, 2.25, 2.05, '#f6f6f3', 2.15, 0.42, 0, bevel=0.08)
    p.box(1.75, 1.45, 2.0, '#f6f6f3', 5.1, 0.42, 0, bevel=0.12)
    p.box(0.75, 0.55, 2.0, '#f6f6f3', 4.6, 1.85, 0, bevel=0.1)
    p.box(0.06, 0.8, 1.8, GLASS, 5.98, 1.25, 0, rough=0.1)
    for z in (1.03, -1.03):
        p.box(0.85, 0.55, 0.03, GLASS, 5.1, 1.35, z, rough=0.1)
        p.box(4.3, 0.2, 0.03, stripe, 2.15, 1.5, z)
        p.box(0.07, 0.25, 0.14, '#222222', 5.6, 1.55, z * 1.08)
    p.box(0.1, 0.4, 1.9, '#3a3c40', 5.98, 0.42, 0, bevel=0.03)
    for z in (0.75, -0.75):
        p.box(0.04, 0.14, 0.3, '#f6f2df', 6.01, 0.95, z)
        p.box(0.04, 0.3, 0.12, '#d83b2f', -0.02, 1.4, z * 1.2)
    p.wheel(5.1, 0.38, 0.9)
    p.wheel(1.4, 0.38, 0.9)
    return p.build()


def chassis():
    """集装箱骨架车：牵引座在 x = 11.2，两轴"""
    p = Part('chassis')
    for z in (0.5, -0.5):
        p.box(12.2, 0.3, 0.2, DARK, 6.1, 0.9, z, metal=0.4)
    for k in range(5):
        p.box(0.15, 0.15, 2.4, DARK, 0.5 + k * 2.8, 1.05, 0, metal=0.4)
    for x in (0.2, 12.0):
        for z in (1.15, -1.15):
            p.box(0.2, 0.12, 0.2, '#e2b300', x, 1.18, z)  # 扭锁
    for z in (0.9, -0.9):
        p.box(0.16, 0.95, 0.16, '#555555', 9.6, 0.25, z, metal=0.5)
    p.box(0.12, 0.2, 2.3, '#333333', 0.1, 0.62, 0)
    for z in (1.0, -1.0):
        p.box(0.05, 0.14, 0.3, '#d83b2f', -0.03, 0.85, z)
    for x in (1.6, 2.9):
        p.wheel(x, 0.5, 0.95, dual=True)
    return p.build()


def container():
    """40 尺集装箱（12.2 × 2.44 × 2.6 米），白色，网页里按实例颜色上色"""
    p = Part('container')
    p.box(12.2, 2.6, 2.44, '#ffffff', 6.1, 0.0, 0, bevel=0.03)
    for k in range(40):
        for z in (1.235, -1.235):
            p.box(0.12, 2.4, 0.03, '#ededed', 0.3 + k * 0.3, 0.1, z)
    for x in (0.1, 12.1):
        for y in (0.0, 2.45):
            for z in (1.13, -1.13):
                p.box(0.18, 0.15, 0.18, '#9a9a9a', x, y, z, metal=0.6)  # 角件
    for z in (0.3, 0.75, -0.3, -0.75):
        p.cyl(0.025, 2.4, '#8a8d91', -0.04, 1.3, z, axis='y', verts=8, metal=0.9)  # 门锁杆
    return p.build()


objs = [
    tractor(),
    trailer('trailerDry', '#2a78d6', False),
    trailer('trailerReefer', '#5fb0e8', True),
    trailer('trailerPlain', None, False),
    trailer('trailerPlainReefer', None, True),
    ev_truck(),
    van('vanOnline', '#9b7bc4'),
    van('vanBakery', '#d9963a'),
    chassis(),
    container(),
]
# 给虚幻引擎的整车（牵引车和挂车按直行时的位置拼好）：原点在车头（前保险杠中间、地面），车头朝 +X；
# 孪生服务发的位置就是车头。零件的位置按网页的锚点算：零件里 x 处离车头 = ax − x + fa，所以零件往前挪 −(ax + fa)
UE = {
    'SM_SemiDry': [('tractor', 4.9, 1.1, 0), ('trailerDry', 12.4, 4.4, 0)],
    'SM_SemiReefer': [('tractor', 4.9, 1.1, 0), ('trailerReefer', 12.4, 4.4, 0)],
    'SM_SemiPlain': [('tractor', 4.9, 1.1, 0), ('trailerPlain', 12.4, 4.4, 0)],
    'SM_SemiPlainReefer': [('tractor', 4.9, 1.1, 0), ('trailerPlainReefer', 12.4, 4.4, 0)],
    'SM_EvTruck': [('evTruck', 9.6, 1.4, 0)],
    'SM_VanOnline': [('vanOnline', 5.1, 0.9, 0)],
    'SM_VanBakery': [('vanBakery', 5.1, 0.9, 0)],
    'SM_Drayage': [('tractor', 4.9, 1.1, 0), ('chassis', 11.2, 4.4, 0), ('container', 11.2, 4.4, 1.25)],
}
by_name = {o.name: o for o in objs}
ue_objs = []
for name, parts in UE.items():
    copies = []
    for part, ax, fa, y in parts:
        src = by_name[part]
        c = src.copy()
        c.data = src.data.copy()
        bpy.context.collection.objects.link(c)
        c.location = (-(ax + fa), 0, y)
        copies.append(c)
    bpy.ops.object.select_all(action='DESELECT')
    for c in copies:
        c.select_set(True)
    bpy.context.view_layer.objects.active = copies[0]
    bpy.ops.object.join()
    o = bpy.context.active_object
    bpy.context.scene.cursor.location = (0, 0, 0)
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    o.name = name
    ue_objs.append(o)

# 网页用的零件文件：只导出零件（并排摆开只是在 Blender 里好看，网页按名字取几何体，不用位置）
for i, o in enumerate(objs):
    o.location = (0, i * 4.0, 0)
bpy.ops.object.select_all(action='DESELECT')
for o in objs:
    o.select_set(True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_apply=True, export_yup=True, export_materials='EXPORT')
print(f'导出 {len(objs)} 个零件 → {OUT}')

# 虚幻引擎用的整车文件：engines/blender/out/vehicles_ue.glb（导入时选「把每个网格导成一个静态网格体」）
import os

ue_out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'vehicles_ue.glb')
os.makedirs(os.path.dirname(ue_out), exist_ok=True)
for i, o in enumerate(ue_objs):
    o.location = (0, -6.0 - i * 4.0, 0)
bpy.ops.object.select_all(action='DESELECT')
for o in ue_objs:
    o.select_set(True)
bpy.ops.export_scene.gltf(filepath=ue_out, export_format='GLB', use_selection=True, export_apply=True, export_yup=True, export_materials='EXPORT')
print(f'导出 {len(ue_objs)} 辆整车 → {ue_out}')
