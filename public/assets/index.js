import { el, errorMessage, parseJsonl, parseTagLines } from "./common.js";

const GROUP_LABELS = {
  content: "内容",
  display: "表示・グループ",
  alert: "通知音・割り込み",
  action: "コピー・タップ時",
  encryption: "暗号化",
  archive: "履歴・管理",
};
// 一覧で列にせずチップで出すタグの数 (owner / name は列)
const SHOWN_TAGS = 4;

const $ = (sel) => document.querySelector(sel);

function currentFilter() {
  return parseTagLines($("#filter").value);
}

async function loadDevices() {
  const tbody = $("#devices tbody");
  let filter;
  try {
    filter = currentFilter();
  } catch (e) {
    $("#device-count").textContent = e.message;
    return;
  }
  const q = new URLSearchParams(filter);
  if ($("#show-archived").checked) q.set("archived", "1");
  const res = await fetch(`/api/devices?${q}`);
  if (!res.ok) {
    $("#device-count").textContent = await errorMessage(res);
    return;
  }
  const devices = parseJsonl(await res.text());
  tbody.replaceChildren(
    ...devices.map((d) => {
      const { owner = "", name = "", ...rest } = d.tags;
      const others = Object.entries(rest);
      const chips = others.slice(0, SHOWN_TAGS).map(([k, v]) => el("span", { className: "chip", textContent: `${k}=${v}` }));
      if (others.length > SHOWN_TAGS) chips.push(el("span", { className: "more", textContent: `+${others.length - SHOWN_TAGS}` }));
      const row = el(
        "tr",
        {},
        el("td", {}, el("a", { href: `/devices/${encodeURIComponent(d.device_id)}`, textContent: d.device_id })),
        el("td", { textContent: owner }),
        el("td", { textContent: name }),
        el("td", {}, ...chips),
        el("td", { textContent: d.registered_at }),
      );
      if (d.archived_at !== null) row.classList.add("archived");
      return row;
    }),
  );
  $("#device-count").textContent = `${devices.length} 台`;
  $("#devices-empty").hidden = devices.length > 0;
}

function fieldInput(f) {
  const id = `param-${f.name}`;
  switch (f.kind) {
    case "textarea":
      return el("textarea", { id, name: f.name, rows: 3 });
    case "integer":
      return el("input", { id, name: f.name, type: "number", min: f.min, step: 1 });
    case "url":
      return el("input", { id, name: f.name, type: "url" });
    case "flag":
      return el("input", { id, name: f.name, type: "checkbox", value: "1" });
    case "enum":
      return el("select", { id, name: f.name }, el("option", { value: "", textContent: "(未指定)" }), ...f.values.map((v) => el("option", { value: v, textContent: v })));
    default:
      return el("input", { id, name: f.name, type: "text" });
  }
}

async function renderPushForm() {
  const res = await fetch("/api/schema");
  const { fields } = await res.json();
  const groups = Map.groupBy(fields, (f) => f.group);
  $("#push-fields").replaceChildren(
    ...[...groups].map(([group, fs]) =>
      el(
        "fieldset",
        {},
        el("legend", { textContent: GROUP_LABELS[group] ?? group }),
        ...fs.map((f) => el("label", { className: `field ${f.kind}`, title: f.description }, el("span", { textContent: f.name }), fieldInput(f), el("small", { textContent: f.description }))),
      ),
    ),
  );
  return fields;
}

function collectParams(form, fields) {
  const params = {};
  for (const f of fields) {
    const input = form.elements.namedItem(f.name);
    if (f.kind === "flag") {
      if (input.checked) params[f.name] = "1";
    } else if (input.value !== "") {
      params[f.name] = f.kind === "integer" ? Number(input.value) : input.value;
    }
  }
  return params;
}

async function main() {
  const fields = await renderPushForm();
  await loadDevices();

  let timer;
  $("#filter").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(loadDevices, 300);
  });
  $("#show-archived").addEventListener("change", loadDevices);

  $("#push-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const out = $("#push-result");
    out.hidden = false;
    let filter;
    try {
      filter = currentFilter();
    } catch (e) {
      out.textContent = e.message;
      return;
    }
    const body = { ...collectParams(ev.target, fields), ...(Object.keys(filter).length > 0 ? { device: filter } : {}) };
    const res = await fetch("/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    out.textContent = `${res.status}\n${await res.text()}`;
  });

  $("#invite-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    let tags;
    try {
      tags = parseTagLines($("#invite-tags").value);
    } catch (e) {
      alert(e.message);
      return;
    }
    const res = await fetch("/api/invites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tags }) });
    if (!res.ok) {
      alert(await errorMessage(res));
      return;
    }
    const inv = await res.json();
    $("#invite-qr").src = `/api/invites/${encodeURIComponent(inv.invite)}/qr.svg`;
    $("#invite-add-url").href = inv.add_url;
    $("#invite-add-url").textContent = inv.add_url;
    $("#invite-addserver-url").href = inv.addserver_url;
    $("#invite-result").hidden = false;
  });
}

main();
