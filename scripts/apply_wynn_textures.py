#!/usr/bin/env python3
"""
Applies the official Wynncraft resource pack textures to prismarine-viewer and Prism Launcher.
- Extracts block, item, entity, and custom textures from the Wynncraft resource pack,
  handling Wynncraft's custom zip obfuscation (empty local headers & scrambled PNG CRCs).
- Patches matching block texture files and regenerates the texture atlas of the version
  the 3D viewer renders with, preserving the exact vanilla layout so block models align.
- The render version must match mineflayer-wynn/src/blockstates.js: Wynncraft speaks
  protocol 775 ('26.1'), which prismarine-viewer's browser bundle cannot render, so the
  viewer renders as RENDER_VERSION and translates block state ids. Override both with
  WYNN_VIEWER_MC_VERSION.
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

# Minecraft version the 3D viewer renders with; keep in sync with
# mineflayer-wynn/src/blockstates.js (DEFAULT_RENDER_VERSION).
RENDER_VERSION = os.environ.get('WYNN_VIEWER_MC_VERSION', '1.21.4')

# Minecraft textures are 16x16 pixels per atlas tile.
TILE_SIZE = 16

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
    version_dir = os.path.join(textures_dir, RENDER_VERSION)
    if not os.path.isdir(version_dir):
        print(f"Error: prismarine-viewer has no assets for render version {RENDER_VERSION} ({version_dir})")
        sys.exit(1)
    blocks_dir = os.path.join(version_dir, 'blocks')
    entities_dir = os.path.join(version_dir, 'entity')
    items_dir = os.path.join(version_dir, 'items')
    wynn_dir = os.path.join(version_dir, 'wynn')
    os.makedirs(wynn_dir, exist_ok=True)

    print(f"[1/5] Opening Wynncraft resource pack ({os.path.getsize(rp_zip_path) // 1024 // 1024} MB)...")
    zf = zipfile.ZipFile(rp_zip_path, 'r')

    # Capture vanilla file list in alphabetical order BEFORE patching so UV layout remains 100% stable
    original_texture_files = sorted([f for f in os.listdir(blocks_dir) if f.endswith('.png')])
    existing_blocks = set(original_texture_files)

    # 1. Update block textures
    print(f"[2/5] Patching block textures with Wynncraft custom block art ({len(existing_blocks)} base blocks)...")
    patched_blocks = 0
    patched_files = set()
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
                    patched_files.add(filename)
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

    # 3. Rebuild the render version's texture atlas matching prismarine-viewer layout with exact UV alignment
    print(f"[4/5] Patching {RENDER_VERSION} texture atlas to match prismarine-viewer UV layout...")
    
    # Load block states and models to map exact (x, y) slot per texture
    bm_path = os.path.join(version_dir, 'blocks_models.json')
    bs_raw_path = os.path.join(version_dir, 'blocks_states.json')
    bs_res_path = os.path.join(pv_base, 'blocksStates', f'{RENDER_VERSION}.json')

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

    # The atlas geometry differs per version (1.21.1 is 32x32 tiles, 1.21.4 is 64x64),
    # and blocksStates UVs are fractions of the whole atlas, so derive the grid from the
    # vanilla atlas instead of assuming a size.
    atlas_path = os.path.join(textures_dir, f'{RENDER_VERSION}.png')
    vanilla_atlas_path = os.path.join(textures_dir, f'{RENDER_VERSION}.vanilla.png')
    if not os.path.exists(atlas_path):
        print(f"Error: prismarine-viewer atlas not found at {atlas_path}")
        sys.exit(1)
    # Snapshot the untouched atlas once so re-runs always patch a clean base.
    if not os.path.exists(vanilla_atlas_path):
        shutil.copyfile(atlas_path, vanilla_atlas_path)

    atlas = Image.open(vanilla_atlas_path).convert('RGBA')
    if atlas.width % TILE_SIZE or atlas.height % TILE_SIZE:
        print(f"Error: atlas {atlas.size} is not a whole number of {TILE_SIZE}px tiles")
        sys.exit(1)
    tiles_per_row = atlas.width // TILE_SIZE
    tiles_per_col = atlas.height // TILE_SIZE

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
                x = round(tinfo['u'] * tiles_per_row)
                y = round(tinfo['v'] * tiles_per_col)
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

    print(f"  -> Discovered {len(tile_to_tex)} exact UV tile coordinates from block models "
          f"({tiles_per_row}x{tiles_per_col} tile atlas)")

    # Paste the Wynncraft art into the tiles we resolved, leaving every other tile
    # exactly as the vanilla atlas has it. Rebuilding the atlas from scratch and
    # back-filling unresolved slots would move textures out from under the UVs that
    # blocksStates already points at.
    replaced_tiles = 0
    skipped_tiles = 0
    for (tx, ty), tex_file in tile_to_tex.items():
        if tx < 0 or tx >= tiles_per_row or ty < 0 or ty >= tiles_per_col:
            skipped_tiles += 1
            continue
        if tex_file not in patched_files:
            continue
        file_path = os.path.join(blocks_dir, tex_file)
        if not os.path.exists(file_path):
            continue
        try:
            t_img = Image.open(file_path).convert('RGBA')
            if t_img.size != (TILE_SIZE, TILE_SIZE):
                t_img = t_img.crop((0, 0, TILE_SIZE, TILE_SIZE))
            atlas.paste(t_img, (tx * TILE_SIZE, ty * TILE_SIZE))
            replaced_tiles += 1
        except Exception:
            pass

    atlas.save(atlas_path, format='PNG')
    print(f"  -> Replaced {replaced_tiles} atlas tiles with Wynncraft art "
          f"({skipped_tiles} out-of-range UVs skipped)")
    print(f"  -> Saved Wynncraft atlas to {atlas_path}")

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
