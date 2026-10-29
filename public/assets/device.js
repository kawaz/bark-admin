import { copyText, el, errorMessage, formatAt, formatTagLines, parseTagLines, writeClipboard } from "./common.js";

// HTML と JS の版がずれると (古い版がキャッシュに残る等) 要素が見つからない。黙って空欄にせず、知らせて止める
function stale(sel) {
  console.error(`bark-admin: ${sel} is not in the page. The HTML and the script are from different versions`);
  if (document.querySelector("#stale") === null) {
    const note = Object.assign(document.createElement("p"), { id: "stale", className: "error", role: "alert", textContent: "古い版が表示されている。再読み込みする " });
    note.append(Object.assign(document.createElement("button"), { type: "button", className: "secondary", textContent: "再読み込み", onclick: () => location.reload() }));
    document.querySelector("main")?.prepend(note);
  }
  throw new Error(`missing element ${sel}`);
}

const $ = (sel) => document.querySelector(sel) ?? stale(sel);
const id = decodeURIComponent(location.pathname.split("/").at(-1));
const api = `/bark-admin/api/devices/${encodeURIComponent(id)}`;
// 今の公開名。端末が登録に使ったホスト名 (info.server_host) と違えば古い公開名で追加された端末
const { server_host: currentHost } = await (await fetch("/bark-admin/api/config")).json();

function timeEl(iso) {
  return el("time", { dateTime: iso, textContent: formatAt(iso), title: iso });
}

function setTime(node, iso) {
  node.dateTime = iso;
  node.textContent = formatAt(iso);
  node.title = iso;
}

// 端末情報の並び (DESIGN.md のデータ節の順)。無い項目は出さない
const INFO_KEYS = [
  "device_kind",
  "os_version",
  "bark_version",
  "bark_build",
  "lang",
  "ts_machine",
  "ts_hostname",
  "ts_name",
  "ts_os",
  "ts_user",
  "ts_ip",
  "user_agent",
  "browser_user_agent",
  "browser_platform",
  "browser_max_touch_points",
  "browser_language",
  "browser_screen",
  "last_register_at",
];

function fact(label, value) {
  const dd = document.createElement("dd");
  dd.append(value);
  return [Object.assign(document.createElement("dt"), { textContent: label }), dd];
}

function renderInfo(info) {
  const rows = INFO_KEYS.filter((k) => info[k] !== undefined).flatMap((k) => {
    const value = info[k];
    if (k === "last_register_at") return fact(k, Object.assign(document.createElement("time"), { dateTime: value, textContent: formatAt(value), title: value }));
    return fact(k, value);
  });
  $("#info-facts").replaceChildren(...rows);
  $("#info").hidden = rows.length === 0;
}

// Bark アプリはサーバ追加時の address に登録し続けるので、公開名を変えた後も古い名前で来る端末がある
function renderServerHost(host) {
  const dd = $("#server-host");
  if (host === undefined) dd.textContent = "不明";
  else if (host === currentHost) dd.textContent = host;
  else dd.replaceChildren(host, " ", el("span", { className: "hint", textContent: `古い (現在の公開名: ${currentHost})` }));
}

function render(d) {
  const { name, owner } = d.tags;
  $("#detail").hidden = false;
  $("#device-name").textContent = name ?? "名前なし";
  $("#device-name").classList.toggle("unnamed", name === undefined);
  $("#device-owner").textContent = owner === undefined ? "owner なし" : `owner ${owner}`;
  document.title = `bark-admin: ${name ?? id}`;
  $("#device-id").textContent = d.device_id;
  $("#device-id-fact").textContent = d.device_id;
  setTime($("#registered-at"), d.registered_at);
  renderServerHost(d.info.server_host);
  $("#tags").value = formatTagLines(d.tags);
  const tags = Object.entries(d.tags);
  $("#tag-chips").replaceChildren(...(tags.length === 0 ? [el("li", { className: "hint", textContent: "タグなし" })] : tags.map(([k, v]) => el("li", { className: "tag", textContent: `${k}=${v}` }))));
  renderInfo(d.info);
  const archived = d.archived_at !== null;
  $("#archived-banner").hidden = !archived;
  if (archived) setTime($("#archived-at"), d.archived_at);
  $("#retire").hidden = archived;
  const delivered = d.delivery.confirmed_at;
  if (delivered === null) $("#delivery-state").textContent = "未確認";
  else {
    $("#delivery-status").textContent = "";
    $("#delivery-state").replaceChildren("確認済み ", timeEl(delivered));
  }
  const encrypted = d.crypto !== null;
  const summary = $("#crypto-summary");
  if (!encrypted) summary.textContent = "無効";
  else if (d.crypto.confirmed_at === null) summary.textContent = "有効・未確認";
  else summary.replaceChildren("有効・確認済み ", timeEl(d.crypto.confirmed_at));
  const state = $("#crypto-state");
  if (!encrypted) state.textContent = "無効。通知は暗号化せずに bark-server と APNs を通る";
  else if (d.crypto.confirmed_at === null) state.textContent = "有効・未確認。Bark に鍵を貼ったら「暗号化の確認を送る」で確かめる";
  else {
    $("#crypto-status").textContent = "";
    $("#crypto-reload").hidden = true;
    state.textContent = "有効・確認済み。通知は暗号化して送る";
  }
  $("#crypto-on").hidden = !encrypted;
  $("#crypto-enable").hidden = encrypted;
  $("#crypto-key").textContent = encrypted ? d.crypto.key : "";
  if (!encrypted) $("#crypto-copied").textContent = "";
}

async function call(method, body, path = "") {
  const res = await fetch(`${api}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    $("#error").textContent = await errorMessage(res);
    $("#error").hidden = false;
    return false;
  }
  $("#error").hidden = true;
  render(await res.json());
  return true;
}

await call("GET");

$("#tags").addEventListener("input", () => {
  $("#tags-status").textContent = "";
});

$("#tags-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  let tags;
  try {
    tags = parseTagLines($("#tags").value);
  } catch (e) {
    $("#tags-status").textContent = e.message;
    return;
  }
  if (await call("PATCH", { tags })) $("#tags-status").textContent = "保存した";
});

$("#archive").addEventListener("click", async () => {
  const name = $("#device-name").textContent;
  if (confirm(`${name} (${id}) を退役させる? 送信対象と一覧から外れる。あとで復帰できる`)) await call("DELETE");
});
$("#restore").addEventListener("click", () => call("PATCH", { archived_at: null }));

const COPIED = "コピーした。iPhone の Bark で 暗号化設定 → AES256 / GCM / noPadding / Key に貼る";

// 鍵を作って保存し、そのままクリップボードへ写す (クリックの同期区間で書き込みを始めるため、鍵は Promise のまま渡す)
async function newKey() {
  const res = fetch(`${api}/crypto`, { method: "POST" }).then(async (r) => {
    if (!r.ok) throw new Error(await errorMessage(r));
    return r.json();
  });
  const copied = writeClipboard(res.then((d) => d.crypto.key)).then(
    () => true,
    () => false,
  );
  let d;
  try {
    d = await res;
  } catch (e) {
    $("#error").textContent = e.message;
    $("#error").hidden = false;
    return;
  }
  $("#error").hidden = true;
  render(d);
  $("#crypto-status").textContent = "";
  $("#crypto-reload").hidden = true;
  $("#crypto-copied").textContent = (await copied) ? COPIED : "コピーできなかった。上の鍵を選んでコピーし、iPhone の Bark で 暗号化設定 → AES256 / GCM / noPadding / Key に貼る";
}

$("#crypto-copy").addEventListener("click", async (ev) => {
  await copyText(ev.currentTarget, $("#crypto-key").textContent);
});
$("#crypto-enable").addEventListener("click", newKey);
$("#crypto-renew").addEventListener("click", () => {
  if (confirm("鍵を作り直す? Bark 側に新しい鍵を貼り直すまで、この端末は通知を読めない")) newKey();
});
$("#crypto-disable").addEventListener("click", async () => {
  if (confirm("暗号化を無効にする? 以後の通知は暗号化せずに送る")) await call("PATCH", { crypto: null });
});

// 確認の通知を送る (delivery は平文、crypto は暗号化)。端末でタップされると server 側で確認済みになるので、戻ってきたら読み直す
async function sendConfirm(kind, status, sentText) {
  status.textContent = "送っている";
  const res = await fetch(`${api}/confirm/${kind}`, { method: "POST" });
  if (!res.ok) {
    status.textContent = `送れなかった: ${await errorMessage(res)}`;
    return false;
  }
  status.textContent = sentText;
  return true;
}
$("#delivery-confirm").addEventListener("click", () => sendConfirm("delivery", $("#delivery-status"), "受信確認の通知を送った。iPhone で通知をタップすると確認済みになる"));
$("#crypto-confirm").addEventListener("click", async () => {
  if (await sendConfirm("crypto", $("#crypto-status"), "暗号化の確認の通知を送った。iPhone で通知をタップすると確認済みになる")) $("#crypto-reload").hidden = false;
});
$("#crypto-reload").addEventListener("click", () => call("GET"));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") call("GET");
});
