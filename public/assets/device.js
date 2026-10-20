import { copyText, errorMessage, formatAt, formatTagLines, parseTagLines, writeClipboard } from "./common.js";

const $ = (sel) => document.querySelector(sel);
const id = decodeURIComponent(location.pathname.split("/").at(-1));
const api = `/bark-admin/api/devices/${encodeURIComponent(id)}`;

function setTime(node, iso) {
  node.dateTime = iso;
  node.textContent = formatAt(iso);
  node.title = iso;
}

function render(d) {
  const { name, owner } = d.tags;
  $("#detail").hidden = false;
  $("#device-name").textContent = name ?? "名前なし";
  $("#device-name").classList.toggle("unnamed", name === undefined);
  $("#device-owner").textContent = owner === undefined ? "owner なし" : `owner ${owner}`;
  document.title = `bark-admin: ${name ?? id}`;
  $("#device-id").textContent = d.device_id;
  setTime($("#registered-at"), d.registered_at);
  // APNs が無効と返した端末は bark-server が token を空にする。アプリを起動すると登録し直される
  if (d.device_token === "") $("#device-token").textContent = "なし。Bark アプリを起動すると登録し直される";
  else $("#device-token").replaceChildren(Object.assign(document.createElement("code"), { textContent: d.device_token }));
  $("#tags").value = formatTagLines(d.tags);
  const archived = d.archived_at !== null;
  $("#archived-banner").hidden = !archived;
  if (archived) setTime($("#archived-at"), d.archived_at);
  $("#retire").hidden = archived;
  const encrypted = d.crypto !== null;
  const state = $("#crypto-state");
  if (!encrypted) state.textContent = "無効。通知は暗号化せずに bark-server と APNs を通る";
  else if (d.crypto.confirmed_at === null) state.textContent = "有効・未確認。Bark に鍵を貼ったら「確認」で確かめる";
  else {
    $("#crypto-status").textContent = "";
    $("#crypto-reload").hidden = true;
    state.replaceChildren("有効・確認済み ", Object.assign(document.createElement("time"), { dateTime: d.crypto.confirmed_at, textContent: formatAt(d.crypto.confirmed_at), title: d.crypto.confirmed_at }));
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

// 暗号化した確認の通知を送る。端末でタップされると server 側で確認済みになるので、戻ってきたら読み直す
$("#crypto-confirm").addEventListener("click", async () => {
  const status = $("#crypto-status");
  status.textContent = "送っている";
  const res = await fetch(`${api}/crypto/confirm`, { method: "POST" });
  if (!res.ok) {
    status.textContent = `送れなかった: ${await errorMessage(res)}`;
    return;
  }
  status.textContent = "確認の通知を送った。iPhone で通知をタップすると確認済みになる";
  $("#crypto-reload").hidden = false;
});
$("#crypto-reload").addEventListener("click", () => call("GET"));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") call("GET");
});
