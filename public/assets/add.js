import { flowView } from "./add-state.js";
import { errorMessage, writeClipboard } from "./common.js";

// 招待ページ: 3 段のステップ (1. サーバーを追加 → 2. 受信確認 → 3. 暗号化) を、登録トークンの状態 (GET /bark-admin/api/registrations/:token) から描く。
// 何をどう見せるかは add-state.js の flowView が決め、ここは DOM に写すだけ。
// 1 段目のボタンは登録を見つけるまで押せる (Bark の未導入・中断から戻ってもやり直せる)。押した直後の二重タップだけ 1 秒止める

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
  line.replaceChildren(...(mode === "done" ? [done].flat() : []));
  line.hidden = mode !== "done" || line.childNodes.length === 0;
}

// Bark のサーバー一覧に同じ address が並んでも key (= device_id) で見分けられるよう、device_id を全文で添える
function addedLine(r) {
  const name = r.device?.tags.name;
  return [`追加できた: ${name ?? ""}`, ...(name === undefined ? [] : [" "]), Object.assign(document.createElement("code"), { className: "id", textContent: r.used_by })];
}

function render(r) {
  const view = flowView(r, hasCrypto);
  if (r.state === "used") {
    deviceId = r.used_by;
    sendDeliveryOnce();
  }
  setStep("add", view.add, r.state === "used" ? addedLine(r) : []);
  setStep("delivery", view.delivery, "受信を確認できた");
  setStep("crypto", view.crypto, "暗号化を確認できた");
  if (view.addButton === "removed") {
    addButton.remove();
    $("#no-bark").hidden = true;
  }
  for (const li of document.querySelectorAll(".step .message")) li.textContent = "";
  if (view.current === null) $("#flow-status").textContent = view.message;
  else $(`#step-${view.current} .message`).textContent = view.message;
  if (view.deviceLink && deviceId !== null) {
    const link = $("#device-link");
    link.href = `/bark-admin/devices/${encodeURIComponent(deviceId)}`;
    link.hidden = false;
  }
  if (view.finished) {
    finished = true;
    clearInterval(timer);
  }
}

async function check() {
  if (finished) return;
  const res = await fetch(api, { cache: "no-store" });
  if (res.status === 404) return render({ state: "gone" });
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
  status.textContent = res.ok ? "送った" : `送れなかった: ${await errorMessage(res)}`;
  return res.ok;
}

// 送れなかった時も印は残す (状態を読むたびに送り直すと、bark-server が受けない間ずっと送り続け、nonce も入れ替わる)。送り直しは「確認通知を再送する」で
async function sendDeliveryOnce() {
  if (sessionStorage.getItem(DELIVERY_SENT) !== null) return;
  sessionStorage.setItem(DELIVERY_SENT, "1");
  startPolling();
  await sendConfirm("delivery", $("#delivery-status"));
}

// 端末の種類を見分ける手がかりをサーバに送る (iPad の Safari はデスクトップ表示で Macintosh を名乗るので、platform と maxTouchPoints が要る)
fetch(`${api}/client`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    user_agent: navigator.userAgent,
    platform: navigator.platform,
    max_touch_points: navigator.maxTouchPoints,
    language: navigator.language,
    screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio },
  }),
});

// ---------- 1. サーバーを追加 ----------

// Bark が開けば Safari は裏に回る (hidden)。1.5 秒たっても回らなければ未導入とみなして App Store への案内を出す。
// visibilitychange は「状態を読み直す」合図にだけ使い、ボタンの可否には使わない
let wentHidden = false;
addButton.addEventListener("click", () => {
  addButton.disabled = true;
  setTimeout(() => {
    addButton.disabled = false;
  }, 1000);
  wentHidden = false;
  location.href = addButton.dataset.href;
  startPolling();
  setTimeout(() => {
    if (!wentHidden && !finished) $("#no-bark").hidden = false;
  }, 1500);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") wentHidden = true;
  else check();
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
