import { mkdir, cp, copyFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
export async function stage(target, binary) {
  target = resolve(target);
  await mkdir(target, { recursive: true });
  await copyFile(
    binary,
    join(
      target,
      binary.endsWith(".exe")
        ? "browser-bridge.exe"
        : "browser-bridge",
    ),
  );
  await cp("extension/dist", join(target, "extension"), { recursive: true });
  for (const f of [".codex-plugin", ".mcp.json", "skills"])
    await cp(f, join(target, "plugin", f), { recursive: true });
  return target;
}
if (process.argv[1]?.endsWith("stage-package.mjs"))
  console.log(
    await stage(
      process.argv[2] || "test-results/package",
      process.argv[3] || "bin/browser-bridge.exe",
    ),
  );
