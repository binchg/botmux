#!/usr/bin/env python3
"""Build a VSIX with Python stdlib; no package downloads or signing secrets."""
from pathlib import Path
import json, sys, zipfile
root = Path(__file__).resolve().parent
output = Path(sys.argv[1]) if len(sys.argv) > 1 else root / f"botmux-codex-sync-{json.loads((root / 'package.json').read_text())['version']}.vsix"
with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as z:
    for name in ["[Content_Types].xml", "extension.vsixmanifest"]:
        z.write(root / name, name)
    for name in ["package.json", "extension.cjs", "sidebar.cjs", "sidebar.svg", "README.md"]:
        z.write(root / name, "extension/" + name)
print(output)
