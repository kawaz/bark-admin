import { errorMessage, writeClipboard } from "./common.js";

// 招待ページ: 3 段のステップ (1. サーバーを追加 → 2. 受信確認 → 3. 暗号化) を、登録トークンの状態 (GET /bark-admin/api/registrations/:token) から描く。
// 1 段目のボタンは 1 回だけ押せる (Bark はサーバーの重複を見ないので、押し直すと行が増え、2 回目以降は登録トークンが使用済みで key の無い行が残る)。

const $ = (sel) => document.querySelector(sel);
const flow = $("#flow");
const token = flow.dataset.token;
const api = `/bark-admin/api/registrations/${encodeURIComponent(token)}`;
const addButton = $("#add-server");
const hasCrypto = $("#step-crypto") !== null;
// 受信確認の通知は登録を見つけた時に 1 回だけ自動で送る。読み込み直しや visibilitychange で重ねて送らないよう、送ったことをタブに残す
const DELIVERY_SENT = `bark-admin:delivery-sent:${token}`;

let timer = null;
let finished = false;
let deviceId = null;

// mode: done (✓ と 1 行) / current (中身を見せて強調) / later (見出しだけ薄く)。done の 1 行は文字列か node の並び
function setStep(id, mode, done = []) {
  const li = $(`#step-${id}`);
  if (li === null) return;
  li.className = `step ${mode}`;
  li.querySelector(".body").hidden = mode !== "current";
  const line = li.querySelector(".done-line");
  line.replaceChildren(...[done].flat());
  line.hidden = mode !== "done" || line.childNodes.length === 0;
}

function finish(message) {
  finished = true;
  clearInterval(timer);
  $("#flow-status").textContent = message;
}

function unusable() {
  addButton.remove();
  $("#no-bark").hidden = true;
  $("#add-status").textContent = "この招待は使えない。QR を読み直す";
  setStep("add", "current");
  finish("");
}

function render(r) {
  if (r.state === "expired" || r.state === "invite-deleted") return unusable();
  if (r.state !== "used") {
    if (addButton.disabled) $("#add-status").textContent = "Bark で追加中…。終わらないときは、このページを読み込み直してやり直す";
    return;
  }
  deviceId = r.used_by;
  // Bark のサーバー一覧に同じ address が並んでも key (= device_id) で見分けられるよう、device_id を全文で添える
  const name = r.device?.tags.name;
  setStep("add", "done", [`追加できた: ${name ?? ""}`, ...(name === undefined ? [] : [" "]), Object.assign(document.createElement("code"), { className: "id", textContent: r.used_by })]);
  sendDeliveryOnce();
  if ((r.device?.delivery.confirmed_at ?? null) === null) {
    setStep("delivery", "current");
    setStep("crypto", "later");
    return;
  }
  setStep("delivery", "done", "受信を確認できた");
  if (!hasCrypto) return finish("すべて済んだ。このページは閉じてよい");
  if ((r.device?.crypto?.confirmed_at ?? null) === null) return setStep("crypto", "current");
  setStep("crypto", "done", "暗号化を確認できた");
  finish("すべて済んだ。このページは閉じてよい");
}

async function check() {
  if (finished) return;
  const res = await fetch(api, { cache: "no-store" });
  if (res.status === 404) return unusable();
  if (res.ok) render(await res.json());
}

// Design rationale: 登録は Bark アプリが、確認は通知のタップで開く別ページが行うので、このページに完了の合図は届かない。
// 台数 1 桁・数分で終わる操作なので、1 段目を押してから全部済むまで 2 秒間隔で読み、このページに戻ってきた時 (visibilitychange) は即読む
function startPolling() {
  if (timer === null && !finished) timer = setInterval(check, 2000);
}

async function sendConfirm(kind, status) {
  status.textContent = "送っている";
  const res = await fetch(`/bark-admin/api/devices/${encodeURIComponent(deviceId)}/confirm/${kind}`, { method: "POST" });
  status.textContent = res.ok ? "送った。届いた通知をタップする" : `送れなかった: ${await errorMessage(res)}`;
  return res.ok;
}

// 送れなかった時も印は残す (状態を読むたびに送り直すと、bark-server が受けない間ずっと送り続け、nonce も入れ替わる)。送り直しは「もう一度送る」で
async function sendDeliveryOnce() {
  if (sessionStorage.getItem(DELIVERY_SENT) !== null) return;
  sessionStorage.setItem(DELIVERY_SENT, "1");
  startPolling();
  await sendConfirm("delivery", $("#delivery-status"));
}

// ---------- 1. サーバーを追加 ----------

// Bark が開けば Safari は裏に回る (hidden)。1.5 秒たっても回らなければ未導入とみなして App Store への案内を出し、押し直せるようにする
let wentHidden = false;
addButton.addEventListener("click", () => {
  addButton.disabled = true;
  addButton.textContent = "Bark で追加中…";
  wentHidden = false;
  location.href = addButton.dataset.href;
  startPolling();
  setTimeout(() => {
    if (wentHidden || finished) return;
    $("#no-bark").hidden = false;
    addButton.disabled = false;
    addButton.textContent = "Bark にサーバーを追加";
  }, 1500);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    wentHidden = true;
    // 案内を出した後で Bark が開いた場合も、押し直しで行が増えないよう閉じる
    $("#no-bark").hidden = true;
    if (addButton.isConnected && !addButton.disabled) {
      addButton.disabled = true;
      addButton.textContent = "Bark で追加中…";
    }
  } else {
    check();
  }
});
check();

// ---------- 2. 受信確認 ----------

$("#delivery-again").addEventListener("click", () => sendConfirm("delivery", $("#delivery-status")));

// ---------- 3. 暗号化 ----------

// 押した時に鍵を取り、クリックの同期区間でクリップボードへの書き込みを始める (鍵は Promise のまま渡す)。
// 写せたら Bark を前に出す。写せなかった時だけ鍵を見せて手で入れてもらう
$("#crypto-copy")?.addEventListener("click", async () => {
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
$("#crypto-confirm")?.addEventListener("click", async () => {
  if (await sendConfirm("crypto", $("#crypto-confirm-status"))) startPolling();
});
