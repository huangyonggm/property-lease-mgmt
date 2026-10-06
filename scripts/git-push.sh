#!/bin/sh
# ============================================================
# git-push.sh —— 推送时绕过本机 HTTP 代理
#
# 【为什么需要这个脚本】
# 本机 shell 里设了 http_proxy / https_proxy = http://127.0.0.1:8275。
# 该代理对普通 GET 正常（curl https://github.com 返回 200），
# 但对 git 的 POST /git-receive-pack 协商会**无限挂起**：
#     $ git push origin main -v
#     Pushing to https://github.com/huangyonggm/property-lease-mgmt.git
#     ...（再无输出，直到超时被杀）
# 表现就是「推送看起来卡死了」。绕过代理后秒级完成：
#     37fd890..70fcd03  main -> main
#
# 注意：`git config http.proxy ""` 无效 —— git 会把空值当未设置，
# 继续回落到环境变量里的代理，所以只能用 env -u 在进程级剔除。
#
# 用法：
#   sh scripts/git-push.sh              # 等价 git push origin main
#   sh scripts/git-push.sh origin main  # 指定参数
# ============================================================
set -e

cd "$(dirname "$0")/.."

if [ "$#" -eq 0 ]; then
  set -- origin main
fi

echo "[git-push] 绕过代理推送: git push $*"
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy \
    GIT_TERMINAL_PROMPT=0 git push "$@"

echo "[git-push] 完成。当前状态："
git status -sb | head -1
