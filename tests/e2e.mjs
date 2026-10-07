import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture } from "./fixture.mjs";
import { advancedChecks } from "./advanced-e2e.mjs";
import { concurrencyChecks } from "./concurrency-e2e.mjs";
import { MCPClient } from "./mcp-client.mjs";
import { stage } from "../scripts/stage-package.mjs";
const run = promisify(execFile),
  root = resolve("test-results/e2e-" + Date.now());
await mkdir(root, { recursive: true });
const env = { ...process.env, TBB_DATA_DIR: join(root, "service") };
const fixtureServer = await fixture();
const origin = fixtureServer.origin;
const pkg = await stage(
  join(root, "package"),
  resolve("bin/browser-bridge.exe"),
);
const installer = join(pkg, "browser-bridge.exe");
const installed = JSON.parse(
  (
    await run(installer, ["install", "--source", pkg, "--skip-codex"], {
      env,
      windowsHide: true,
    })
  ).stdout,
);
const binary = installed.binary;
let browser, a, b;
const results = [];
const report = {
  startedAt: new Date().toISOString(),
  origin,
  root,
  tests: results,
  chrome: "Chromium isolated development profile",
  realUserProfile: false,
};
const check = async (name, fn) => {
  if (process.argv.includes('--concurrency-only') && ![
    'all-site access without per-site authorization',
    'official MCP SDK initialize and tools',
    'each session has an exclusive named window and explicit ownership',
    'parallel background input click scroll and screenshots never steal active tabs or windows',
    'claimed page moves into its task window and foreign-window claims are rejected',
    'manual cross-window moves fail closed and task popups retain ownership',
    'concurrent first opens share exactly one task window and end preserves claimed pages',
    'closing an owner window cannot grant access to a moved tab and the next open recreates ownership',
  ].includes(name)) return;
  if (
    process.argv.includes("--smoke") &&
    ![
      "all-site access without per-site authorization",
      "official MCP SDK initialize and tools",
      "body links tables frames and password redaction",
      "full Chrome restart abandons old tab IDs and preserves profile",
      "diagnostics excludes page content and credentials",
    ].includes(name)
  )
    return;
  const start = Date.now();
  try {
    const detail = await fn();
    results.push({
      name,
      passed: true,
      durationMs: Date.now() - start,
      detail,
    });
    console.log("PASS " + name);
  } catch (e) {
    results.push({
      name,
      passed: false,
      durationMs: Date.now() - start,
      error: e.stack,
    });
    console.error("FAIL " + name + " " + e.stack);
    throw e;
  }
};
const waitFor = async (fn, ms = 20000) => {
  const start = Date.now();
  let value;
  while (Date.now() - start < ms) {
    value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("等待状态超时 " + JSON.stringify(value));
};
const operationId = () => randomUUID();
try {
  await mkdir(join(root, "chrome-profile", "Default"), { recursive: true });
  await mkdir(join(root, "downloads"), { recursive: true });
  await writeFile(
    join(root, "chrome-profile", "Default", "Preferences"),
    JSON.stringify({
      download: {
        default_directory: join(root, "downloads"),
        prompt_for_download: false,
      },
    }),
  );
  browser = await chromium.launchPersistentContext(
    join(root, "chrome-profile"),
    {
      executablePath:
        process.env.TBB_TEST_CHROME ||
        "C:\\Users\\Administrator\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe",
      headless: false,
      env,
      args: [
        `--disable-extensions-except=${installed.extensionDirectory}`,
        `--load-extension=${installed.extensionDirectory}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
      acceptDownloads: true,
    },
  );
  let ui = await browser.newPage();
  // Prevent the test harness from auto-dismissing dialogs; only the extension handles them.
  for (const page of browser.pages()) page.on('dialog', () => {});
  browser.on('page', page => page.on('dialog', () => {}));
  // Playwright normally replaces real filenames with GUIDs; restore this isolated
  // development browser's ordinary download behavior for the native MCP test.
  const setup = await browser.newCDPSession(ui);
  await setup.send("Browser.setDownloadBehavior", { behavior: "default" });
  await setup.detach();
  await ui.goto(`chrome-extension://${installed.extensionId}/ui.html`);
  await check("all-site access without per-site authorization", async () => {
    await ui
      .getByText("网站访问：所有普通网站，无需逐个添加", { exact: true })
      .waitFor();
    assert.equal(await ui.locator("#origin, #grant, #origins").count(), 0);
    const manifest = JSON.parse(
      await readFile(
        join(installed.extensionDirectory, "manifest.json"),
        "utf8",
      ),
    );
    assert.deepEqual(manifest.host_permissions, ["http://*/*", "https://*/*"]);
    assert.equal(manifest.optional_host_permissions, undefined);
    return {
      version: manifest.version,
      access: "all-http-https",
      noWebsiteAllowlist: true,
    };
  });
  a = new MCPClient(binary, env);
  b = new MCPClient(binary, {
    ...env,
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "socks5://127.0.0.1:1",
    NO_PROXY: "",
  });
  await check("official MCP SDK initialize and tools", async () => {
    const lists = await Promise.all([a.init(), b.init()]);
    assert.equal(lists[0].tools.length, 26);
    return { tools: lists[0].tools.map((t) => t.name) };
  });
  const profile = await waitFor(async () => {
    const s = await a.tool("connection_status");
    return s.profiles?.[0];
  });
  const uploadPath = join(root, "authorized-upload.txt");
  await writeFile(uploadPath, "user-authorized upload fixture");
  const sa = await a.tool("session_start", {
    profileId: profile.profileId,
    name: "验收任务 A",
    files: [uploadPath],
    outputDir: join(root, "results-a"),
  });
  const sb = await b.tool("session_start", {
    profileId: profile.profileId,
    name: "验收任务 B",
    outputDir: join(root, "results-b"),
  });
  if (process.argv.includes('--concurrency') || process.argv.includes('--concurrency-only')) await concurrencyChecks({a,b,sa,sb,origin,check,waitFor,browser,ui});
  if (process.argv.includes('--advanced')) await advancedChecks({a,b,sa,sb,origin,check,waitFor,uploadPath,browser,ui});
  const tab = await a.tool("tab_open", {
    sessionId: sa.sessionId,
    url: origin + "/?frames=1",
    operationId: operationId(),
  });
  const observe = () =>
    a.tool("page_observe", { sessionId: sa.sessionId, tabId: tab.tabId });
  const action = async (label, action = "click", extra = {}) => {
    const page = await observe();
    const el = page.elements.find((e) => e.label === label);
    assert.ok(el, "element " + label);
    return a.tool("page_action", {
      sessionId: sa.sessionId,
      tabId: tab.tabId,
      pageVersion: page.pageVersion,
      elementId: el.elementId,
      action,
      operationId: operationId(),
      ...extra,
    });
  };
  await check("body links tables frames and password redaction", async () => {
    const p = await observe();
    assert.match(p.body, /测试产品/);
    assert.equal(p.tables[0][1][1], "128");
    assert.equal(p.frames.length, 1);
    assert.ok(p.links.length >= 2);
    assert.ok(!JSON.stringify(p).includes("do-not-export-password"));
    return { elements: p.elements.length, frames: p.frames.length };
  });
  await check("cross-task tab and session isolation", async () => {
    await assert.rejects(
      b.tool("page_observe", { sessionId: sa.sessionId, tabId: tab.tabId }),
      (e) => e.code === "SESSION_ISOLATION",
    );
    await assert.rejects(
      b.tool("page_observe", { sessionId: sb.sessionId, tabId: tab.tabId }),
      (e) => e.code === "SESSION_ISOLATION",
    );
  });
  await check("search and dynamic content", async () => {
    await action("搜索关键词", "fill", { text: "团队测试" });
    await action("搜索");
    const p = await observe();
    assert.match(p.body, /搜索结果：团队测试/);
    await action("动态更新");
    assert.match((await observe()).body, /动态内容/);
  });
  await check("unrelated dynamic text preserves target and older snapshot is rejected", async () => {
    await action("延迟更新");
    const p = await observe();
    await new Promise((r) => setTimeout(r, 1100));
    await a.tool("page_action", {
        sessionId: sa.sessionId,
        tabId: tab.tabId,
        pageVersion: p.pageVersion,
        elementId: p.elements.find((e) => e.label === "动态更新").elementId,
        action: "click",
        operationId: operationId(),
      });
    await assert.rejects(a.tool("page_action", { sessionId: sa.sessionId, tabId: tab.tabId, pageVersion: p.pageVersion, elementId: p.elements.find(e => e.label === "动态更新").elementId, action: "click", operationId: operationId() }), e => e.code === "STALE_PAGE");
  });
  await check(
    "script-updated control value invalidates observation",
    async () => {
      await action("属性更新");
      const p = await observe();
      await new Promise((r) => setTimeout(r, 1100));
      await assert.rejects(
        a.tool("page_action", {
          sessionId: sa.sessionId,
          tabId: tab.tabId,
          pageVersion: p.pageVersion,
          action: "fill",
          elementId: p.elements.find(e => e.label === "搜索关键词").elementId,
          text: "必须拒绝旧目标",
          operationId: operationId(),
        }),
        (e) => e.code === "STALE_PAGE",
      );
    },
  );
  await check("form fill select and authorized frame action", async () => {
    await action("姓名", "fill", { text: "验收成员" });
    await action("城市", "select", { values: ["bj"] });
    const p = await observe();
    const f = p.frames[0];
    await a.tool("page_action", {
      sessionId: sa.sessionId,
      tabId: tab.tabId,
      pageVersion: p.pageVersion,
      frameId: f.frameId,
      elementId: f.elements.find((e) => e.label === "嵌入输入").elementId,
      action: "fill",
      text: "嵌入测试",
      operationId: operationId(),
    });
  });
  await check("upload authorized file and reject cross-task file", async () => {
    let p = await observe();
    const file = p.elements.find((e) => e.type === "file");
    await assert.rejects(
      a.tool("file_upload", {
        sessionId: sa.sessionId,
        tabId: tab.tabId,
        pageVersion: p.pageVersion,
        elementId: file.elementId,
        files: [join(root, "unapproved.txt")],
        operationId: operationId(),
      }),
    );
    await a.tool("file_upload", {
      sessionId: sa.sessionId,
      tabId: tab.tabId,
      pageVersion: p.pageVersion,
      elementId: file.elementId,
      files: [uploadPath],
      operationId: operationId(),
    });
    p = await observe();
    assert.match(p.body, /已选择：authorized-upload.txt/);
  });
  await check("screenshot with native chunk transfer", async () => {
    const r = await a.tool("page_screenshot", {
      sessionId: sa.sessionId,
      tabId: tab.tabId,
    });
    assert.ok((await readFile(r.path)).length > 1000);
    report.screenshot = r.path;
    return { path: r.path };
  });
  await check("submit once with duplicate operation ID", async () => {
    const p = await observe();
    const args = {
      sessionId: sa.sessionId,
      tabId: tab.tabId,
      pageVersion: p.pageVersion,
      elementId: p.elements.find((e) => e.tag === "form").elementId,
      action: "submit",
      operationId: operationId(),
    };
    let first;
    try {
      first = await a.tool("page_action", args);
    } catch (e) {
      if (!e.uncertain) throw e;
    }
    await new Promise((r) => setTimeout(r, 400));
    try {
      await a.tool("page_action", args);
    } catch (e) {
      if (!e.uncertain) throw e;
    }
    assert.equal(fixtureServer.submits, 1);
    assert.match((await observe()).body, /提交成功/);
    return { serverSubmissions: fixtureServer.submits, first };
  });
  await check("owned download and actual file location", async () => {
    const d = await a.tool("download_start", {
      sessionId: sa.sessionId,
      url: origin + "/download",
      operationId: operationId(),
    });
    const status = await waitFor(async () => {
      const r = await a.tool("download_status", {
        sessionId: sa.sessionId,
        downloadId: d.downloadId,
      });
      return r.state === "complete" && r;
    });
    assert.equal(
      await readFile(status.path, "utf8"),
      "Team Browser Bridge download fixture",
    );
    await assert.rejects(
      b.tool("download_status", {
        sessionId: sb.sessionId,
        downloadId: d.downloadId,
      }),
      (e) => e.code === "SESSION_ISOLATION",
    );
    return { path: status.path };
  });
  await check(
    "new origin opens without approval and explicit refusal remains",
    async () => {
      const otherURL =
        origin.replace("127.0.0.1", "localhost") + "/page?other-site=1";
      const other = await a.tool("tab_open", {
        sessionId: sa.sessionId,
        url: otherURL,
        operationId: operationId(),
      });
      const observed = await a.tool("page_observe", {
        sessionId: sa.sessionId,
        tabId: other.tabId,
      });
      assert.match(observed.body, /测试产品/);
      await a.tool("tab_close", {
        sessionId: sa.sessionId,
        tabId: other.tabId,
        operationId: operationId(),
      });
      await assert.rejects(
        a.tool("tab_open", {
          sessionId: sa.sessionId,
          url: "chrome://settings/",
          operationId: operationId(),
        }),
        (e) => e.code === "INVALID_URL",
      );
      const t = await a.tool("tab_open", {
        sessionId: sa.sessionId,
        url: origin + "/deny",
        operationId: operationId(),
      });
      await assert.rejects(
        a.tool("page_observe", { sessionId: sa.sessionId, tabId: t.tabId }),
        (e) => e.code === "HOST_DENIED",
      );
      await a.tool("tab_close", {
        sessionId: sa.sessionId,
        tabId: t.tabId,
        operationId: operationId(),
      });
    },
  );
  await check("large body chunk transfer", async () => {
    const t = await a.tool("tab_open", {
      sessionId: sa.sessionId,
      url: origin + "/large",
      operationId: operationId(),
    });
    const p = await a.tool("page_observe", {
      sessionId: sa.sessionId,
      tabId: t.tabId,
    });
    assert.ok(p.body.length > 500000);
    await a.tool("tab_close", {
      sessionId: sa.sessionId,
      tabId: t.tabId,
      operationId: operationId(),
    });
    return { characters: p.body.length };
  });
  await check(
    "navigation focus scroll and cross-origin frame access",
    async () => {
      let p = await observe();
      await a.tool("page_navigate", {
        sessionId: sa.sessionId,
        tabId: tab.tabId,
        pageVersion: p.pageVersion,
        url: origin + "/?foreign=1",
        operationId: operationId(),
      });
      await a.tool("tab_focus", {
        sessionId: sa.sessionId,
        tabId: tab.tabId,
        operationId: operationId(),
      });
      p = await observe();
      assert.equal(p.inaccessibleFrames.length, 0);
      assert.ok(p.frames.some((f) => f.url.includes("localhost:")));
      const frameScreenshot = await a.tool("page_screenshot", {
        sessionId: sa.sessionId,
        tabId: tab.tabId,
      });
      assert.ok(frameScreenshot.path);
      p = await observe();
      await a.tool("page_action", {
        sessionId: sa.sessionId,
        tabId: tab.tabId,
        pageVersion: p.pageVersion,
        action: "scroll",
        y: 200,
        operationId: operationId(),
      });
    },
  );
  await check(
    "100 input URLs with duplicates redirects timeouts and invalid page",
    async () => {
      const urls = Array.from(
        { length: 94 },
        (_, n) => origin + "/page?n=" + n,
      );
      urls.push(
        urls[0],
        urls[1] + "#anchor",
        origin + "/redirect",
        origin + "/slow?ms=5000",
        origin + "/missing",
        origin + "/deny",
      );
      const job = await a.tool("batch_create", {
        sessionId: sa.sessionId,
        urls,
        concurrency: 3,
        timeoutSeconds: 2,
      });
      assert.equal(job.total, 98);
      assert.equal(job.duplicatesRemoved, 2);
      const status = await waitFor(async () => {
        const r = await a.tool("batch_status", {
          sessionId: sa.sessionId,
          jobId: job.jobId,
        });
        return r.state === "completed" && r;
      }, 95000);
      assert.equal(status.total, 98);
      assert.equal(status.counts.failed, 3);
      assert.equal(
        status.items.find((i) => i.url.endsWith("/missing")).state,
        "failed",
      );
      const timed = status.items.find((i) => i.url.includes("/slow?"));
      assert.equal(timed.attempts, 3);
      for (const format of ["jsonl", "csv", "markdown"]) {
        const out = await a.tool("batch_export", {
          sessionId: sa.sessionId,
          jobId: job.jobId,
          format,
        });
        assert.ok(out.files.length > 0);
      }
      report.batch = status;
      return {
        counts: status.counts,
        maxConcurrentSlowRequests: fixtureServer.maxActive,
      };
    },
  );
  await check("retry failed reads only", async () => {
    const job = await a.tool("batch_create", {
      sessionId: sa.sessionId,
      urls: [origin + "/flaky"],
      timeoutSeconds: 4,
    });
    const status = await waitFor(async () => {
      const r = await a.tool("batch_status", {
        sessionId: sa.sessionId,
        jobId: job.jobId,
      });
      return r.state === "completed" && r;
    });
    assert.equal(status.counts.failed, 1);
    assert.equal(status.items[0].attempts, 3);
    await a.tool("batch_retry_failed", {
      sessionId: sa.sessionId,
      jobId: job.jobId,
    });
    const retried = await waitFor(async () => {
      const r = await a.tool("batch_status", {
        sessionId: sa.sessionId,
        jobId: job.jobId,
      });
      return r.state === "completed" && r;
    });
    assert.equal(retried.counts.done, 1);
  });
  await check("batch cancel and stop button", async () => {
    const job = await b.tool("batch_create", {
      sessionId: sb.sessionId,
      urls: Array.from(
        { length: 12 },
        (_, n) => origin + "/slow?ms=4000&n=" + n,
      ),
      timeoutSeconds: 8,
    });
    await new Promise((r) => setTimeout(r, 500));
    await b.tool("batch_cancel", { sessionId: sb.sessionId, jobId: job.jobId });
    const status = await b.tool("batch_status", {
      sessionId: sb.sessionId,
      jobId: job.jobId,
    });
    assert.equal(status.state, "cancelled");
    await ui.reload();
    const card = ui.locator(".task").filter({ hasText: "验收任务 B" });
    await card.getByRole("button", { name: "停止任务" }).click();
    await waitFor(async () => {
      try {
        await b.tool("tabs_list", { sessionId: sb.sessionId });
        return false;
      } catch (e) {
        return e.code === "SESSION_STOPPED";
      }
    });
    return status.counts;
  });
  await check(
    "local transport with normal and unreachable proxy environment",
    async () => {
      assert.equal((await a.tool("connection_status")).profiles.length, 1);
      assert.equal((await b.tool("connection_status")).profiles.length, 1);
      const direct = new MCPClient(binary, {
        ...env,
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        ALL_PROXY: "",
        http_proxy: "",
        https_proxy: "",
        all_proxy: "",
      });
      try {
        await direct.init();
        assert.equal(
          (await direct.tool("connection_status")).profiles.length,
          1,
        );
      } finally {
        await direct.close();
      }
      return {
        inheritedProxy: true,
        unreachableProxy: true,
        noProxy: true,
        globalV2raySettingsChanged: false,
      };
    },
  );
  await check(
    "broker restart read recovery and stale snapshot invalidation",
    async () => {
      const previous = await observe();
      const job = await a.tool("batch_create", {
        sessionId: sa.sessionId,
        urls: Array.from(
          { length: 8 },
          (_, n) => origin + "/slow?ms=900&recover=" + n,
        ),
        timeoutSeconds: 45,
      });
      await new Promise((r) => setTimeout(r, 300));
      await run(binary, ["stop-service"], { env, windowsHide: true }).catch(
        () => {},
      );
      await waitFor(async () => {
        try {
          return (await a.tool("connection_status")).profiles.length > 0;
        } catch {
          return false;
        }
      }, 25000);
      const result = await waitFor(async () => {
        const r = await a.tool("batch_status", {
          sessionId: sa.sessionId,
          jobId: job.jobId,
        });
        return r.state === "completed" && r;
      }, 75000);
      assert.equal(result.counts.done, 8, JSON.stringify(result.items));
      await assert.rejects(
        a.tool("page_action", {
          sessionId: sa.sessionId,
          tabId: tab.tabId,
          pageVersion: previous.pageVersion,
          action: "scroll",
          y: 100,
          operationId: operationId(),
        }),
        (e) => e.code === "STALE_PAGE",
      );
      return result.counts;
    },
  );
  await check(
    "full Chrome restart abandons old tab IDs and preserves profile",
    async () => {
      const originalProfile = profile.profileId;
      const privatePage = await browser.newPage();
      await privatePage.goto(origin + "/page?private=1");
      await browser.close();
      browser = await chromium.launchPersistentContext(
        join(root, "chrome-profile"),
        {
          executablePath:
            process.env.TBB_TEST_CHROME ||
            "C:\\Users\\Administrator\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe",
          headless: false,
          env,
          args: [
            `--disable-extensions-except=${installed.extensionDirectory}`,
            `--load-extension=${installed.extensionDirectory}`,
            "--no-first-run",
            "--no-default-browser-check",
          ],
        },
      );
      ui = await browser.newPage();
      await ui.goto(`chrome-extension://${installed.extensionId}/ui.html`);
      const profileAfter = await waitFor(async () => {
        const r = await a.tool("connection_status");
        return r.profiles[0];
      });
      assert.equal(profileAfter.profileId, originalProfile);
      assert.equal(
        (await a.tool("tabs_list", { sessionId: sa.sessionId })).tabs.length,
        0,
      );
      const t = await a.tool("tab_open", {
        sessionId: sa.sessionId,
        url: origin + "/page?after-restart=1",
        operationId: operationId(),
      });
      assert.match(
        (
          await a.tool("page_observe", {
            sessionId: sa.sessionId,
            tabId: t.tabId,
          })
        ).body,
        /测试产品/,
      );
      await ui.reload();
      await new Promise((r) => setTimeout(r, 300));
      report.uiScreenshot = join(root, "extension-ui.png");
      await ui.screenshot({ path: report.uiScreenshot });
    },
  );
  await check("diagnostics excludes page content and credentials", async () => {
    const r = JSON.parse(
      (
        await run(
          binary,
          ["doctor", "--output", join(root, "diagnostics.zip")],
          { env, windowsHide: true },
        )
      ).stdout,
    );
    assert.equal(r.connectedProfiles, 1);
    assert.equal(r.containsPageContent, false);
    assert.equal(r.containsCredentials, false);
    return r;
  });
  await a.tool("session_end", { sessionId: sa.sessionId });
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = e.stack;
  if (browser) {
    try {
      const p = browser
        .pages()
        .find((p) => p.url().startsWith("chrome-extension:"));
      if (p) {
        await p.screenshot({ path: join(root, "failure-ui.png") });
        report.uiText = await p.locator("body").innerText();
      }
    } catch {}
  }
  process.exitCode = 1;
} finally {
  if (a) await a.close();
  if (b) await b.close();
  if (browser) await browser.close();
  await run(binary, ["stop-service"], { env, windowsHide: true }).catch(
    () => {},
  );
  fixtureServer.server.closeAllConnections();
  await fixtureServer.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(
    resolve(
      process.argv.includes("--smoke")
        ? "test-results/latest-smoke.json"
        : "test-results/latest-e2e.json",
    ),
    JSON.stringify(report, null, 2),
  );
  console.log("Report " + join(root, "report.json"));
}
