#!/bin/bash
# bark-admin が port で listen していなければ起動する (冪等)。upstream の bark-server も先に起こす。
# caddy-app-proxy (Caddy) の exec handler から 502 のたびに呼ばれる前提: 多重起動を lock で抑止し、
# 何度呼ばれても副作用は「必要なら 1 回起動」だけ。lock 待ちの側も listen を
# 待ってから返す (即 exit すると Caddy が 302 → 502 → 302 を繰り返す)。
# Caddy は launchd 配下で PATH が最小なので、必要な物は絶対パスで引く。
set -eu -o pipefail

repo_dir="$(cd "$(dirname "$(realpath "$0")")/.." && pwd)"
bark_server_ensure="${BARK_SERVER_ENSURE:-$HOME/.local/share/repos/github.com/kawaz/caddy-app-proxy/main/ondemand/bark-server-ensure.sh}"
addr="${BARK_ADMIN_ADDR:-127.0.0.1:8086}"
PORT="${addr##*:}"
export PATH="/usr/bin:/bin"

# bun は導入経路ごとに置き場が違うので、BUN が無ければ既知の場所を順に探す
bun="${BUN:-}"
if [ -z "$bun" ]; then
	for c in "/etc/profiles/per-user/${USER:-$(id -un)}/bin/bun" "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
		if [ -x "$c" ]; then
			bun="$c"
			break
		fi
	done
fi
if [ -z "$bun" ]; then
	echo "bun not found (set BUN=/path/to/bun)" >&2
	exit 1
fi

state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/bark-admin"
mkdir -p "$state_dir"
log="$state_dir/server.log"
lock="$state_dir/start.lock"

# bark-admin より先に upstream を起こす (bark-admin が上がっても bark-server が居なければ 502 を返すだけになる)
"$bark_server_ensure"

listening() { nc -z 127.0.0.1 "$PORT" 2>/dev/null; }

if listening; then
	echo "already listening on $PORT"
	exit 0
fi

# listen するまで最大 15 秒待つ (Caddy 側の exec timeout に収める)
wait_listening() {
	for _ in $(seq 1 30); do
		listening && return 0
		sleep 0.5
	done
	return 1
}

# mkdir は atomic なので lock に使う。古い lock (起動失敗で残った物) は 60 秒で無効化する。
if ! mkdir "$lock" 2>/dev/null; then
	if [ -n "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
		rmdir "$lock" 2>/dev/null || true
	fi
	if ! mkdir "$lock" 2>/dev/null; then
		echo "another start in progress, waiting"
		wait_listening && { echo "started by another"; exit 0; }
		echo "still not listening after 15s" >&2
		exit 1
	fi
fi

# 子は nohup + & で切り離し、Caddy の reload / 本スクリプトの終了に巻き込まれないようにする。
# 到達制限は Caddy の tailnet_only が担うので loopback にだけ bind する (BARK_ADMIN_ADDR の既定)。
echo "starting bark-admin on $addr (log: $log)"
cd "$repo_dir"
BARK_ADMIN_ADDR="$addr" nohup "$bun" run src/main.ts >>"$log" 2>&1 </dev/null &

if wait_listening; then
	rmdir "$lock"
	echo "started"
	exit 0
fi
rmdir "$lock"
echo "failed to start within 15s (see $log)" >&2
exit 1
