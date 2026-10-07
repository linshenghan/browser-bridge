import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join, relative, isAbsolute } from "node:path";
import {
  mkdir,
  readFile,
  writeFile,
  appendFile,
  access,
} from "node:fs/promises";
import assert from "node:assert/strict";
import { stage } from "../scripts/stage-package.mjs";
const run = promisify(execFile),
  workspace = resolve("."),
  root = join(workspace, "test-results", "installer-" + Date.now());
const rel = relative(workspace, root);
if (rel.startsWith("..") || isAbsolute(rel))
  throw new Error("Installer test target escaped workspace");
await mkdir(root, { recursive: true });
const pkg = await stage(
  join(root, "package"),
  resolve("bin/browser-bridge.exe"),
);
const binary = join(pkg, "browser-bridge.exe"),
  data = join(root, "service");
const env = { ...process.env, TBB_DATA_DIR: data };
const command = async (...args) =>
  JSON.parse((await run(binary, args, { env, windowsHide: true })).stdout);
const first = await command("install", "--source", pkg, "--skip-codex");
assert.equal(first.codexInstalled, false);
assert.equal(first.extensionId, "omheddjpegohbakodeeikcjenjgenmfj");
await mkdir(join(data, "results"), { recursive: true });
const retained = join(data, "results", "retain.txt");
await writeFile(retained, "task data must survive upgrade and uninstall");
const original = JSON.parse(
  await readFile(join(data, "installation.json"), "utf8"),
);
await appendFile(
  join(pkg, "extension", "ui.css"),
  "\n/* installer rollback fixture */\n",
);
await command("install", "--source", pkg, "--skip-codex");
const updated = JSON.parse(
  await readFile(join(data, "installation.json"), "utf8"),
);
assert.notEqual(updated.current, original.current);
assert.equal(updated.previous, original.current);
await command("rollback");
const rolled = JSON.parse(
  await readFile(join(data, "installation.json"), "utf8"),
);
assert.equal(rolled.current, original.current);
assert.equal(
  await readFile(retained, "utf8"),
  "task data must survive upgrade and uninstall",
);
const health = await command("doctor");
assert.equal(health.nativeHostRegistered, true);
const removed = await command("uninstall");
assert.equal(removed.uninstalled, true);
assert.deepEqual(removed.pendingRemoval, []);
await assert.rejects(access(join(data, "extension")));
assert.equal(
  await readFile(retained, "utf8"),
  "task data must survive upgrade and uninstall",
);
const report = {
  passed: true,
  checkedAt: new Date().toISOString(),
  checks: [
    "current-user install",
    "stable extension ID",
    "extension-only content update has distinct release",
    "previous release retained",
    "rollback without unexpected Codex install",
    "native host registration",
    "owned uninstall",
    "user task data retained",
  ],
  root,
};
await writeFile(
  "test-results/installer-report.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
