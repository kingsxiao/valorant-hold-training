# 检查官方第一人称手臂 .blend：对象/骨架/骨骼/当前姿态/贴图/包围盒
import bpy
import sys

argv = sys.argv[sys.argv.index('--') + 1:]
src = argv[0]
bpy.ops.wm.open_mainfile(filepath=src)

print(f'=== {src} ===')
print(f'blender version: {bpy.app.version_string}')

print('\n--- objects ---')
for o in bpy.data.objects:
    mat_names = [s.material.name for s in o.material_slots if s.material]
    print(f'{o.type:10s} "{o.name}" loc=({o.location.x:.3f},{o.location.y:.3f},{o.location.z:.3f}) '
          f'rot=({o.rotation_euler.x:.3f},{o.rotation_euler.y:.3f},{o.rotation_euler.z:.3f}) '
          f'scale=({o.scale.x:.3f},{o.scale.y:.3f},{o.scale.z:.3f}) mats={mat_names}')

print('\n--- meshes (verts/faces/world bbox) ---')
import functools
for o in bpy.data.objects:
    if o.type != 'MESH':
        continue
    me = o.data
    world = o.matrix_world
    if me.vertices:
        xs = [world @ v.co for v in me.vertices]
        bx = (min(v.x for v in xs), max(v.x for v in xs))
        by = (min(v.y for v in xs), max(v.y for v in xs))
        bz = (min(v.z for v in xs), max(v.z for v in xs))
        print(f'"{o.name}" verts={len(me.vertices)} faces={len(me.polygons)} uv_layers={len(me.uv_layers)} '
              f'bbox x[{bx[0]:.3f},{bx[1]:.3f}] y[{by[0]:.3f},{by[1]:.3f}] z[{bz[0]:.3f},{bz[1]:.3f}]')
        # 顶点组（蒙皮）
        if o.vertex_groups:
            vg = [g.name for g in o.vertex_groups]
            print(f'    vertex_groups({len(vg)}): {vg[:40]}')
        # 修改器
        mods = [(m.type, m.object.name if getattr(m, "object", None) else '') for m in o.modifiers]
        if mods:
            print(f'    modifiers: {mods}')

print('\n--- armatures (bones + current pose vs rest) ---')
for o in bpy.data.objects:
    if o.type != 'ARMATURE':
        continue
    print(f'ARMATURE "{o.name}" bones={len(o.data.bones)}')
    for b in o.data.bones:
        pb = o.pose.bones.get(b.name)
        pose_str = ''
        if pb:
            q = pb.matrix_basis.to_euler()
            pose_str = f' pose_euler=({q.x:.3f},{q.y:.3f},{q.z:.3f})'
        # 世界坐标 head/tail（含当前姿态）
        head_w = o.matrix_world @ pb.head if pb else o.matrix_world @ b.head_local
        tail_w = o.matrix_world @ pb.tail if pb else o.matrix_world @ b.tail_local
        print(f'  bone "{b.name}" rest_head_local=({b.head_local.x:.3f},{b.head_local.y:.3f},{b.head_local.z:.3f}) '
              f'head_w=({head_w.x:.3f},{head_w.y:.3f},{head_w.z:.3f}) tail_w=({tail_w.x:.3f},{tail_w.y:.3f},{tail_w.z:.3f}){pose_str}')

print('\n--- actions/animations in file ---')
for a in bpy.data.actions:
    print(f'ACTION "{a.name}" fcurves={len(a.fcurves)} frame_range={a.frame_range}')

print('\n--- images ---')
for img in bpy.data.images:
    print(f'"{img.name}" {img.size[0]}x{img.size[1]} filepath={img.filepath}')

print('\n--- materials ---')
for m in bpy.data.materials:
    if m.use_nodes:
        tex_nodes = [n.image.name if n.image else '?' for n in m.node_tree.nodes if n.type == 'TEX_IMAGE']
        print(f'"{m.name}" tex={tex_nodes}')
    else:
        print(f'"{m.name}" (no nodes)')
