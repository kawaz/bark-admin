import { writeClipboard } from "./common.js";

// 招待ページ: 「Bark にサーバーを追加」は 1 回だけ押せる (Bark はサーバーの重複を見ないので、押し直すと行が増え、2 回目以降は登録トークンが使用済みで key の無い行が残る)。
// 押した後は登録トークンの状態を読み、登録できたら結果と (暗号化するなら) 暗号化キーの節を出す。

const $ = (sel) => document.querySelector(sel);
const add = $("#add");
const token = add.dataset.token;
const api = `/bark-admin/api/registrations/${encodeURIComponent(token)}`;
const button = $("#add-server");
const status = $("#add-status");

let timer = null;
let settled = false;

function stop() {
  settled = true;
  clearInterval(timer);
}

function render(r) {
  if (r.state === "used") {
    stop();
    button.remove();
    status.classList.add("done");
    status.textContent = `追加できた: ${r.device?.tags.name ?? r.used_by}`;
    // 「Bark に切り替わったら…」の案内は済んだので隠す (タグは残す)
    $("#add-guide").hidden = true;
    if (r.encrypted) $("#crypto").hidden = false;
  } else if (r.state === "expired" || r.state === "invite-deleted") {
    stop();
    button.remove();
    status.textContent = "この招待は使えない。QR を読み直す";
  } else if (button.disabled) {
    status.textContent = "Bark で追加中…。終わらないときは、このページを読み込み直してやり直す";
  }
}

async function check() {
  if (settled) return;
  const res = await fetch(api, { cache: "no-store" });
  if (res.status === 404) {
    stop();
    button.remove();
    status.textContent = "この招待は使えない。QR を読み直す";
    return;
  }
  if (res.ok) render(await res.json());
}

// Design rationale: 登録は Bark アプリが別経路 (/r/<token>/register) で行うので、ページから見える完了の合図が無い。
// 台数 1 桁・数分で終わる操作なので、押した後だけ 2 秒間隔で読み、Bark から戻ってきた時 (visibilitychange) は即読む
button.addEventListener("click", () => {
  button.disabled = true;
  button.textContent = "Bark で追加中…";
  location.href = add.dataset.href;
  timer = setInterval(check, 2000);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") check();
});
check();

// 暗号化キー: 押した時に取り、クリックの同期区間でクリップボードへの書き込みを始める (鍵は Promise のまま渡す)。
// 写せたら Bark を前に出す。写せなかった時だけ鍵を見せて手で入れてもらう
const copy = $("#crypto-copy");
copy?.addEventListener("click", async () => {
  const key = fetch(`${api}/crypto-key`, { cache: "no-store" }).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).key;
  });
  try {
    await writeClipboard(key);
    $("#crypto-status").textContent = "コピーした。Bark の暗号化設定の Key に貼る";
    location.href = "bark://";
  } catch {
    let shown = "";
    try {
      shown = await key;
    } catch (e) {
      $("#crypto-status").textContent = `鍵を読めなかった (${e.message})。デバイスの管理画面から設定する`;
      return;
    }
    const code = $("#crypto-key");
    code.textContent = shown;
    code.classList.remove("masked");
    code.removeAttribute("aria-label");
    $("#crypto-status").textContent = "コピーできなかった。上の鍵を手で入力する";
  }
});
