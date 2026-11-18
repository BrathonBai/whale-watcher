#!/usr/bin/env bash
# 把 dsh-go-ble 覆盖集应用到一份 dsh-Go 源码树上（等价于 apply.ps1）。
#
# 用法：
#   bash dsh-go-ble/apply.sh /path/to/dsh-go          # 应用
#   bash dsh-go-ble/apply.sh /path/to/dsh-go --check  # 只比对
#   bash dsh-go-ble/apply.sh /path/to/dsh-go --dry-run
#   bash dsh-go-ble/apply.sh /path/to/dsh-go --force  # 目标已被改过也覆盖
set -euo pipefail

TARGET="${1:-}"; shift || true
MODE="apply"; FORCE=0
for a in "$@"; do
  case "$a" in
    --check) MODE="check" ;;
    --dry-run) MODE="dry-run" ;;
    --force) FORCE=1 ;;
    *) echo "未知参数：$a" >&2; exit 2 ;;
  esac
done
if [ -z "$TARGET" ]; then echo "用法：bash dsh-go-ble/apply.sh /path/to/dsh-go [--check|--dry-run|--force]" >&2; exit 2; fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OVERLAY="$HERE/files"
MANIFEST="$HERE/files-manifest.json"
[ -d "$OVERLAY" ] || { echo "覆盖集目录不存在：$OVERLAY" >&2; exit 1; }
[ -f "$MANIFEST" ] || { echo "缺 files-manifest.json，先运行 node dsh-go-ble/tooling/make-manifest.mjs" >&2; exit 1; }

TARGET="$(cd "$TARGET" && pwd)"
grep -qE '^name:[[:space:]]*dsh_app[[:space:]]*$' "$TARGET/app/pubspec.yaml" 2>/dev/null || {
  echo "目标不像 dsh-Go 源码树（缺 app/pubspec.yaml 或 name 不是 dsh_app）：$TARGET" >&2; exit 1; }

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

SAME=0; ADDED=0; UPDATED=0; DRIFT=0
# 用 node 解析 manifest 并输出 TSV：kind \t path \t upstreamSha \t overlaySha
NODE=${NODE:-node}
$NODE -e '
const m = require(process.argv[1]);
for (const e of m.entries) console.log([e.kind, e.path, e.upstreamSha256 || "-", e.overlaySha256].join("\t"));
' "$MANIFEST" > "$HERE/.apply-plan.tsv"

while IFS=$'\t' read -r kind rel up_sha ov_sha; do
  src="$OVERLAY/$rel"; dst="$TARGET/$rel"
  [ "$(sha256 "$src")" = "$ov_sha" ] || { echo "覆盖集与 manifest 不一致（先重跑 make-manifest.mjs）：$rel" >&2; exit 1; }
  if [ ! -e "$dst" ]; then
    ADDED=$((ADDED+1))
    if [ "$MODE" = "apply" ]; then mkdir -p "$(dirname "$dst")"; cp -p "$src" "$dst"; fi
    continue
  fi
  d_sha="$(sha256 "$dst")"
  if [ "$d_sha" = "$ov_sha" ]; then SAME=$((SAME+1)); continue; fi
  if [ "$kind" = "added" ]; then DRIFT=$((DRIFT+1)); echo "? $rel（目标里已有同名文件）" >&2; continue; fi
  if [ "$d_sha" = "$up_sha" ] || [ "$FORCE" = "1" ]; then
    UPDATED=$((UPDATED+1))
    if [ "$MODE" = "apply" ]; then cp -p "$src" "$dst"; fi
    continue
  fi
  DRIFT=$((DRIFT+1)); echo "? $rel（目标既不是上游也不是本补丁；-Force 才覆盖）" >&2
done < "$HERE/.apply-plan.tsv"
rm -f "$HERE/.apply-plan.tsv"

echo "目标：$TARGET"
echo "结果：已一致 $SAME，新增 $ADDED，替换 $UPDATED，漂移 $DRIFT"
if [ "$MODE" = "check" ]; then [ "$DRIFT" -eq 0 ] || exit 1; echo "检查通过"; exit 0; fi
if [ "$MODE" = "dry-run" ]; then echo "（dry-run：没有写任何文件）"; exit 0; fi
cat <<'EOF'

已应用。接下来（必须）：
  1) cd app && flutter pub get && flutter analyze
  2) flutter test --update-goldens test/settings test/shell test/landscape   # hub 多一行，goldens 必变
  3) flutter test
  4) 生成 APK：bash tooling/build-apk.sh -f arm64   （需要 runtime/out/arm64 运行时资产，见 README）
回滚：在目标仓库 git checkout -- .  （覆盖集不删文件）
EOF
[ "$DRIFT" -eq 0 ] || exit 1
