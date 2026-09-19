#!/usr/bin/env python3
"""
Applies the official Wynncraft resource pack textures to prismarine-viewer and Prism Launcher.
- Extracts block, item, entity, and custom textures from the Wynncraft resource pack,
  handling Wynncraft's custom zip obfuscation (empty local headers & scrambled PNG CRCs).
- Patches matching block texture files and regenerates the 1.21.1 and 26.1 texture atlases
  preserving the exact vanilla layout so block models align perfectly.
- Links 26.1.png and blocksStates/26.1.json so the 3D viewer displays custom Wynncraft blocks.
- Places the official resource pack zip into Prism Launcher's server-resource-packs directory.
"""

import os
import sys
import zipfile
import zlib
import shutil
import json
from io import BytesIO
from PIL import Image, ImageFile, PngImagePlugin

# Bypass PNG CRC verification and allow truncated images (Minecraft/STB ignores them, Wynncraft intentionally scrambles/strips them)
PngImagePlugin.PngStream.crc = PngImagePlugin.PngStream.crc_skip
ImageFile.LOAD_TRUNCATED_IMAGES = True

def read_zip_entry(zip_fp, zinfo):
    """Safely extracts raw or deflated entry from Wynncraft obfuscated zip."""
    zip_fp.seek(zinfo.header_offset)
    header = zip_fp.read(30)
    fn_len = int.from_bytes(header[26:28], 'little')
    extra_len = int.from_bytes(header[28:30], 'little')
    zip_fp.seek(zinfo.header_offset + 30 + fn_len + extra_len)
    raw_data = zip_fp.read(zinfo.compress_size)
    if zinfo.compress_type == 8:
        return zlib.decompress(raw_data, -15)
    elif zinfo.compress_type == 0:
        return raw_data
    else:
        raise ValueError(f"Unsupported compress type: {zinfo.compress_type}")

def apply_wynncraft_textures():
    repo_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    rp_zip_path = os.path.join(repo_dir, 'assets/wynnpack/wynn_rp.zip')
    
    if not os.path.exists(rp_zip_path):
        print(f"Error: Wynncraft resource pack not found at {rp_zip_path}")
        sys.exit(1)

    candidate_pv_dirs = [
        os.path.join(repo_dir, 'mineflayer-wynn/node_modules/prismarine-viewer/public'),
        os.path.join(repo_dir, 'node_modules/prismarine-viewer/public'),
        os.path.join(os.path.expanduser('~'), 'mineflayer-wynn/node_modules/prismarine-viewer/public'),
        os.path.join(os.path.expanduser('~'), '.npm-global/lib/node_modules/prismarine-viewer/public'),
        '/opt/homebrew/lib/node_modules/prismarine-viewer/public',
        '/usr/local/lib/node_modules/prismarine-viewer/public'
    ]
    pv_base = next((d for d in candidate_pv_dirs if os.path.exists(d)), None)
    if not pv_base:
        print(f"Error: prismarine-viewer public dir not found. Checked: {candidate_pv_dirs}")
        sys.exit(1)

    textures_dir = os.path.join(pv_base, 'textures')
    blocks_dir = os.path.join(textures_dir, '1.21.1/blocks')
    entities_dir = os.path.join(textures_dir, '1.21.1/entity')
    items_dir = os.path.join(textures_dir, '1.21.1/items')
    wynn_dir = os.path.join(textures_dir, '1.21.1/wynn')
    os.makedirs(wynn_dir, exist_ok=True)

    print(f"[1/5] Opening Wynncraft resource pack ({os.path.getsize(rp_zip_path) // 1024 // 1024} MB)...")
    zf = zipfile.ZipFile(rp_zip_path, 'r')

    # Capture vanilla file list in alphabetical order BEFORE patching so UV layout remains 100% stable
    original_texture_files = sorted([f for f in os.listdir(blocks_dir) if f.endswith('.png')])
    existing_blocks = set(original_texture_files)

    # 1. Update block textures
    print(f"[2/5] Patching block textures with Wynncraft custom block art ({len(existing_blocks)} base blocks)...")
    patched_blocks = 0
    with open(rp_zip_path, 'rb') as zip_fp:
        for zinfo in zf.filelist:
            name = zinfo.filename
            if name.startswith('assets/minecraft/textures/block/') and name.endswith('.png'):
                filename = os.path.basename(name)
                try:
                    raw_png = read_zip_entry(zip_fp, zinfo)
                    img = Image.open(BytesIO(raw_png)).convert('RGBA')
                    # Crop first 16x16 frame if animated (e.g. height > 16)
                    if img.width != 16 or img.height != 16:
                        img = img.crop((0, 0, 16, 16))
                    
                    target_path = os.path.join(blocks_dir, filename)
                    img.save(target_path, format='PNG')
                    patched_blocks += 1
                except Exception as e:
                    pass

    print(f"  -> Successfully patched {patched_blocks} block textures in {blocks_dir}")

    # 2. Extract entity and item textures
    print("[3/5] Extracting Wynncraft entity, item, and GUI textures...")
    patched_entities = 0
    patched_items = 0
    with open(rp_zip_path, 'rb') as zip_fp:
        for zinfo in zf.filelist:
            name = zinfo.filename
            try:
                if name.startswith('assets/minecraft/textures/entity/') and name.endswith('.png'):
                    rel_path = name[len('assets/minecraft/textures/entity/'):]
                    dest = os.path.join(entities_dir, rel_path)
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                    data = read_zip_entry(zip_fp, zinfo)
                    with open(dest, 'wb') as f:
                        f.write(data)
                    patched_entities += 1
                elif name.startswith('assets/minecraft/textures/item/') and name.endswith('.png'):
                    rel_path = name[len('assets/minecraft/textures/item/'):]
                    dest = os.path.join(items_dir, rel_path)
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                    data = read_zip_entry(zip_fp, zinfo)
                    with open(dest, 'wb') as f:
                        f.write(data)
                    patched_items += 1
                elif name.startswith('assets/minecraft/textures/wynn/'):
                    rel_path = name[len('assets/minecraft/textures/wynn/'):]
                    dest = os.path.join(wynn_dir, rel_path)
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                    data = read_zip_entry(zip_fp, zinfo)
                    with open(dest, 'wb') as f:
                        f.write(data)
            except Exception:
                pass

    print(f"  -> Extracted {patched_entities} entity textures, {patched_items} item textures, and custom Wynn assets")

    # 3. Rebuild Texture Atlas 1.21.1.png matching prismarine-viewer layout with exact UV alignment
    print("[4/5] Rebuilding 1.21.1 texture atlas (512x512) matching prismarine-viewer UV layout...")
    
    # Load block states and models to map exact (x, y) slot per texture
    bm_path = os.path.join(textures_dir, '1.21.1/blocks_models.json')
    bs_raw_path = os.path.join(textures_dir, '1.21.1/blocks_states.json')
    bs_res_path = os.path.join(pv_base, 'blocksStates/1.21.1.json')

    def clean_name(name):
        if not isinstance(name, str): return ''
        if name.startswith('minecraft:'): name = name[len('minecraft:'):]
        if name.startswith('block/'): name = name[len('block/'):]
        if name.startswith('blocks/'): name = name[len('blocks/'):]
        return name

    models = {}
    if os.path.exists(bm_path):
        with open(bm_path) as f:
            models = json.load(f)

    def get_textures_for_model(mname):
        cur = clean_name(mname)
        tex_dict = {}
        visited = set()
        while cur and cur not in visited:
            visited.add(cur)
            m = models.get(cur) or models.get('block/' + cur) or models.get('minecraft:block/' + cur)
            if not m: break
            for k, v in m.get('textures', {}).items():
                if k not in tex_dict:
                    tex_dict[k] = v
            cur = clean_name(m.get('parent', ''))
        for k in list(tex_dict.keys()):
            val = tex_dict[k]
            hops = 0
            while isinstance(val, str) and val.startswith('#') and hops < 10:
                ref = val[1:]
                if ref in tex_dict:
                    val = tex_dict[ref]
                else:
                    break
                hops += 1
            tex_dict[k] = val
        return tex_dict

    tile_to_tex = {}
    tex_to_tile = {}

    def process_model(raw_item, rv):
        if not isinstance(raw_item, dict) or not isinstance(rv, dict): return
        m_name = raw_item.get('model')
        if not m_name: return
        tex_map = get_textures_for_model(m_name)
        m_resolved = rv.get('model', {})
        t_resolved = m_resolved.get('textures', {})
        for tkey, tinfo in t_resolved.items():
            if isinstance(tinfo, dict) and 'u' in tinfo and 'v' in tinfo:
                x = round(tinfo['u'] / 0.03125)
                y = round(tinfo['v'] / 0.03125)
                raw_val = tex_map.get(tkey)
                if raw_val and isinstance(raw_val, str) and not raw_val.startswith('#'):
                    tex_file = clean_name(raw_val) + '.png'
                    tile_to_tex[(x, y)] = tex_file
                    tex_to_tile[tex_file] = (x, y)

    if os.path.exists(bs_raw_path) and os.path.exists(bs_res_path):
        with open(bs_raw_path) as f:
            raw_states = json.load(f)
        with open(bs_res_path) as f:
            resolved_states = json.load(f)

        for bname, rdata in resolved_states.items():
            if not isinstance(rdata, dict): continue
            raw_block = raw_states.get(bname, {})
            if 'variants' in rdata and 'variants' in raw_block:
                for vkey, rvar in rdata['variants'].items():
                    raw_var = raw_block['variants'].get(vkey, {})
                    rv_list = rvar if isinstance(rvar, list) else [rvar]
                    raw_list = raw_var if isinstance(raw_var, list) else [raw_var]
                    for rv, raw_item in zip(rv_list, raw_list):
                        process_model(raw_item, rv)
            if 'multipart' in rdata and 'multipart' in raw_block:
                for rpart, rawpart in zip(rdata['multipart'], raw_block['multipart']):
                    rapply = rpart.get('apply', {})
                    rawapply = rawpart.get('apply', {})
                    r_list = rapply if isinstance(rapply, list) else [rapply]
                    raw_list = rawapply if isinstance(rawapply, list) else [rawapply]
                    for rv, raw_item in zip(r_list, raw_list):
                        process_model(raw_item, rv)

    print(f"  -> Discovered {len(tile_to_tex)} exact UV tile coordinates from block models")

    # Build 512x512 atlas (32x32 tiles of 16x16 pixels)
    tex_size = 32
    tile_size = 16
    img_size = tex_size * tile_size # 512
    atlas = Image.new('RGBA', (img_size, img_size), (0, 0, 0, 0))
    missing_texture_path = os.path.abspath(os.path.join(pv_base, '../viewer/lib/missing_texture.png'))

    # (0, 0) is missing_texture
    if os.path.exists(missing_texture_path):
        t_img = Image.open(missing_texture_path).convert('RGBA').resize((16, 16))
        atlas.paste(t_img, (0, 0))

    # Place resolved textures in their exact slots
    placed_tiles = set([(0, 0)])
    placed_textures = set(['missing_texture.png'])

    for (tx, ty), tex_file in tile_to_tex.items():
        if tx < 0 or tx >= tex_size or ty < 0 or ty >= tex_size:
            continue
        file_path = os.path.join(blocks_dir, tex_file)
        if os.path.exists(file_path):
            try:
                t_img = Image.open(file_path).convert('RGBA')
                if t_img.size != (16, 16):
                    t_img = t_img.crop((0, 0, 16, 16))
                atlas.paste(t_img, (tx * tile_size, ty * tile_size))
                placed_tiles.add((tx, ty))
                placed_textures.add(tex_file)
            except Exception:
                pass

    # Fill remaining unmapped slots with remaining textures
    unplaced_files = [f for f in original_texture_files if f not in placed_textures]
    unplaced_iter = iter(unplaced_files)
    for ty in range(tex_size):
        for tx in range(tex_size):
            if (tx, ty) not in placed_tiles:
                try:
                    tex_file = next(unplaced_iter)
                    file_path = os.path.join(blocks_dir, tex_file)
                    if os.path.exists(file_path):
                        t_img = Image.open(file_path).convert('RGBA')
                        if t_img.size != (16, 16):
                            t_img = t_img.crop((0, 0, 16, 16))
                        atlas.paste(t_img, (tx * tile_size, ty * tile_size))
                except StopIteration:
                    break

    atlas_1211_path = os.path.join(textures_dir, '1.21.1.png')
    atlas.save(atlas_1211_path, format='PNG')
    print(f"  -> Saved Wynncraft atlas to {atlas_1211_path}")

    # Create 26.1.png (protocol 775 alias used by WynnProxy)
    atlas_261_path = os.path.join(textures_dir, '26.1.png')
    atlas.save(atlas_261_path, format='PNG')
    print(f"  -> Saved protocol 26.1 Wynncraft atlas to {atlas_261_path}")

    # 4. Copy blocksStates/1.21.1.json to blocksStates/26.1.json
    bs_dir = os.path.join(pv_base, 'blocksStates')
    bs_1211 = os.path.join(bs_dir, '1.21.1.json')
    bs_261 = os.path.join(bs_dir, '26.1.json')
    if os.path.exists(bs_1211):
        shutil.copyfile(bs_1211, bs_261)
        print(f"  -> Linked block states to {bs_261}")

    # Copy 1.21.1 textures dir to 26.1 dir
    t_261_dir = os.path.join(textures_dir, '26.1')
    if not os.path.exists(t_261_dir):
        try:
            os.symlink(os.path.join(textures_dir, '1.21.1'), t_261_dir)
            print(f"  -> Symlinked {t_261_dir} -> 1.21.1")
        except OSError:
            shutil.copytree(os.path.join(textures_dir, '1.21.1'), t_261_dir)
            print(f"  -> Copied {t_261_dir} -> 1.21.1")

    # 5. Place in Prism Launcher resource pack folders
    print("[5/5] Deploying Wynncraft Resource Pack to Prism Launcher instance...")
    prism_dir = os.environ.get("PRISM_DIR")
    if not prism_dir:
        if sys.platform == 'darwin':
            prism_dir = os.path.expanduser('~/Library/Application Support/PrismLauncher')
        else:
            candidates = [
                os.path.expanduser('~/.local/share/PrismLauncher'),
                os.path.expanduser('~/.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher')
            ]
            prism_dir = next((c for c in candidates if os.path.exists(c)), candidates[0])

    prism_server_rp = os.path.join(prism_dir, 'instances/Wynncraft-1.21.11/minecraft/server-resource-packs')
    prism_rp = os.path.join(prism_dir, 'instances/Wynncraft-1.21.11/minecraft/resourcepacks')
    os.makedirs(prism_server_rp, exist_ok=True)
    os.makedirs(prism_rp, exist_ok=True)

    dest_server_pack = os.path.join(prism_server_rp, 'wynncraft_official.zip')
    dest_rp_pack = os.path.join(prism_rp, 'Wynncraft-Official.zip')
    shutil.copyfile(rp_zip_path, dest_server_pack)
    shutil.copyfile(rp_zip_path, dest_rp_pack)
    print(f"  -> Deployed to {dest_server_pack} and {dest_rp_pack}")

    print("\n\033[1;32m✔ SUCCESS: Official Wynncraft Texture Pack applied to 3D Viewer & Prism Launcher!\033[0m")

if __name__ == '__main__':
    apply_wynncraft_textures()
