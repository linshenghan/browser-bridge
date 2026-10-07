import {
  mkdir,
  cp,
  copyFile,
  readFile,
  writeFile,
  readdir,
  stat,
  chmod,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { stage } from "./stage-package.mjs";
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const run = promisify(execFile),
  out = resolve("../../outputs/browser-bridge");
await mkdir(out, { recursive: true });
const licenses = resolve("test-results/third-party-licenses");
await mkdir(licenses, { recursive: true });
async function copyLicense(src, dest) {
  const data = await readFile(src);
  try {
    if (data.equals(await readFile(dest))) return;
    // Earlier builds may preserve Go's read-only module-cache file mode.
    await chmod(dest, 0o644);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(resolve(dest, ".."), { recursive: true });
  await writeFile(dest, data, { mode: 0o644 });
}
async function copyLicenses(src, dest) {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const from = join(src, entry.name), to = join(dest, entry.name);
    if (entry.isDirectory()) await copyLicenses(from, to);
    else if (entry.isFile()) await copyLicense(from, to);
  }
}
const raw = (await run("go", ["list", "-m", "-json", "all"])).stdout.trim();
const modules = JSON.parse("[" + raw.replace(/}\r?\n{/g, "},{") + "]");
await writeFile(
  join(licenses, "MODULES.json"),
  JSON.stringify(
    modules
      .filter((m) => !m.Main)
      .map((m) => ({ module: m.Path, version: m.Version, sum: m.Sum })),
    null,
    2,
  ),
);
for (const mod of modules.filter((m) => !m.Main && m.Dir)) {
  const dir = join(licenses, mod.Path.replaceAll("/", "_") + "@" + mod.Version);
  await mkdir(dir, { recursive: true });
  for (const f of await readdir(mod.Dir)) {
    if (
      /^(LICENSE|NOTICE|COPYING|AUTHORS)(\.|$)/i.test(f) &&
      (await stat(join(mod.Dir, f))).isFile()
    )
      await copyLicense(join(mod.Dir, f), join(dir, f));
  }
}
const platforms = [
  ["windows-x64", "Windows-x64", "bin/browser-bridge.exe"],
  ["macos-arm64", "Mac-Apple-Silicon", "bin/darwin-arm64/browser-bridge"],
  ["macos-intel", "Mac-Intel", "bin/darwin-amd64/browser-bridge"],
];
for (const [slug, name, binary] of platforms) {
  const dir = join(out, name);
  await stage(dir, resolve(binary));
  await copyFile("README.md", join(dir, "开始使用.md"));
  await copyFile("SOURCE-NOTICE.md", join(dir, "SOURCE-NOTICE.md"));
  await cp("docs", join(dir, "docs"), { recursive: true });
  await copyLicenses(licenses, join(dir, "third-party-licenses"));
  if (slug.startsWith("windows")) {
    const cmd = (command) =>
      `@echo off\r\nchcp 65001 >nul\r\n"%~dp0browser-bridge.exe" ${command}\r\nif errorlevel 1 echo 操作未完成，请查看上方错误和开始使用说明。\r\npause\r\n`;
    for (const [name, command] of [
      ["安装-Windows.cmd", 'install --source "%~dp0."'],
      [
        "仅安装浏览器组件-Windows.cmd",
        'install --source "%~dp0." --skip-codex',
      ],
      ["导出MCP配置-Windows.cmd", 'mcp-config > "%~dp0MCP配置.json"'],
      ["自检-Windows.cmd", 'doctor --output "%~dp0diagnostics.zip"'],
      ["卸载-Windows.cmd", "uninstall"],
      ["回滚-Windows.cmd", "rollback"],
    ])
      await writeFile(join(dir, name), cmd(command));
  } else {
    const script = (command) =>
      `#!/bin/bash\nset -euo pipefail\nif [[ "$(uname -s)" != "Darwin" ]]; then printf '此脚本仅适用于 macOS。\\n' >&2; exit 1; fi\nSCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"\n# 内部开发包：仅赋予本产品程序执行权限，不修改系统安全策略。\nchmod u+x "$SCRIPT_DIR/browser-bridge"\n"$SCRIPT_DIR/browser-bridge" ${command}\n`;
    for (const [name, command] of [
      ["安装-macOS.sh", 'install --source "$SCRIPT_DIR"'],
      [
        "仅安装浏览器组件-macOS.sh",
        'install --source "$SCRIPT_DIR" --skip-codex',
      ],
      ["导出MCP配置-macOS.sh", 'mcp-config > "$SCRIPT_DIR/MCP配置.json"'],
      ["自检-macOS.sh", 'doctor --output "$SCRIPT_DIR/diagnostics.zip"'],
      ["卸载-macOS.sh", "uninstall"],
      ["回滚-macOS.sh", "rollback"],
    ])
      await writeFile(join(dir, name), script(command), { mode: 0o755 });
    await copyFile("docs/Mac实机验收清单.md", join(dir, "Mac实机验收清单.md"));
  }
  await run("python", [
    "scripts/zip-package.py",
    dir,
    join(out, `browser-bridge-v${version}-${slug}.zip`),
  ]);
}
for (const [src, name] of [
  ["README.md", "开始使用.md"],
  ["docs/Mac实机验收清单.md", "Mac实机验收清单.md"],
  ["docs/验收报告.md", "验收报告.md"],
  ["docs/其他智能体接入.md", "WorkBuddy与Claude接入.md"],
]) {
  try {
    await copyFile(src, join(out, name));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
await run("python", [
  "scripts/zip-package.py",
  resolve("."),
  join(out, `browser-bridge-v${version}-source.zip`),
  "--source",
]);
const hashes = [];
for (const f of (await readdir(out)).filter((f) => f.endsWith(".zip")).sort()) {
  hashes.push(
    createHash("sha256")
      .update(await readFile(join(out, f)))
      .digest("hex") +
      "  " +
      f,
  );
}
await writeFile(join(out, "SHA256SUMS.txt"), hashes.join("\n") + "\n");
console.log(JSON.stringify({ outputDirectory: out, packages: hashes.length }));
