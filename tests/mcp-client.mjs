import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
export class MCPClient {
  constructor(binary, env) {
    this.child = spawn(binary, ["mcp"], {
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.pending = new Map();
    this.next = 1;
    this.stderr = "";
    this.child.stderr.on("data", (b) => (this.stderr += b));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const m = JSON.parse(line);
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          m.error
            ? p.reject(new Error(JSON.stringify(m.error)))
            : p.resolve(m.result);
        }
      } catch {}
    });
    this.child.on("exit", () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("MCP process exited " + this.stderr));
      }
      this.pending.clear();
    });
  }
  request(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            "MCP timeout " +
              method +
              " " +
              JSON.stringify(params).slice(0, 180) +
              " " +
              this.stderr,
          ),
        );
      }, 100000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }
  async init() {
    await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "browser-bridge-e2e", version: "0.1.0" },
    });
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
    return this.request("tools/list");
  }
  async tool(name, args = {}) {
    const r = await this.request("tools/call", { name, arguments: args });
    const text = r.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    let out = r.structuredContent;
    try {
      out = out || JSON.parse(text);
    } catch {}
    if (r.isError) {
      const e = new Error(out?.message || text);
      e.code = out?.code;
      e.uncertain = out?.uncertain;
      throw e;
    }
    return out || r;
  }
  async close() {
    this.child.stdin.end();
    await new Promise((r) => {
      if (this.child.exitCode !== null) return r();
      this.child.once("exit", r);
      setTimeout(() => {
        this.child.kill();
        r();
      }, 2000).unref();
    });
  }
}
