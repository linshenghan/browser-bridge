"""Check assembled archives without executing or installing them."""
import hashlib, json, struct, zipfile
from pathlib import Path
from datetime import datetime, timezone
root = Path(__file__).resolve().parents[1]
out = root.parents[1] / 'outputs' / 'browser-bridge'
manifest = json.loads((root/'extension/dist/manifest.json').read_text(encoding='utf-8'))
worker = manifest['background']['service_worker']
checks = []
for suffix,folder,binary,cpu in [('windows-x64','Windows-x64','browser-bridge.exe',None),('macos-arm64','Mac-Apple-Silicon','browser-bridge',0x100000C),('macos-intel','Mac-Intel','browser-bridge',0x1000007)]:
    name = f'browser-bridge-v0.2.0-{suffix}.zip'
    with zipfile.ZipFile(out/name) as z:
        assert z.testzip() is None
        prefix = folder+'/'
        m = json.loads(z.read(prefix+'extension/manifest.json'))
        assert m == manifest
        assert z.read(prefix+'extension/'+worker) == (root/'extension/dist'/worker).read_bytes()
        blob = z.read(prefix+binary)
        local = root/'bin'/({'macos-arm64':'darwin-arm64/browser-bridge','macos-intel':'darwin-amd64/browser-bridge'}.get(suffix,'browser-bridge.exe'))
        assert blob == local.read_bytes()
        if cpu is None: assert blob[:2] == b'MZ'
        else:
            assert struct.unpack('<II',blob[:8]) == (0xFEEDFACF,cpu)
            assert z.getinfo(prefix+binary).external_attr >> 16 & 0o111
        assert any('/third-party-licenses/' in n for n in z.namelist())
        checks.append({'archive':name,'files':len(z.namelist()),'valid':True,'binaryMatchesBuild':True})
with zipfile.ZipFile(out/'browser-bridge-v0.2.0-source.zip') as z:
    assert z.testzip() is None
    names = z.namelist()
    assert 'browser-bridge/extension/src/driver.ts' in names
    assert not any('/node_modules/' in n or '/test-results/' in n or '/小红书实机验收/' in n or n.endswith('.xlsx') for n in names)
    checks.append({'archive':'browser-bridge-v0.2.0-source.zip','files':len(names),'valid':True,'privateExportsExcluded':True})
for line in (out/'SHA256SUMS.txt').read_text().splitlines():
    expected,name = line.split('  ',1)
    assert hashlib.sha256((out/name).read_bytes()).hexdigest() == expected, name
report = {'version':'0.2.0','checkedAt':datetime.now(timezone.utc).isoformat(),'sha256':'all match','workerEntry':worker,'archives':checks}
(out/'交付包完整性检查.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))
