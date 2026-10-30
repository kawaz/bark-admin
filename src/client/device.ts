import { cryptoMeter } from "../ui/components.ts";
import { CRYPTO_LABELS, cryptoLevel, formatAt, hostState } from "../ui/device-status.ts";
import { html } from "../ui/html.ts";
import { deviceAlerts, deviceHero, deviceInfoRows, deviceStateRows, deviceTags } from "../ui/views.ts";
import { ConfigSchema, DeviceViewSchema, failure, readJson, type DeviceView } from "./api.ts";
import { byId, closeDialog, copyText, formatTagLines, parseTagLines, setHtml, writeClipboard } from "./dom.ts";

// 端末の詳細: 基本情報 (見出し・状態の行・タグ・端末情報) を描き、操作は状態の行やタグの横のボタンが開くダイアログで行う。
// 鍵は暗号化のダイアログで「表示」を押すまで伏せる

const id = decodeURIComponent(location.pathname.split("/").at(-1) ?? "");
const api = `/bark-admin/api/devices/${encodeURIComponent(id)}`;
const errorBox = byId("error", HTMLElement);

// 今の公開名。端末が登録に使ったホスト名 (info.server_host) と違えば古い公開名で追加された端末
const config = await readJson(await fetch("/bark-admin/api/config"), ConfigSchema);
const currentHost = config.ok ? config.value.server_host : "";

let device: DeviceView | null = null;
let keyShown = false;

function showError(text: string | null): void {
  errorBox.hidden = text === null;
  errorBox.textContent = text ?? "";
}

function renderCryptoDialog(d: DeviceView): void {
  const level = cryptoLevel(d.crypto);
  setHtml(byId("crypto-meter", HTMLElement), cryptoMeter(level));
  const state = byId("crypto-state", HTMLElement);
  if (d.crypto === null) state.textContent = "無効。通知は暗号化せずに bark-server と APNs を通る";
  else if (d.crypto.confirmed_at === null) state.textContent = `${CRYPTO_LABELS.unconfirmed}。Bark に鍵を貼ったら「暗号化の確認を送る」で確かめる`;
  else {
    state.textContent = `${CRYPTO_LABELS.confirmed} (${formatAt(d.crypto.confirmed_at)})。通知は暗号化して送る`;
    byId("crypto-status", HTMLElement).textContent = "";
    byId("crypto-reload", HTMLButtonElement).hidden = true;
  }
  byId("crypto-on", HTMLElement).hidden = d.crypto === null;
  byId("crypto-off", HTMLElement).hidden = d.crypto !== null;
  renderKey();
}

// 鍵は「表示」を押した時だけ見せる (詳細を開いただけ・ダイアログを開いただけでは伏せたまま)
function renderKey(): void {
  const code = byId("crypto-key", HTMLElement);
  const reveal = byId("crypto-reveal", HTMLButtonElement);
  const key = device?.crypto?.key;
  const shown = keyShown && key !== undefined;
  code.textContent = shown ? key : "••••••••";
  code.classList.toggle("masked", !shown);
  if (shown) code.removeAttribute("aria-label");
  else code.setAttribute("aria-label", "暗号化キー (隠している)");
  reveal.textContent = shown ? "隠す" : "表示";
  reveal.setAttribute("aria-pressed", String(shown));
}

function render(d: DeviceView): void {
  device = d;
  const name = d.tags["name"];
  document.title = `${name ?? d.device_id} - bark-admin`;
  setHtml(byId("hero", HTMLElement), deviceHero(d, currentHost));
  setHtml(byId("alerts", HTMLElement), deviceAlerts(d, currentHost));
  setHtml(byId("state-rows", HTMLElement), deviceStateRows(d, currentHost));
  setHtml(byId("tag-area", HTMLElement), deviceTags(d));
  const info = deviceInfoRows(d.info);
  byId("info", HTMLElement).hidden = info === null;
  setHtml(byId("info-rows", HTMLElement), info ?? html``);
  const retired = d.archived_at !== null;
  setHtml(
    byId("retire-area", HTMLElement),
    retired || d.migrated_to !== null
      ? html``
      : html`<div class="retire"><p class="hint">退役させると通知の宛先と一覧から外れる。登録は残るので、あとで復帰できる</p><button type="button" class="btn btn-danger" commandfor="retire-dialog" command="show-modal">この端末を退役させる</button></div>`,
  );
  byId("detail", HTMLElement).hidden = false;

  const label = name ?? d.device_id;
  byId("delivery-state", HTMLElement).textContent = d.delivery.confirmed_at === null ? "受信確認: 未確認" : `受信確認: 確認済み (${formatAt(d.delivery.confirmed_at)})`;
  renderCryptoDialog(d);
  const host = hostState(d, currentHost);
  byId("migrate-text", HTMLElement).textContent = host.kind === "stale" ? `${label} は ${host.host} で登録されている。今のサーバー名は ${currentHost}` : "この端末のサーバー名は今のサーバー名と同じ";
  byId("tags", HTMLTextAreaElement).value = formatTagLines(d.tags);
  byId("retire-text", HTMLElement).textContent = retired
    ? `${label} (${d.device_id}) は退役済み。復帰させると通知の宛先と一覧に戻る`
    : `${label} (${d.device_id}) を退役させる? 通知の宛先と一覧から外れる。登録は残り、あとで復帰できる`;
  byId("archive", HTMLButtonElement).hidden = retired;
  byId("restore", HTMLButtonElement).hidden = !retired;
}

async function call(method: string, body?: object, path = ""): Promise<boolean> {
  const res = await fetch(`${api}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const r = await readJson(res, DeviceViewSchema);
  if (!r.ok) {
    showError(r.error);
    return false;
  }
  showError(null);
  render(r.value);
  return true;
}

await call("GET");

// ---------- タグ ----------

const tagsStatus = byId("tags-status", HTMLElement);
byId("tags", HTMLTextAreaElement).addEventListener("input", () => {
  tagsStatus.textContent = "";
});
byId("tags-form", HTMLFormElement).addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const tags = parseTagLines(byId("tags", HTMLTextAreaElement).value);
  if (!tags.ok) {
    tagsStatus.textContent = tags.error;
    return;
  }
  if (await call("PATCH", { tags: tags.tags })) closeDialog("tags-dialog");
});

// ---------- 退役・復帰 ----------

byId("archive", HTMLButtonElement).addEventListener("click", async () => {
  if (await call("DELETE")) closeDialog("retire-dialog");
});
byId("restore", HTMLButtonElement).addEventListener("click", async () => {
  if (await call("PATCH", { archived_at: null })) closeDialog("retire-dialog");
});

// ---------- 確認の通知 ----------

// 確認の通知を送る (delivery は平文、crypto は暗号化)。端末でタップされると server 側で確認済みになるので、戻ってきたら読み直す
async function sendConfirm(kind: "delivery" | "crypto", status: HTMLElement, sentText: string): Promise<boolean> {
  status.textContent = "送っている";
  const err = await failure(await fetch(`${api}/confirm/${kind}`, { method: "POST" }));
  status.textContent = err === null ? sentText : `送れなかった: ${err}`;
  return err === null;
}

byId("delivery-confirm", HTMLButtonElement).addEventListener(
  "click",
  () => void sendConfirm("delivery", byId("delivery-status", HTMLElement), "受信確認の通知を送った。端末で通知をタップすると確認済みになる"),
);

// ---------- 暗号化 ----------

const COPIED = "コピーした。端末の Bark で 暗号化設定 → AES256 / GCM / noPadding / Key に貼る";

byId("crypto-reveal", HTMLButtonElement).addEventListener("click", () => {
  keyShown = !keyShown;
  renderKey();
});
byId("crypto-copy", HTMLButtonElement).addEventListener("click", (ev) => {
  const key = device?.crypto?.key;
  if (key !== undefined && ev.currentTarget instanceof HTMLButtonElement) void copyText(ev.currentTarget, key);
});
// ダイアログを閉じたら鍵を伏せ直す
byId("crypto-dialog", HTMLDialogElement).addEventListener("close", () => {
  keyShown = false;
  renderKey();
});

// 鍵を作って保存し、そのままクリップボードへ写す (クリックの同期区間で書き込みを始めるため、鍵は Promise のまま渡す)
async function newKey(): Promise<void> {
  const res = fetch(`${api}/crypto`, { method: "POST" }).then((r) => readJson(r, DeviceViewSchema));
  const copied = writeClipboard(
    res.then((r) => {
      if (!r.ok || r.value.crypto === null) throw new Error(r.ok ? "no key" : r.error);
      return r.value.crypto.key;
    }),
  ).then(
    () => true,
    () => false,
  );
  const r = await res;
  if (!r.ok) {
    showError(r.error);
    return;
  }
  showError(null);
  render(r.value);
  byId("crypto-status", HTMLElement).textContent = "";
  byId("crypto-reload", HTMLButtonElement).hidden = true;
  byId("crypto-copied", HTMLElement).textContent = (await copied) ? COPIED : "コピーできなかった。「表示」で鍵を出して選び、端末の Bark で 暗号化設定 → AES256 / GCM / noPadding / Key に貼る";
}

byId("crypto-enable", HTMLButtonElement).addEventListener("click", () => void newKey());
byId("crypto-renew", HTMLButtonElement).addEventListener("click", () => {
  if (confirm("鍵を作り直す? Bark 側に新しい鍵を貼り直すまで、この端末は通知を読めない")) void newKey();
});
byId("crypto-disable", HTMLButtonElement).addEventListener("click", async () => {
  if (confirm("暗号化を無効にする? 以後の通知は暗号化せずに送る")) await call("PATCH", { crypto: null });
});
byId("crypto-confirm", HTMLButtonElement).addEventListener("click", async () => {
  if (await sendConfirm("crypto", byId("crypto-status", HTMLElement), "暗号化の確認の通知を送った。端末で通知をタップすると確認済みになる")) {
    byId("crypto-reload", HTMLButtonElement).hidden = false;
  }
});
byId("crypto-reload", HTMLButtonElement).addEventListener("click", () => void call("GET"));

// ---------- 移行 ----------

// 新しい公開名で登録し直す案内の通知を送る。端末で通知をタップすると移行の案内ページが開く
byId("migrate-send", HTMLButtonElement).addEventListener("click", async (ev) => {
  const button = ev.currentTarget;
  if (!(button instanceof HTMLButtonElement)) return;
  const status = byId("migrate-status", HTMLElement);
  button.disabled = true;
  status.textContent = "送っている";
  const err = await failure(await fetch(`${api}/migrate`, { method: "POST" }));
  status.textContent = err === null ? "通知を送った。端末で開いて案内に従う" : `送れなかった: ${err}`;
  button.disabled = false;
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void call("GET");
});
