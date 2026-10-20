import { errorMessage, formatTagLines, parseTagLines } from "./common.js";

const $ = (sel) => document.querySelector(sel);
const id = decodeURIComponent(location.pathname.split("/").at(-1));
const api = `/bark-admin/api/devices/${encodeURIComponent(id)}`;

function render(d) {
  $("#detail").hidden = false;
  $("#registered-at").textContent = d.registered_at;
  $("#device-token").textContent = d.device_token;
  $("#tags").value = formatTagLines(d.tags);
  const archived = d.archived_at !== null;
  $("#archived-badge").hidden = !archived;
  $("#archived-at").textContent = d.archived_at ?? "";
  $("#archive").hidden = archived;
  $("#restore").hidden = !archived;
}

async function call(method, body) {
  const res = await fetch(api, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    $("#error").textContent = await errorMessage(res);
    $("#error").hidden = false;
    return;
  }
  $("#error").hidden = true;
  render(await res.json());
  return true;
}

$("#device-id").textContent = id;
document.title = `bark-admin: ${id}`;
await call("GET");

$("#tags-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  let tags;
  try {
    tags = parseTagLines($("#tags").value);
  } catch (e) {
    $("#tags-status").textContent = e.message;
    return;
  }
  if (await call("PATCH", { tags })) $("#tags-status").textContent = "保存しました";
});

$("#archive").addEventListener("click", async () => {
  if (confirm(`${id} を退役させますか? 送信対象と一覧から外れます (復帰可)。`)) await call("DELETE");
});
$("#restore").addEventListener("click", () => call("PATCH", { archived_at: null }));
