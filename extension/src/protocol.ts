export const VERSION = 1;
export const CHUNK_SIZE = 192 * 1024;
export const MAX_MESSAGE = 24 * 1024 * 1024;
export type RpcError = { code: string; message: string; uncertain?: boolean };
export type Message = {
  version: number;
  kind: string;
  requestId?: string;
  sessionId?: string;
  profileId?: string;
  deadline?: number;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: RpcError;
  index?: number;
  total?: number;
  data?: string;
};
export class BridgeError extends Error {
  constructor(
    public code: string,
    message: string,
    public uncertain = false,
  ) {
    super(message);
  }
}
export function errorOf(e: unknown): RpcError {
  if (e instanceof BridgeError)
    return { code: e.code, message: e.message, uncertain: e.uncertain };
  return {
    code: "BROWSER_ERROR",
    message: e instanceof Error ? e.message : String(e),
  };
}
export function encode(m: Message): Message[] {
  m.version = VERSION;
  const bytes = new TextEncoder().encode(JSON.stringify(m));
  if (bytes.length > MAX_MESSAGE)
    throw new BridgeError("MESSAGE_TOO_LARGE", "结果过大，请缩小采集范围");
  if (bytes.length <= CHUNK_SIZE) return [m];
  const chunks: Message[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const slice = bytes.subarray(i, i + CHUNK_SIZE);
    let text = "";
    for (let j = 0; j < slice.length; j += 8192)
      text += String.fromCharCode(...slice.subarray(j, j + 8192));
    chunks.push({
      version: VERSION,
      kind: "chunk",
      requestId: m.requestId,
      index: i / CHUNK_SIZE,
      total: Math.ceil(bytes.length / CHUNK_SIZE),
      data: btoa(text),
    });
  }
  return chunks;
}
export class Decoder {
  private current?: {
    id: string;
    total: number;
    parts: Uint8Array[];
    size: number;
    started: number;
  };
  push(m: Message): Message | undefined {
    if (m.version !== VERSION)
      throw new BridgeError(
        "PROTOCOL_MISMATCH",
        "协议版本不兼容，请同时升级扩展和本机服务",
      );
    if (m.kind !== "chunk") return m;
    if (m.index === 0) {
      if (this.current) throw new BridgeError("INVALID_CHUNK", "分块消息交错");
      this.current = {
        id: m.requestId || "",
        total: m.total || 0,
        parts: [],
        size: 0,
        started: Date.now(),
      };
    }
    const c = this.current;
    if (
      !c ||
      !c.id ||
      c.id !== m.requestId ||
      c.parts.length !== m.index ||
      c.total !== m.total ||
      c.total < 1 ||
      c.total > 129 ||
      Date.now() - c.started > 30000
    )
      throw new BridgeError("INVALID_CHUNK", "分块顺序或大小无效");
    const part = Uint8Array.from(atob(m.data || ""), (x) => x.charCodeAt(0));
    c.parts.push(part);
    c.size += part.length;
    if (c.size > MAX_MESSAGE)
      throw new BridgeError("MESSAGE_TOO_LARGE", "消息过大");
    if (c.parts.length < c.total) return;
    const all = new Uint8Array(c.size);
    let pos = 0;
    for (const p of c.parts) {
      all.set(p, pos);
      pos += p.length;
    }
    this.current = undefined;
    const result = JSON.parse(new TextDecoder().decode(all)) as Message;
    if (result.kind === "chunk" || result.version !== VERSION)
      throw new BridgeError("PROTOCOL_MISMATCH", "无效协议封装");
    return result;
  }
}
export function normalizedOrigin(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new BridgeError("INVALID_URL", "请输入完整 http/https 网址");
  }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw new BridgeError(
      "INVALID_URL",
      "仅允许不含用户名密码的 http/https 网址",
    );
  return u.origin;
}
export function pattern(origin: string): string {
  const u = new URL(origin);
  return u.protocol + "//" + u.hostname + "/*";
}
