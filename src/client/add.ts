import { stepStateText, type StepMode } from "../ui/components.ts";
import { deviceHref } from "../ui/views.ts";
import { CryptoKeySchema, failure, readJson, RegistrationStatusSchema, type RegistrationStatus } from "./api.ts";
import { flowView, type FlowStatus } from "./add-state.ts";
import { byId, writeClipboard } from "./dom.ts";

// 招待ページ: 段 (1. サーバーを追加 → 2. 受信確認 → 3. 暗号化) を、登録トークンの状態 (GET /bark-admin/api/registrations/:token) から描く。
// 何をどう見せるかは add-state.ts の flowView が決め、ここは DOM に写すだけ。
// 1 段目のボタンは登録を見つけるまで押せる (Bark の未導入・中断から戻ってもやり直せる)。押した直後の二重タップだけ 1 秒止める

const flow = byId("flow", HTMLOListElement);
const token = flow.dataset["token"] ?? "";
const api = `/bark-admin/api/registrations/${encodeURIComponent(token)}`;
const addButton = byId("add-server", HTMLButtonElement);
const hasCrypto = document.getElementById("step-crypto") !== null;
// 受信確認の通知は登録を見つけた時に 1 回だけ自動で送る。読み込み直しや visibilitychange で重ねて送らないよう、送ったことをタブに残す
const DELIVERY_SENT = `bark-admin:delivery-sent:${token}`;

let timer: ReturnType<typeof setInterval> | null = null;
let finished = false;
let deviceId: string | null = null;

// mode: done (✓ と 1 行) / current (中身を見せて強調) / later (見出しだけ薄く)
function setStep(id: string, mode: StepMode, done: (string | Node)[] = []): void {
  const li = document.getElementById(`step-${id}`);
  if (li === null) return;
  li.className = `step ${mode}`;
  const content = li.querySelector(".content");
  if (content instanceof HTMLElement) content.hidden = mode !== "current";
  const state = li.querySelector("[data-state-text]");
  if (state !== null) state.textContent = stepStateText(mode);
  const line = li.querySelector(".done-line");
  if (line instanceof HTMLElement) {
    line.replaceChildren(...(mode === "done" ? done : []));
    line.hidden = mode !== "done" || line.childNodes.length === 0;
  }
}

// Bark のサーバー一覧に同じ address が並んでも key (= device_id) で見分けられるよう、device_id を全文で添える
function addedLine(r: RegistrationStatus): (string | Node)[] {
  const name = r.device?.tags["name"];
  const id = document.createElement("code");
  id.className = "id";
  id.textContent = r.used_by ?? "";
  return [`追加できた: ${name ?? ""}${name === undefined ? "" : " "}`, id];
}

function render(r: FlowStatus, full: RegistrationStatus | null): void {
  const view = flowView(r, hasCrypto);
  if (full !== null && full.state === "used") {
    deviceId = full.used_by;
    void sendDeliveryOnce();
  }
  setStep("add", view.add, full !== null && full.state === "used" ? addedLine(full) : []);
  setStep("delivery", view.delivery, ["受信を確認できた"]);
  setStep("crypto", view.crypto, ["暗号化を確認できた"]);
  if (view.addButton === "removed") {
    addButton.remove();
    byId("no-bark", HTMLElement).hidden = true;
  }
  for (const m of document.querySelectorAll(".step .message")) m.textContent = "";
  if (view.current === null) byId("flow-status", HTMLElement).textContent = view.message;
  else {
    const m = document.querySelector(`#step-${view.current} .message`);
    if (m !== null) m.textContent = view.message;
  }
  if (view.deviceLink && deviceId !== null) {
    const link = byId("device-link", HTMLAnchorElement);
    link.href = deviceHref(deviceId);
    link.hidden = false;
  }
  if (view.finished) {
    finished = true;
    if (timer !== null) clearInterval(timer);
  }
}

async function check(): Promise<void> {
  if (finished) return;
  const res = await fetch(api, { cache: "no-store" });
  if (res.status === 404) return render({ state: "gone" }, null);
  const r = await readJson(res, RegistrationStatusSchema);
  if (r.ok) render(r.value, r.value);
}

// Design rationale: 登録は Bark アプリが、確認は通知のタップで開く別ページが行うので、このページに完了の合図は届かない。
// 台数 1 桁・数分で終わる操作なので、1 段目を押してから全部済むまで 2 秒間隔で読み、このページに戻ってきた時 (visibilitychange) は即読む
function startPolling(): void {
  if (timer === null && !finished) timer = setInterval(() => void check(), 2000);
}

async function sendConfirm(kind: "delivery" | "crypto", status: HTMLElement): Promise<boolean> {
  if (deviceId === null) return false;
  status.textContent = "送っている";
  const res = await fetch(`/bark-admin/api/devices/${encodeURIComponent(deviceId)}/confirm/${kind}`, { method: "POST" });
  const err = await failure(res);
  status.textContent = err === null ? "送った" : `送れなかった: ${err}`;
  return err === null;
}

// 送れなかった時も印は残す (状態を読むたびに送り直すと、bark-server が受けない間ずっと送り続け、nonce も入れ替わる)。送り直しは「確認通知を再送する」で
async function sendDeliveryOnce(): Promise<void> {
  if (sessionStorage.getItem(DELIVERY_SENT) !== null) return;
  sessionStorage.setItem(DELIVERY_SENT, "1");
  startPolling();
  await sendConfirm("delivery", byId("delivery-status", HTMLElement));
}

// 端末の種類を見分ける手がかりをサーバに送る (iPad の Safari はデスクトップ表示で Macintosh を名乗るので、platform と maxTouchPoints が要る)
void fetch(`${api}/client`, {
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
  location.href = addButton.dataset["href"] ?? "";
  startPolling();
  setTimeout(() => {
    if (!wentHidden && !finished) byId("no-bark", HTMLElement).hidden = false;
  }, 1500);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") wentHidden = true;
  else void check();
});
void check();

// ---------- 2. 受信確認 ----------

byId("delivery-again", HTMLButtonElement).addEventListener("click", () => void sendConfirm("delivery", byId("delivery-status", HTMLElement)));

// ---------- 3. 暗号化 ----------

// 押した時に鍵を取り、クリックの同期区間でクリップボードへの書き込みを始める (鍵は Promise のまま渡す)。
// 写せたら Bark を前に出す。写せなかった時だけ鍵を見せて手で入れてもらう
if (hasCrypto) {
  const status = byId("crypto-status", HTMLElement);
  byId("crypto-copy", HTMLButtonElement).addEventListener("click", async () => {
    const key = fetch(`${api}/crypto-key`, { cache: "no-store" }).then(async (res) => {
      const r = await readJson(res, CryptoKeySchema);
      if (!r.ok) throw new Error(r.error);
      return r.value.key;
    });
    try {
      await writeClipboard(key);
      status.textContent = "コピーした。Bark の暗号化設定の Key に貼る";
      location.href = "bark://";
    } catch {
      let shown = "";
      try {
        shown = await key;
      } catch (e) {
        status.textContent = `鍵を読めなかった (${e instanceof Error ? e.message : "不明なエラー"})。端末の管理画面から設定する`;
        return;
      }
      const code = byId("crypto-key", HTMLElement);
      code.textContent = shown;
      code.classList.remove("masked");
      code.removeAttribute("aria-label");
      status.textContent = "コピーできなかった。上の鍵を手で入力する";
    }
  });
  byId("crypto-confirm", HTMLButtonElement).addEventListener("click", async () => {
    if (await sendConfirm("crypto", byId("crypto-confirm-status", HTMLElement))) startPolling();
  });
}
