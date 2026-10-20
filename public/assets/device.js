import { copyText, errorMessage, formatAt, formatTagLines, parseTagLines } from "./common.js";

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
  $("#crypto-state").textContent = encrypted
    ? "有効。通知の中身をこの鍵で暗号化して送る。bark-server と APNs からは読めない"
    : "無効。通知は暗号化せずに bark-server と APNs を通る";
  $("#crypto-on").hidden = !encrypted;
  $("#crypto-enable").hidden = encrypted;
  $("#crypto-key").textContent = encrypted ? d.crypto.key : "";
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

$("#crypto-copy").addEventListener("click", (ev) => copyText(ev.currentTarget, $("#crypto-key").textContent));
$("#crypto-enable").addEventListener("click", () => call("POST", undefined, "/crypto"));
$("#crypto-renew").addEventListener("click", async () => {
  if (confirm("鍵を作り直す? Bark 側に新しい鍵を貼り直すまで、この端末は通知を読めない")) await call("POST", undefined, "/crypto");
});
$("#crypto-disable").addEventListener("click", async () => {
  if (confirm("暗号化を無効にする? 以後の通知は暗号化せずに送る")) await call("PATCH", { crypto: null });
});
