import { el, errorMessage, formatAt, formatTagLines, matchTag, parseJsonl, parseTagLines } from "./common.js";

const GROUP_LABELS = {
  content: "内容",
  display: "表示・グループ",
  alert: "通知音・割り込み",
  action: "コピー・タップ時",
  archive: "履歴・管理",
};
// 通知テストで常に出す項目。残りは「ほかの項目」に畳む
const PRIMARY = new Set(["title", "subtitle", "body", "level", "sound"]);
// 名前を見れば分かるので説明を出さない項目
const SELF_EVIDENT = new Set(["title", "subtitle", "body"]);
// 一覧でチップとして出すタグの数 (owner / name は別の場所に出す)
const SHOWN_TAGS = 4;

const $ = (sel) => document.querySelector(sel);

// 宛先 (フィルタ) と最後に読んだ一覧。一覧・宛先の写し・送信ボタンはここから描く。currentHost は今の公開名 (GET /api/config)
const state = { filter: {}, filterOk: true, devices: [], currentHost: undefined };

function readFilter() {
  const error = $("#filter-error");
  try {
    state.filter = parseTagLines($("#filter").value);
    state.filterOk = true;
    error.hidden = true;
  } catch (e) {
    state.filterOk = false;
    error.textContent = e.message;
    error.hidden = false;
  }
  return state.filterOk;
}

function toggleTag(k, v) {
  if (!readFilter()) return;
  const next = { ...state.filter };
  if (next[k] === v) delete next[k];
  else next[k] = v;
  $("#filter").value = formatTagLines(next);
  readFilter();
  loadDevices();
}

// 宛先のパターン (`*値*` / `*`) に当たっているか。押した状態 (aria-pressed) は宛先にこの k=v そのものがある時だけ
function hits(k, v) {
  const pattern = state.filter[k];
  return pattern !== undefined && matchTag(v, pattern);
}

function tagButton(k, v, { label = `${k}=${v}`, className = "tag" } = {}) {
  const pressed = state.filter[k] === v;
  return el("button", {
    type: "button",
    className: hits(k, v) && !pressed ? `${className} hit` : className,
    textContent: label,
    ariaPressed: String(pressed),
    title: pressed ? `宛先から ${k}=${v} を外す` : `宛先に ${k}=${v} を足す`,
    onclick: () => toggleTag(k, v),
  });
}

function deviceItem(d) {
  const { owner, name, ...rest } = d.tags;
  const archived = d.archived_at !== null;
  // 宛先に一致したタグを先に並べ、畳まれて見えなくならないようにする
  const others = Object.entries(rest).toSorted(([a, av], [b, bv]) => Number(hits(b, bv)) - Number(hits(a, av)));
  const nameClass = ["name", name === undefined ? "unnamed" : "", name !== undefined && hits("name", name) ? "hit" : ""].filter(Boolean).join(" ");
  const who = el(
    "a",
    { className: "who", href: `/bark-admin/devices/${encodeURIComponent(d.device_id)}` },
    el("span", { className: nameClass, textContent: name ?? "名前なし" }),
    ...(d.info.os_version === undefined ? [] : [el("span", { className: "os", textContent: d.info.os_version })]),
    // 古い公開名で追加された端末 (Bark アプリは追加時の address に登録し続ける)。不明な端末には付けない
    ...(d.info.server_host === undefined || d.info.server_host === state.currentHost ? [] : [el("span", { className: "stale-host", textContent: "サーバー名が古い" })]),
    el("span", { className: "id", textContent: d.device_id }),
    ...(d.crypto === null ? [] : [el("span", { className: "encrypted", textContent: d.crypto.confirmed_at === null ? "暗号化 (未確認)" : "暗号化" })]),
    ...(archived ? [el("span", { className: "retired", textContent: `退役 ${formatAt(d.archived_at)}` })] : []),
  );
  const hidden = others.slice(SHOWN_TAGS);
  const tags = el(
    "ul",
    { className: "tags" },
    ...others.slice(0, SHOWN_TAGS).map(([k, v]) => el("li", {}, tagButton(k, v))),
    ...(hidden.length > 0 ? [el("li", { className: "more", textContent: `+${hidden.length}`, title: hidden.map(([k, v]) => `${k}=${v}`).join("\n") })] : []),
  );
  return el(
    "li",
    { className: archived ? "device archived" : "device" },
    who,
    owner === undefined ? el("span", { className: "owner" }) : tagButton("owner", owner, { label: owner, className: "owner tag" }),
    tags,
    el("time", { dateTime: d.registered_at, textContent: formatAt(d.registered_at), title: d.registered_at }),
  );
}

// 宛先の写し (通知を送る側) と送信ボタン。宛先に一致する active な台数が送信先の数
function renderTarget() {
  const send = $("#send");
  const echo = $("#target-echo");
  if (!state.filterOk) {
    $("#match-count").textContent = "";
    echo.replaceChildren(el("span", { className: "label", textContent: "宛先" }), el("span", { className: "error", textContent: "書き方を直すと送れる" }));
    send.disabled = true;
    send.textContent = "送る";
    return;
  }
  const active = state.devices.filter((d) => d.archived_at === null).length;
  const entries = Object.entries(state.filter);
  $("#match-count").textContent = `${active} 台`;
  echo.replaceChildren(
    el("span", { className: "label", textContent: "宛先" }),
    ...(entries.length === 0 ? [el("span", { textContent: "全台" })] : entries.map(([k, v]) => el("span", { className: "tag hit", textContent: `${k}=${v}` }))),
    el("span", { className: "count", textContent: `${active} 台` }),
  );
  send.disabled = active === 0;
  send.textContent = active === 0 ? "宛先に一致する端末がない" : `${active} 台へ送る`;
}

async function loadDevices() {
  if (!readFilter()) {
    renderTarget();
    return;
  }
  const q = new URLSearchParams(state.filter);
  if ($("#show-archived").checked) q.set("archived", "1");
  const res = await fetch(`/bark-admin/api/devices?${q}`);
  const empty = $("#devices-empty");
  if (!res.ok) {
    state.devices = [];
    $("#devices").replaceChildren();
    empty.textContent = `一覧を読めなかった: ${await errorMessage(res)}`;
    empty.hidden = false;
    renderTarget();
    return;
  }
  state.devices = parseJsonl(await res.text());
  $("#devices").replaceChildren(...state.devices.map(deviceItem));
  empty.textContent =
    Object.keys(state.filter).length > 0
      ? "宛先に一致する端末がない。宛先のタグを外すと広がる"
      : "まだ端末がない。「デバイスを追加」で招待を作り、新しい端末で QR を読む";
  empty.hidden = state.devices.length > 0;
  renderTarget();
}

function fieldInput(f) {
  switch (f.kind) {
    case "textarea":
      return el("textarea", { name: f.name, rows: 3 });
    case "integer":
      return el("input", { name: f.name, type: "number", min: f.min, step: 1, inputMode: "numeric" });
    case "url":
      return el("input", { name: f.name, type: "url", autocapitalize: "off", spellcheck: false });
    case "flag":
      return el("input", { name: f.name, type: "checkbox", value: "1" });
    case "enum":
      return el("select", { name: f.name }, el("option", { value: "", textContent: "指定しない" }), ...f.values.map((v) => el("option", { value: v, textContent: v })));
    default:
      return el("input", { name: f.name, type: "text" });
  }
}

function field(f) {
  return el(
    "label",
    { className: `field ${f.kind}` },
    el("span", { className: "label", textContent: f.name }),
    fieldInput(f),
    ...(SELF_EVIDENT.has(f.name) ? [] : [el("small", { textContent: f.description })]),
  );
}

async function renderPushForm() {
  const res = await fetch("/bark-admin/api/schema");
  const { fields } = await res.json();
  $("#primary-fields").replaceChildren(...fields.filter((f) => PRIMARY.has(f.name)).map(field));
  const groups = Map.groupBy(
    fields.filter((f) => !PRIMARY.has(f.name)),
    (f) => f.group,
  );
  $("#more-fields").replaceChildren(
    ...[...groups].map(([group, fs]) => el("fieldset", {}, el("legend", { textContent: GROUP_LABELS[group] ?? group }), el("div", { className: "fields" }, ...fs.map(field)))),
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

function renderPushResult(status, text) {
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // 本文が JSON でない (前段の proxy のエラー等) ときは生の応答だけ出す
  }
  const raw = el("details", {}, el("summary", { textContent: `応答 (HTTP ${status})` }), el("pre", { textContent: text }));
  if (status !== 200 || body === null || !Array.isArray(body.sent)) {
    $("#push-result").replaceChildren(el("p", { className: "error", textContent: body?.error ?? body?.message ?? `送れなかった (HTTP ${status})` }), raw);
    return;
  }
  const names = new Map(state.devices.map((d) => [d.device_id, d.tags.name ?? d.device_id]));
  const failed = body.sent.filter((r) => r.status !== 200).length;
  const skipped = body.skipped > 0 ? `。退役済みの ${body.skipped} 台は外した` : "";
  const total = body.sent.length;
  const summary =
    failed === 0 ? `${total} 台へ送った${skipped}` : failed === total ? `${total} 台とも送れなかった${skipped}` : `${total} 台のうち ${failed} 台へ送れなかった${skipped}`;
  $("#push-result").replaceChildren(
    el("p", { textContent: summary }),
    el(
      "ul",
      {},
      ...body.sent.map((r) =>
        el(
          "li",
          { className: r.status === 200 ? "ok" : "ng" },
          el("span", { textContent: names.get(r.device_id) ?? r.device_id }),
          el("span", { textContent: r.status === 200 ? "送った" : `失敗 ${r.status}` }),
          ...(r.message === undefined ? [] : [el("span", { className: "reason", textContent: r.message })]),
        ),
      ),
    ),
    raw,
  );
}

function countFilledMore(form, fields) {
  const n = Object.keys(collectParams(form, fields)).filter((name) => !PRIMARY.has(name)).length;
  $("#more-filled").textContent = n === 0 ? "" : `${n} 件入力中`;
}

function setupInvite() {
  const dialog = $("#invite-dialog");
  const form = $("#invite-form");
  const home = $("#invite-home");
  const result = $("#invite-result");
  const error = $("#invite-error");

  function showHome() {
    home.hidden = false;
    result.hidden = true;
    error.hidden = true;
  }

  // 招待の QR を出す (作った直後も、一覧から開き直した時も同じ)
  function showQr(inv) {
    $("#invite-qr").src = `/bark-admin/api/invites/${encodeURIComponent(inv.invite)}/qr.svg`;
    $("#invite-add-url").href = inv.add_url;
    $("#invite-add-url").textContent = inv.add_url;
    $("#invite-crypto-note").hidden = !inv.encrypt;
    $("#invite-tags-shown").replaceChildren(...Object.entries(inv.tags).map(([k, v]) => el("li", { className: "tag", textContent: `${k}=${v}` })));
    home.hidden = true;
    result.hidden = false;
  }

  function inviteItem(inv) {
    const tags = Object.entries(inv.tags);
    const facts = [inv.encrypt ? "暗号化" : "", inv.registered > 0 ? `${inv.registered} 台登録` : "未登録", `作成 ${formatAt(inv.created_at)}`].filter(Boolean).join(" ・ ");
    return el(
      "li",
      { className: "invite-item" },
      el(
        "div",
        { className: "what" },
        el("ul", { className: "tags" }, ...(tags.length === 0 ? [el("li", { className: "hint", textContent: "タグなし" })] : tags.map(([k, v]) => el("li", { className: "tag", textContent: `${k}=${v}` })))),
        el("span", { className: "hint", textContent: facts }),
      ),
      el(
        "div",
        { className: "actions" },
        el("button", { type: "button", className: "secondary", textContent: "QR", onclick: () => showQr(inv) }),
        el("button", { type: "button", className: "secondary danger", textContent: "削除", onclick: () => removeInvite(inv) }),
      ),
    );
  }

  async function loadInvites() {
    const res = await fetch("/bark-admin/api/invites");
    const empty = $("#invites-empty");
    if (!res.ok) {
      $("#invites").replaceChildren();
      empty.textContent = `招待を読めなかった: ${await errorMessage(res)}`;
      empty.hidden = false;
      return;
    }
    const invites = parseJsonl(await res.text()).toSorted((a, b) => b.created_at.localeCompare(a.created_at));
    $("#invites").replaceChildren(...invites.map(inviteItem));
    empty.textContent = "まだ招待がない。上で作る";
    empty.hidden = invites.length > 0;
  }

  async function removeInvite(inv) {
    const label = Object.entries(inv.tags).map(([k, v]) => `${k}=${v}`).join(" ") || "タグなし";
    if (!confirm(`招待 (${label}) を削除する? QR は使えなくなる。登録済みの端末はそのまま`)) return;
    const res = await fetch(`/bark-admin/api/invites/${encodeURIComponent(inv.invite)}`, { method: "DELETE" });
    if (!res.ok) {
      error.textContent = `削除できなかった: ${await errorMessage(res)}`;
      error.hidden = false;
    }
    await loadInvites();
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    let tags;
    try {
      tags = parseTagLines($("#invite-tags").value);
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
      return;
    }
    const body = { tags, encrypt: $("#invite-encrypt").checked };
    const res = await fetch("/bark-admin/api/invites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) {
      error.textContent = `招待を作れなかった: ${await errorMessage(res)}`;
      error.hidden = false;
      return;
    }
    form.reset();
    showQr(await res.json());
    loadInvites();
  });

  $("#invite-back").addEventListener("click", () => {
    showHome();
    loadInvites();
  });

  // 閉じたら次に開く時は一覧から。招待を読んだ端末が増えているかもしれないので一覧も読み直す
  dialog.addEventListener("close", () => {
    showHome();
    loadInvites();
    loadDevices();
  });
  loadInvites();
}

async function main() {
  const [fields, config] = await Promise.all([renderPushForm(), fetch("/bark-admin/api/config").then((r) => r.json())]);
  state.currentHost = config.server_host;
  await loadDevices();

  let timer;
  $("#filter").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(loadDevices, 300);
  });
  $("#show-archived").addEventListener("change", loadDevices);
  // 別の端末で招待を読んで戻ってきた時に一覧を新しくする
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") loadDevices();
  });

  const form = $("#push-form");
  form.addEventListener("input", () => countFilledMore(form, fields));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!readFilter()) return;
    const send = $("#send");
    send.disabled = true;
    send.textContent = "送っている";
    const body = { ...collectParams(form, fields), ...(Object.keys(state.filter).length > 0 ? { device: state.filter } : {}) };
    const res = await fetch("/bark-admin/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    renderPushResult(res.status, await res.text());
    renderTarget();
  });

  setupInvite();
}

main();
