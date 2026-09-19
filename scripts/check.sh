#!/usr/bin/env bash
# Repository checks that do not need Prism, Java, Node dependencies, or secrets.
set -euo pipefail

python3 -m json.tool instance/mmc-pack.json >/dev/null
python3 -m json.tool instance/mods.json >/dev/null
python3 -m json.tool package.json >/dev/null
python3 -m py_compile scripts/wynn_price_server.py
bash -n scripts/install.sh scripts/launch-prism.sh scripts/preflight.sh

python3 - <<'PY'
import json
from pathlib import Path

manifest = json.loads(Path("instance/mods.json").read_text())
ids = [mod["id"] for mod in manifest["mods"]]
assert len(ids) == len(set(ids)), "duplicate mod id"
for mod in manifest["mods"]:
    assert mod["url"].startswith("https://cdn.modrinth.com/"), mod["id"]
    assert len(mod["sha512"]) == 128, mod["id"]
print(f"validated {len(ids)} pinned Fabric mods")
PY
