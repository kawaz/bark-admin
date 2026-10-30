import { matchTag } from "../registry.ts";
import { pushParamFields } from "../schema/push-params.ts";
import { chip, chips, icon, tagChips } from "../ui/components.ts";
import { html } from "../ui/html.ts";
import { deviceRow, inviteItem, inviteQrUrl, PRIMARY_FIELDS, type TagMatch } from "../ui/views.ts";
import { ConfigSchema, DeviceListItemSchema, failure, InviteSchema, postJson, PushResultSchema, readJson, readJsonl, typedBody, type DeviceListItem, type Fetched, type Invite, type PushResult } from "./api.ts";
import { byId, copyText, formatTagLines, parseTagLines, setHtml } from "./dom.ts";

// TOP: 宛先 (フィルタ) と端末の一覧。通知テストとデバイスの追加はダイアログ (#send-dialog / #add-dialog) で開く

const filterInput = byId("filter", HTMLTextAreaElement);
const filterError = byId("filter-error", HTMLElement);
const showArchived = byId("show-archived", HTMLInputElement);
const list = byId("devices", HTMLUListElement);
const empty = byId("devices-empty", HTMLElement);
const pushForm = byId("push-form", HTMLFormElement);
const sendButton = byId("send", HTMLButtonElement);

// 宛先 (フィルタ) と最後に読んだ一覧。一覧・宛先の写し・送信ボタンはここから描く。currentHost は今の公開名 (GET /api/config)
const state: { filter: Record<string, string>; filterOk: boolean; devices: DeviceListItem[]; currentHost: string; sending: boolean } = {
  filter: {},
  filterOk: true,
  devices: [],
  currentHost: "",
  sending: false,
};

function readFilter(): boolean {
  const r = parseTagLines(filterInput.value);
  state.filterOk = r.ok;
  if (r.ok) {
    state.filter = r.tags;
    filterError.hidden = true;
  } else {
    filterError.textContent = r.error;
    filterError.hidden = false;
  }
  return r.ok;
}

// 宛先のパターン (`*値*` / `*`) に当たっているか。押した状態は宛先にこの k=v そのものがある時だけ
const match: TagMatch = {
  hits: (k, v) => {
    const pattern = state.filter[k];
    return pattern !== undefined && matchTag(v, pattern);
  },
  pressed: (k, v) => state.filter[k] === v,
};

function toggleTag(k: string, v: string): void {
  if (!readFilter()) return;
  const next = { ...state.filter };
  if (next[k] === v) delete next[k];
  else next[k] = v;
  filterInput.value = formatTagLines(next);
  readFilter();
  void loadDevices();
}

// 移行先の名前は一覧に読み込んだ端末から引く (宛先で絞って一覧に無ければ device_id のまま)
const nameOf = (id: string): string | undefined => state.devices.find((d) => d.device_id === id)?.tags["name"];

const active = () => state.devices.filter((d) => d.archived_at === null);

function names(devices: DeviceListItem[]): string {
  return devices.map((d) => d.tags["name"] ?? d.device_id).join("、");
}

// 宛先の写し (一致数・通知を送るボタン・送信ダイアログの宛先と送信ボタン)。宛先に一致する active な台数が送信先の数
function renderTarget(): void {
  const count = byId("match-count", HTMLElement);
  const text = byId("match-text", HTMLElement);
  const open = byId("open-send", HTMLButtonElement);
  const echo = byId("target-echo", HTMLElement);
  if (!state.filterOk) {
    count.textContent = "";
    text.textContent = "宛先の書き方を直すと送れる";
    open.disabled = true;
    setOpenLabel(open, "通知を送る");
    setHtml(echo, html`<p class="error">宛先の書き方を直すと送れる</p>`);
    sendButton.disabled = true;
    sendButton.textContent = "送る";
    return;
  }
  const targets = active();
  const n = targets.length;
  const entries = Object.entries(state.filter);
  const archived = state.devices.length - n;
  setHtml(count, html`${n}<small>台</small>`);
  text.textContent = `${n === 0 ? "宛先に一致する端末がない" : entries.length === 0 ? "が宛先 (条件なしで全台)" : "が宛先"}${archived > 0 ? `。表示中のアーカイブ済み ${archived} 台には送らない` : ""}`;
  open.disabled = n === 0;
  setOpenLabel(open, n === 0 ? "通知を送る" : `${n} 台へ通知を送る`);
  setHtml(
    echo,
    html`<div class="echo-head"><span class="label">宛先</span><span class="count">${n} 台</span></div>${entries.length === 0 ? html`<p class="hint">条件なし (全台)</p>` : chips(entries.map(([k, v]) => chip(k, v)))}${n === 0 ? "" : html`<p class="hint">${names(targets)}</p>`}`,
  );
  if (!state.sending) {
    sendButton.disabled = n === 0;
    sendButton.textContent = n === 0 ? "宛先に一致する端末がない" : `${n} 台へ送る`;
  }
}

// ボタンの絵 (svg) は残して文言だけ差し替える
function setOpenLabel(button: HTMLButtonElement, label: string): void {
  const last = button.lastChild;
  if (last !== null && last.nodeType === Node.TEXT_NODE) last.textContent = label;
  else button.append(label);
}

async function loadDevices(): Promise<void> {
  if (!readFilter()) {
    renderTarget();
    return;
  }
  const q = new URLSearchParams(state.filter);
  if (showArchived.checked) q.set("archived", "1");
  const r = await readJsonl(await fetch(`/bark-admin/api/devices?${q}`), DeviceListItemSchema);
  if (!r.ok) {
    state.devices = [];
    list.replaceChildren();
    empty.textContent = `一覧を読めなかった: ${r.error}`;
    empty.hidden = false;
    renderTarget();
    return;
  }
  state.devices = r.value;
  setHtml(list, html`${state.devices.map((d) => deviceRow(d, state.currentHost, match, nameOf))}`);
  list.parentElement?.toggleAttribute("hidden", state.devices.length === 0);
  byId("devices-count", HTMLElement).textContent = `${state.devices.length} 台`;
  empty.textContent =
    Object.keys(state.filter).length > 0 ? "宛先に一致する端末がない。宛先のタグを外すと広がる" : "まだ端末がない。「デバイスを追加」で招待を作り、新しい端末で QR を読む";
  empty.hidden = state.devices.length > 0;
  renderTarget();
}

// 一覧のチップは宛先の付け外し (行のリンクより上に乗っている)
list.addEventListener("click", (ev) => {
  if (!(ev.target instanceof Element)) return;
  const b = ev.target.closest("button[data-tag-k]");
  if (!(b instanceof HTMLButtonElement)) return;
  toggleTag(b.dataset["tagK"] ?? "", b.dataset["tagV"] ?? "");
});

// ---------- 通知を送る ----------

function collectParams(): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  const data = new FormData(pushForm);
  for (const f of pushParamFields) {
    const value = data.get(f.name);
    if (typeof value !== "string" || value === "") continue;
    params[f.name] = f.kind === "integer" ? Number(value) : value;
  }
  return params;
}

function countFilledMore(): void {
  const n = Object.keys(collectParams()).filter((name) => !PRIMARY_FIELDS.has(name)).length;
  byId("more-filled", HTMLElement).textContent = n === 0 ? "" : `${n} 件入力中`;
}

// 見本の通知に title / body を写す (空なら仮の文言)
function renderPreview(): void {
  const params = collectParams();
  byId("preview-title", HTMLElement).textContent = typeof params["title"] === "string" ? params["title"] : "タイトル";
  byId("preview-body", HTMLElement).textContent = typeof params["body"] === "string" ? params["body"] : typeof params["markdown"] === "string" ? params["markdown"] : "本文がここに出る";
}

function renderPushResult(status: number, text: string, parsed: Fetched<PushResult>): void {
  const out = byId("push-result", HTMLElement);
  out.hidden = false;
  const raw = html`<details class="raw"><summary>応答 (HTTP ${status})</summary><pre>${text}</pre></details>`;
  if (!parsed.ok) {
    setHtml(out, html`<p class="error">${parsed.error}</p>${raw}`);
    return;
  }
  const body = parsed.value;
  const nameOf = new Map(state.devices.map((d) => [d.device_id, d.tags["name"] ?? d.device_id]));
  const failed = body.sent.filter((r) => r.status !== 200).length;
  const total = body.sent.length;
  const skipped = body.skipped > 0 ? `。アーカイブ済みの ${body.skipped} 台は外した` : "";
  const summary = failed === 0 ? `${total} 台へ送った${skipped}` : failed === total ? `${total} 台とも送れなかった${skipped}` : `${total} 台のうち ${failed} 台へ送れなかった${skipped}`;
  const at = new Date().toTimeString().slice(0, 8);
  setHtml(
    out,
    html`<h3>送信結果 <small>${at}</small></h3><p>${summary}</p><ul>${body.sent.map(
      (r) =>
        html`<li class="result ${r.status === 200 ? "ok" : "ng"}">${icon(r.status === 200 ? "ok" : "ng")}<div><b>${nameOf.get(r.device_id) ?? r.device_id}</b><p>${r.status === 200 ? `届けた${r.encrypted ? " (暗号化して送信)" : ""}` : `失敗 ${r.status}${r.message === undefined ? "" : `: ${r.message}`}`}</p></div></li>`,
    )}</ul>${raw}`,
  );
}

pushForm.addEventListener("input", () => {
  countFilledMore();
  renderPreview();
});
pushForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!readFilter()) return;
  state.sending = true;
  sendButton.disabled = true;
  sendButton.textContent = "送っている";
  const body = { ...collectParams(), ...(Object.keys(state.filter).length > 0 ? { device: state.filter } : {}) };
  const res = await postJson("/bark-admin/push", body);
  // 結果は本文をそのままも見せるので、読んだ本文から型付きにする
  const text = await res.text();
  const parsed = typedBody(res, text, PushResultSchema);
  state.sending = false;
  renderPushResult(res.status, text, parsed);
  renderTarget();
  byId("push-result", HTMLElement).scrollIntoView({ block: "nearest" });
});

// ---------- デバイスを追加 ----------

const addDialog = byId("add-dialog", HTMLDialogElement);
const inviteHome = byId("invite-home", HTMLElement);
const inviteResult = byId("invite-result", HTMLElement);
const inviteError = byId("invite-error", HTMLElement);
const inviteList = byId("invites", HTMLUListElement);
let invites: Invite[] = [];
let shownInvite: Invite | null = null;

function showHome(): void {
  inviteHome.hidden = false;
  inviteResult.hidden = true;
  inviteError.hidden = true;
}

// 招待の QR を出す (作った直後も、一覧から開き直した時も同じ)
function showQr(inv: Invite): void {
  shownInvite = inv;
  byId("invite-qr", HTMLImageElement).src = inviteQrUrl(inv.invite);
  const link = byId("invite-add-url", HTMLAnchorElement);
  link.href = inv.add_url;
  link.textContent = inv.add_url;
  byId("invite-crypto-note", HTMLElement).hidden = !inv.encrypt;
  setHtml(byId("invite-tags-shown", HTMLElement), tagChips(inv.tags));
  inviteHome.hidden = true;
  inviteResult.hidden = false;
}

async function loadInvites(): Promise<void> {
  const r = await readJsonl(await fetch("/bark-admin/api/invites"), InviteSchema);
  const none = byId("invites-empty", HTMLElement);
  if (!r.ok) {
    inviteList.replaceChildren();
    none.textContent = `招待を読めなかった: ${r.error}`;
    none.hidden = false;
    return;
  }
  invites = r.value.toSorted((a, b) => b.created_at.localeCompare(a.created_at));
  setHtml(inviteList, html`${invites.map(inviteItem)}`);
  none.textContent = "まだ招待がない。上で作る";
  none.hidden = invites.length > 0;
}

async function removeInvite(inv: Invite): Promise<void> {
  const label = formatTagLines(inv.tags).replaceAll("\n", " ") || "タグなし";
  if (!confirm(`招待 (${label}) を削除する? QR は使えなくなる。登録済みの端末はそのまま`)) return;
  const err = await failure(await fetch(`/bark-admin/api/invites/${encodeURIComponent(inv.invite)}`, { method: "DELETE" }));
  if (err !== null) {
    inviteError.textContent = `削除できなかった: ${err}`;
    inviteError.hidden = false;
  }
  await loadInvites();
}

inviteList.addEventListener("click", (ev) => {
  if (!(ev.target instanceof Element)) return;
  const b = ev.target.closest("button[data-action]");
  const li = ev.target.closest("li[data-invite]");
  if (!(b instanceof HTMLButtonElement) || !(li instanceof HTMLElement)) return;
  const inv = invites.find((i) => i.invite === li.dataset["invite"]);
  if (inv === undefined) return;
  const action = b.dataset["action"];
  if (action === "show-qr") showQr(inv);
  if (action === "copy-url") void copyText(b, inv.add_url);
  if (action === "delete") void removeInvite(inv);
});

byId("invite-form", HTMLFormElement).addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const tags = parseTagLines(byId("invite-tags", HTMLTextAreaElement).value);
  if (!tags.ok) {
    inviteError.textContent = tags.error;
    inviteError.hidden = false;
    return;
  }
  const res = await postJson("/bark-admin/api/invites", { tags: tags.tags, encrypt: byId("invite-encrypt", HTMLInputElement).checked });
  const r = await readJson(res, InviteSchema);
  if (!r.ok) {
    inviteError.textContent = `招待を作れなかった: ${r.error}`;
    inviteError.hidden = false;
    return;
  }
  showQr(r.value);
  void loadInvites();
});

byId("invite-copy", HTMLButtonElement).addEventListener("click", (ev) => {
  if (shownInvite !== null && ev.currentTarget instanceof HTMLButtonElement) void copyText(ev.currentTarget, shownInvite.add_url);
});
byId("invite-back", HTMLButtonElement).addEventListener("click", () => {
  showHome();
  void loadInvites();
});

// 閉じたら次に開く時は一覧から。招待を読んだ端末が増えているかもしれないので一覧も読み直す
addDialog.addEventListener("close", () => {
  showHome();
  void loadInvites();
  void loadDevices();
});

// ---------- 起動 ----------

async function main(): Promise<void> {
  const config = await readJson(await fetch("/bark-admin/api/config"), ConfigSchema);
  if (config.ok) state.currentHost = config.value.server_host;
  else {
    empty.textContent = `設定を読めなかった: ${config.error}`;
    empty.hidden = false;
  }
  await loadDevices();
  void loadInvites();

  let timer: ReturnType<typeof setTimeout> | undefined;
  filterInput.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void loadDevices(), 300);
  });
  showArchived.addEventListener("change", () => void loadDevices());
  // 別の端末で招待を読んで戻ってきた時に一覧を新しくする
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void loadDevices();
  });
}

void main();
