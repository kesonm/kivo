#!/bin/sh
set -eu
umask 077
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo '请先从 https://nodejs.org 安装 Node.js 22 或更新版本，再运行此脚本。'
  exit 1
fi
node -e 'if(Number(process.versions.node.split(".")[0])<22) { console.error("需要 Node.js 22 或更新版本"); process.exit(1); }'
kivo_install_dir="$HOME/.kivo-local/engine"
mkdir -p "$kivo_install_dir"
chmod 700 "$HOME/.kivo-local" "$kivo_install_dir"
echo '安装 kivo 本地助手和官方 Codex 0.167.0（不修改全局 Codex 安装）…'
npm install --prefix "$kivo_install_dir" --save-exact --no-audit --no-fund --registry=https://registry.npmjs.org @openai/codex@0.167.0
curl --fail --location --proto '=https' --tlsv1.2 https://kivo.iptnet.xyz/local-assistant/kivo-local.mjs -o "$kivo_install_dir/kivo-local.mjs.download"
node --check "$kivo_install_dir/kivo-local.mjs.download" 2>/dev/null || {
  # Node derives the module format from the extension.
  mv "$kivo_install_dir/kivo-local.mjs.download" "$kivo_install_dir/kivo-check.mjs"
  node --check "$kivo_install_dir/kivo-check.mjs"
  mv "$kivo_install_dir/kivo-check.mjs" "$kivo_install_dir/kivo-local.mjs.download"
}
mv "$kivo_install_dir/kivo-local.mjs.download" "$kivo_install_dir/kivo-local.mjs"
cat > "$HOME/.kivo-local/start.sh" <<'START'
#!/bin/sh
exec node "$HOME/.kivo-local/engine/kivo-local.mjs" --codex "$HOME/.kivo-local/engine/node_modules/@openai/codex/bin/codex.js" "$@"
START
chmod 700 "$HOME/.kivo-local/start.sh"
echo '安装完成。以后可运行：bash "$HOME/.kivo-local/start.sh"'
exec sh "$HOME/.kivo-local/start.sh" "$@"
