#!/bin/bash
# Chrome 操作助手 · macOS 安装脚本
# 用法：curl -fsSL https://dl.linbingbing.asia/browser-bridge/install.sh | bash
# 幂等：已安装时重复执行只会刷新版本与软链，不会重复注册。
set -euo pipefail

BASE="https://dl.linbingbing.asia/browser-bridge"
FALLBACK="https://github.com/linshenghan/browser-bridge/releases/download"
VERSION="${TBB_VERSION:-0.2.1}"
ROOT="$HOME/BrowserBridge"
GUIDE="https://install.linbingbing.asia"

log()  { printf '\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m错误：%s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "此脚本仅支持 macOS。Windows 请改用 install.ps1；Linux 暂未提供构建产物。"

case "$(uname -m)" in
  arm64|aarch64) SLUG="macos-arm64" ;;
  x86_64|amd64)  SLUG="macos-intel" ;;
  *) die "不支持的芯片架构：$(uname -m)" ;;
esac

ZIP="browser-bridge-v${VERSION}-${SLUG}.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log "▸ 下载 $ZIP"
if ! curl -fsSL --max-time 300 "$BASE/v$VERSION/$ZIP" -o "$TMP/$ZIP"; then
  log "  主源不可用，改用备用源"
  curl -fsSL --max-time 300 "$FALLBACK/v$VERSION/$ZIP" -o "$TMP/$ZIP" || die "下载失败，请检查网络后重试。"
fi

log "▸ 校验完整性"
if curl -fsSL --max-time 30 "$BASE/v$VERSION/SHA256SUMS.txt" -o "$TMP/SHA256SUMS.txt" 2>/dev/null; then
  EXPECT="$(grep " ${ZIP}\$" "$TMP/SHA256SUMS.txt" | awk '{print $1}' || true)"
  if [[ -n "$EXPECT" ]]; then
    ACTUAL="$(shasum -a 256 "$TMP/$ZIP" | awk '{print $1}')"
    [[ "$EXPECT" == "$ACTUAL" ]] || die "文件校验不匹配，已中止。预期 $EXPECT，实际 $ACTUAL。"
    log "  校验通过"
  fi
fi

log "▸ 解压"
unzip -q "$TMP/$ZIP" -d "$TMP/pkg"
BIN="$(find "$TMP/pkg" -type f -name 'browser-bridge' | head -1)"
[[ -n "$BIN" ]] || die "压缩包内容异常，未找到主程序。"
chmod +x "$BIN"

log "▸ 注册浏览器组件"
"$BIN" install --source "$(dirname "$BIN")" >/dev/null || die "注册失败，请查看上方输出。"

log "▸ 写入命令路径"
CUR="$(grep -o '"current"[[:space:]]*:[[:space:]]*"[^"]*"' "$ROOT/installation.json" 2>/dev/null | head -1 | sed 's/.*:"//; s/"$//' || true)"
REAL="$CUR/browser-bridge"
[[ -x "$REAL" ]] || REAL="$(find "$ROOT/releases" -type f -name 'browser-bridge' -exec ls -t {} + 2>/dev/null | head -1)"
[[ -n "$REAL" && -x "$REAL" ]] || die "安装完成但找不到主程序，请手动运行 browser-bridge doctor 检查。"

mkdir -p "$HOME/.local/bin"
ln -sf "$REAL" "$HOME/.local/bin/browser-bridge"
if ln -sf "$REAL" /usr/local/bin/browser-bridge 2>/dev/null; then
  log "  已链接到 /usr/local/bin"
else
  log "  已链接到 ~/.local/bin"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) printf '提示：请把下面一行加入 ~/.zshrc 或 ~/.bash_profile\n  export PATH="$HOME/.local/bin:$PATH"\n' ;;
  esac
fi

log ""
log "本机程序安装完成（v$VERSION）"
printf '还剩最后一步，需要你在 Chrome 里点两下：\n'
printf '  1. 打开 chrome://extensions，开启右上角「开发者模式」\n'
printf '  2. 点「加载已解压的扩展程序」，选择 %s/extension\n' "$ROOT"
printf '\n图文指引：%s\n' "$GUIDE"
