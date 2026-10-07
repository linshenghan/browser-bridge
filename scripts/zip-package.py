"""Developer packaging helper; end users do not need Python."""
import sys
import zipfile
from pathlib import Path

root = Path(sys.argv[1]).resolve()
target = Path(sys.argv[2]).resolve()
source = "--source" in sys.argv[3:]
excluded = {"node_modules", "test-results", "bin", ".git", "__pycache__"}
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        if source and (any(p in excluded for p in rel.parts) or rel.parts[:2] == ("extension", "dist")):
            continue
        if path == target:
            continue
        info = zipfile.ZipInfo(str(Path("browser-bridge" if source else root.name) / rel).replace("\\", "/"))
        info.create_system = 3
        info.compress_type = zipfile.ZIP_DEFLATED
        executable = path.suffix == ".sh" or path.name == "browser-bridge"
        info.external_attr = (0o100755 if executable else 0o100644) << 16
        archive.writestr(info, path.read_bytes())
print(target)
