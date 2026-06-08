#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."

echo "=== evoa npm publish ==="
echo ""
echo "请输入你的 npm 密码（仅用于创建 automation token，不保存）："
read -s PASSWORD

echo ""
echo "正在登录并创建 token..."
TOKEN=$(curl -s -X POST https://registry.npmjs.org/-/npm/v1/tokens \
  -H "Content-Type: application/json" \
  -u "wqqqyyz:$PASSWORD" \
  -d '{"readonly": false, "automation": true, "cidr_whitelist": []}' | \
  python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("token","ERROR: "+json.dumps(d)))')

if [[ "$TOKEN" == ERROR* ]]; then
  echo "创建 token 失败: $TOKEN"
  echo "试试其他方式：https://www.npmjs.com/settings/wqqqyyz/tokens"
  exit 1
fi

echo "//registry.npmjs.org/:_authToken=$TOKEN" > ~/.npmrc
unset PASSWORD

echo "正在构建..."
npm run build

echo "正在发布..."
npm publish

echo ""
echo "✅ 发布成功！"
echo "  https://www.npmjs.com/package/evoa"
