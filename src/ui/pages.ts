import { assetUrl } from "../assets.ts";
import { pushParamFields, type FieldGroup, type FieldSpec } from "../schema/push-params.ts";
import {
  actions,
  appBar,
  backBar,
  button,
  code,
  dialog,
  emptyState,
  field,
  hint,
  icon,
  keyBox,
  linkButton,
  notificationPreview,
  opener,
  panel,
  rows,
  section,
  segmented,
  step,
  switchRow,
  tagChips,
  textarea,
  type Row,
} from "./components.ts";
import { html, type Html, type Part } from "./html.ts";
import { ADMIN, cryptoValue, deliveryValue, deviceHref, PRIMARY_FIELDS } from "./views.ts";
import { time } from "./components.ts";

// サーバが組むページの HTML。TOP と詳細は枠 (見出し・節の入れ物・ダイアログ) だけを組み、中身は src/client/ が API の値で描く。
// 招待・移行・確認できた・見つからないの各ページは、iPhone の Safari で 1 回開かれるだけなのでサーバで組み切る

export const APP_STORE_URL = "https://apps.apple.com/app/bark-custom-notifications/id1403753865";

function page(o: { title: string; body: Part; script?: string; bodyClass?: string }): string {
  return html`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${o.title}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="${assetUrl("style.css")}">
${o.script === undefined ? "" : html`<script type="module" src="${assetUrl(o.script)}"></script>
`}</head>
<body${o.bodyClass === undefined ? html`` : html` class="${o.bodyClass}"`}>
${o.body}
</body>
</html>
`.value;
}

// ---------- TOP ----------

// 通知テストの各項目の見出し (param 名は脇に小さく添える)
const FIELD_LABELS: Record<string, string> = {
  title: "タイトル",
  subtitle: "サブタイトル",
  body: "本文",
  markdown: "Markdown の本文 (body より優先)",
  group: "グループ",
  icon: "アイコンの URL",
  image: "画像の URL",
  badge: "バッジの数",
  level: "割り込みの強さ",
  volume: "重要な通知の音量",
  call: "30 秒鳴らし続ける",
  sound: "着信音",
  copy: "コピーする文字",
  autoCopy: "届いたら自動でコピーする",
  url: "タップで開く URL",
  action: "タップしたときの動き",
  isArchive: "履歴に残す",
  ttl: "履歴に残す秒数",
  id: "通知の ID",
  delete: "この ID の通知を消す",
};

const GROUP_LABELS: Record<FieldGroup, string> = { content: "本文", display: "表示", alert: "鳴り方", action: "タップしたとき", archive: "履歴" };

const LEVEL_OPTIONS = [
  { value: "", label: "既定", title: "指定しない (アプリの既定)" },
  { value: "active", label: "通常", title: "active" },
  { value: "timeSensitive", label: "即時", title: "timeSensitive" },
  { value: "passive", label: "控えめ", title: "passive" },
  { value: "critical", label: "重要", title: "critical: 消音中でも鳴る" },
];

// Bark アプリに入っている着信音 (sound は自由入力で、これは候補)
const SOUNDS = ["alarm", "anticipate", "bell", "birdsong", "bloom", "calypso", "chime", "choo", "descent", "electronic", "fanfare", "glass", "gotosleep", "healthnotification", "horn", "ladder", "mailsent", "minuet", "multiwayinvitation", "newmail", "newsflash", "noir", "paymentsuccess", "shake", "sherwoodforest", "silence", "spell", "suspense", "telegraph", "tiptoes", "typewriters", "update"];

function pushControl(f: FieldSpec): Html {
  const id = `p-${f.name}`;
  switch (f.kind) {
    case "textarea":
      return textarea(id, "", { name: f.name, rows: 2 });
    case "integer":
      return html`<input type="number" id="${id}" name="${f.name}" min="${f.min}" step="1" inputmode="numeric">`;
    case "url":
      return html`<input type="url" id="${id}" name="${f.name}" inputmode="url" autocapitalize="off" spellcheck="false">`;
    case "enum":
      return html`<select id="${id}" name="${f.name}"><option value="">指定しない</option>${f.values.map((val) => html`<option value="${val}">${val}</option>`)}</select>`;
    case "flag":
      return html``;
    case "text":
      return f.name === "sound"
        ? html`<input type="text" id="${id}" name="${f.name}" list="sounds" autocapitalize="off" autocomplete="off" placeholder="端末の設定どおり"><datalist id="sounds">${SOUNDS.map((s) => html`<option value="${s}"></option>`)}</datalist>`
        : html`<input type="text" id="${id}" name="${f.name}">`;
  }
}

function pushField(f: FieldSpec): Html {
  const label = FIELD_LABELS[f.name] ?? f.name;
  if (f.kind === "flag") return switchRow({ id: `p-${f.name}`, name: f.name, value: "1", label, hint: f.name });
  if (f.name === "level") return segmented({ name: "level", label, param: "level", options: LEVEL_OPTIONS, checked: "" });
  return field({ id: `p-${f.name}`, label, param: f.name, control: pushControl(f), ...(PRIMARY_FIELDS.has(f.name) ? {} : { hint: f.description }) });
}

function pushForm(): Html {
  const primary = pushParamFields.filter((f) => PRIMARY_FIELDS.has(f.name));
  const rest = pushParamFields.filter((f) => !PRIMARY_FIELDS.has(f.name));
  const groups = Map.groupBy(rest, (f) => f.group);
  return html`<form id="push-form" class="stack">
<div class="stack">${primary.map(pushField)}</div>
<details class="more">
<summary><span>その他の項目<span class="count">${rest.length}</span><span id="more-filled" class="filled"></span></span>${icon("chev")}</summary>
<div class="groups">${[...groups].map(([g, fs]) => html`<fieldset><legend>${GROUP_LABELS[g]}</legend><div class="grid">${fs.map(pushField)}</div></fieldset>`)}</div>
</details>
<div class="sheet-foot"><button type="submit" id="send" class="btn btn-primary btn-block">送る</button></div>
</form>`;
}

function sendDialog(): Html {
  return dialog({
    id: "send-dialog",
    title: "通知を送る",
    wide: true,
    body: html`<div id="target-echo" class="target-echo" aria-live="polite"></div>
${notificationPreview("タイトル", "本文がここに出る")}
${pushForm()}
<div id="push-result" class="results" aria-live="polite" hidden></div>`,
  });
}

function addDialog(): Html {
  return dialog({
    id: "add-dialog",
    title: "デバイスを追加",
    body: html`<div id="invite-home" class="stack">
<form id="invite-form" class="stack">
${hint("招待を作ると QR が出る。追加したい iPhone / iPad のカメラで読むと、登録の手順が開く")}
${field({ id: "invite-tags", label: "新しい端末に付けるタグ", control: textarea("invite-tags", "owner=kawaz\nfamily=kawazu", { kv: true, rows: 3, attrs: { "aria-describedby": "invite-error" } }), hint: html`1 行に 1 つ ${code("key=value")}。あとから詳細画面で直せる` })}
${switchRow({ id: "invite-encrypt", label: "暗号化する", hint: "端末ごとの鍵を作り、招待ページから Bark に貼ってもらう", checked: true })}
<p id="invite-error" class="error" role="alert" hidden></p>
${actions(html`<button type="submit" class="btn btn-primary">招待を作る</button>`)}
</form>
${section("invites", "作成済みの招待", html`${hint("招待は削除するまで何度でも使える。QR を読んで開くたびに、その 1 台用の登録リンク (24 時間) が出る")}<ul id="invites" class="invites"></ul>${emptyState("まだ招待がない。上で作る", { id: "invites-empty", hidden: true })}`)}
</div>
<div id="invite-result" class="invite-result stack" hidden>
<img id="invite-qr" class="qr" alt="招待ページの QR コード" width="240" height="240">
<p>新しい端末のカメラで読み取る。開いたページの「Bark にサーバーを追加」を押すと、このタグで登録される。</p>
<div id="invite-tags-shown"></div>
<p id="invite-crypto-note" class="hint" hidden>暗号化する招待。招待ページに出る端末ごとの鍵を Bark の「推送加密 / Push Encryption」に貼るまで、通知は読めない</p>
<p class="url"><a id="invite-add-url"></a></p>
${actions(button("URL をコピー", { attrs: { id: "invite-copy" } }), button("招待の一覧に戻る", { variant: "quiet", attrs: { id: "invite-back" } }))}
</div>`,
  });
}

// 操作は宛先のパネルの下端に集める (一致した台数の行と、通知を送る・デバイスを追加)。どの幅でも 宛先 → 操作 → 一覧 の 1 列
export function indexPageHtml(currentHost: string): string {
  return page({
    title: "端末 - bark-admin",
    script: "index.js",
    bodyClass: "page-top",
    body: html`${appBar({ title: "端末", sub: currentHost })}
<main class="top">
${section(
  "filter",
  "宛先",
  panel(
    html`<div class="panel-body">
${field({ id: "filter", label: html`<span class="sr-only">宛先の条件</span>`, control: textarea("filter", "", { kv: true, rows: 2, attrs: { placeholder: "owner=kawaz", "aria-describedby": "filter-hint filter-error" } }) })}
${hint(html`1 行に 1 つ ${code("key=value")}。全部に一致する端末へ送る。${code("key=*値*")} で値を含むもの、${code("key=*")} でそのタグがあるもの。空なら全台。一覧のタグを押しても足せる`, { id: "filter-hint" })}
<p id="filter-error" class="error" role="alert" hidden></p>
${switchRow({ id: "show-archived", label: "退役済みも表示" })}
</div>
<div class="target-bar">
<p class="match" aria-live="polite"><span id="match-count" class="count"></span><span id="match-text" class="hint"></span></p>
<div class="target-acts">${opener("通知を送る", "send-dialog", { variant: "primary", icon: "send", attrs: { id: "open-send" } })}${opener("デバイスを追加", "add-dialog", { icon: "plus" })}</div>
</div>`,
  ),
)}
${section("devices", "端末", html`${panel(html`<ul id="devices" class="devices"></ul>`)}${emptyState("", { id: "devices-empty", hidden: true })}`, { aside: html`<span id="devices-count"></span>` })}
</main>
${sendDialog()}
${addDialog()}`,
  });
}

// ---------- 詳細 ----------

const KEY_HELP = "Bark の「推送加密 / Push Encryption」で Algorithm を AES256、Mode を GCM、Padding を noPadding にし、Key にこの鍵を貼る";

function deviceDialogs(): Html {
  return html`${dialog({
    id: "delivery-dialog",
    title: "受信確認",
    body: html`<p id="delivery-state"></p>
${hint("平文の確認通知をこの端末へ送る。端末で通知をタップすると確認済みになる")}
${actions(button("受信確認を送る", { variant: "primary", attrs: { id: "delivery-confirm" } }))}
<output id="delivery-status" class="hint"></output>`,
  })}
${dialog({
  id: "crypto-dialog",
  title: "暗号化",
  body: html`<div id="crypto-meter"></div>
<p id="crypto-state"></p>
<div id="crypto-on" class="stack" hidden>
<div class="field"><span class="label">鍵</span>${keyBox("crypto-key", actions(button("表示", { small: true, attrs: { id: "crypto-reveal", "aria-pressed": "false" } }), button("コピー", { small: true, attrs: { id: "crypto-copy" } })))}</div>
${hint(KEY_HELP)}
<p id="crypto-copied" class="hint" role="status"></p>
${actions(button("暗号化の確認を送る", { variant: "primary", attrs: { id: "crypto-confirm" } }), button("状態を読み直す", { variant: "quiet", attrs: { id: "crypto-reload", hidden: true } }))}
<output id="crypto-status" class="hint"></output>
<details class="danger-zone"><summary>鍵を作り直す・無効にする</summary><div class="stack">
${hint("作り直すと、Bark に新しい鍵を貼り直すまでこの端末は通知を読めない。無効にすると以後の通知は暗号化せずに送る")}
${actions(button("鍵を作り直す", { attrs: { id: "crypto-renew" } }), button("暗号化を無効にする", { variant: "quiet-danger", attrs: { id: "crypto-disable" } }))}
</div></details>
</div>
<div id="crypto-off" class="stack" hidden>
${hint("鍵を作って保存し、クリップボードへ写す。Bark に貼ったら「暗号化の確認を送る」で確かめる")}
${actions(button("暗号化キーを設定", { variant: "primary", attrs: { id: "crypto-enable" } }))}
</div>`,
})}
${dialog({
  id: "migrate-dialog",
  title: "新しいサーバー名で登録し直す",
  body: html`<p id="migrate-text"></p>
${hint("この端末に案内の通知を送る。端末でタップすると移行の手順が開き、タグと暗号化キーはそのまま引き継ぐ")}
${actions(button("案内の通知を送る", { variant: "primary", attrs: { id: "migrate-send" } }))}
<output id="migrate-status" class="hint"></output>`,
})}
${dialog({
  id: "tags-dialog",
  title: "タグを編集",
  body: html`<form id="tags-form" class="stack">
${field({ id: "tags", label: "タグ", control: textarea("tags", "", { kv: true, rows: 6, attrs: { "aria-describedby": "tags-status" } }), hint: html`1 行に 1 つ ${code("key=value")}。保存すると全部置き換わる。${code("name")} と ${code("owner")} が一覧の見出しになる` })}
<output id="tags-status" class="hint" for="tags"></output>
<div class="sheet-foot">${actions(html`<button type="submit" class="btn btn-primary">タグを保存</button>`)}</div>
</form>`,
})}
${dialog({
  id: "retire-dialog",
  title: "退役",
  body: html`<p id="retire-text"></p>
${actions(button("退役させる", { variant: "danger", attrs: { id: "archive" } }), button("復帰させる", { variant: "primary", attrs: { id: "restore" } }))}`,
})}`;
}

export function devicePageHtml(): string {
  return page({
    title: "端末 - bark-admin",
    script: "device.js",
    body: html`${backBar(`${ADMIN}/`, "端末")}
<main class="detail">
<p id="error" class="error" role="alert" hidden></p>
<div id="hero"></div>
<div id="detail" class="detail-cols" hidden>
<div class="stack">
<div id="alerts" class="stack"></div>
${section("state", "状態", panel(html`<div id="state-rows"></div>`))}
</div>
<div class="stack">
${section("tags", "タグ", panel(html`<div class="panel-body" id="tag-area"></div>`))}
${section("info", "端末情報", html`${panel(html`<div id="info-rows"></div>`)}${hint("Bark アプリが登録するたびに上書きされる観察値。ここでは編集できない", { class: "below" })}`, { aside: "端末が送ってきた値", attrs: { id: "info", hidden: true } })}
<div id="retire-area"></div>
</div>
</div>
</main>
${deviceDialogs()}`,
  });
}

// ---------- 招待・移行 ----------

function chipsOrNothing(tags: Record<string, string>): Html {
  return Object.keys(tags).length === 0 ? html`` : tagChips(tags);
}

// 1. サーバーを追加。ボタンは登録を見つけるまで押せる。Bark が開かなかった時だけ App Store への案内を出す
function addStep(addserverUrl: string, tags: Record<string, string>, label: string, note: string): Html {
  return step({
    id: "add",
    n: 1,
    title: label,
    mode: "current",
    body: html`<button type="button" id="add-server" class="btn btn-primary btn-block" data-href="${addserverUrl}">${label}</button>
<p id="no-bark" class="hint" hidden>Bark が開かなかった。入っていなければ <a href="${APP_STORE_URL}">App Store から入れて</a>からもう一度押す</p>
${hint(note)}
${chipsOrNothing(tags)}`,
  });
}

// 2. 受信確認。登録できたら src/client/add.ts が平文の確認通知を 1 回送る。届かない・消した時は再送する
function deliveryStep(): Html {
  return step({
    id: "delivery",
    n: 2,
    title: "受信確認の通知をタップ",
    mode: "later",
    body: html`<div class="waiting" id="delivery-waiting"><span class="pulse" aria-hidden="true"></span>通知のタップを待っている</div>
${actions(button("確認通知を再送する", { attrs: { id: "delivery-again" } }))}
<output id="delivery-status" class="hint"></output>`,
  });
}

// 3. 暗号化。鍵はページに埋めず、ボタンを押した時に取ってクリップボードへ写す (写せなかった時だけ見せる)
function cryptoStep(): Html {
  return step({
    id: "crypto",
    n: 3,
    title: "暗号化キーを Bark に入れる",
    mode: "later",
    body: html`${keyBox("crypto-key")}
<button type="button" id="crypto-copy" class="btn btn-primary btn-block">暗号化キーをコピーして Bark を開く</button>
<p id="crypto-status" class="hint" role="status"></p>
<ol class="howto">
<li>Bark のホームで「推送加密 / Push Encryption」を開く</li>
<li>Algorithm を AES256、Mode を GCM、Padding を noPadding にする</li>
<li>Key に鍵を貼って保存する</li>
</ol>
${actions(button("暗号化の確認通知を送る", { attrs: { id: "crypto-confirm" } }))}
<output id="crypto-confirm-status" class="hint"></output>`,
  });
}

function invitePage(o: { title: string; heading: string; lead: Part; token: string; steps: Html[] }): string {
  return page({
    title: o.title,
    script: "add.js",
    body: html`<main class="invite-page">
<header class="invite-head"><span class="app-icon" aria-hidden="true">${icon("bell")}</span><h1>${o.heading}</h1><p>${o.lead}</p></header>
<ol id="flow" class="steps" data-token="${o.token}">
${o.steps}
</ol>
<p id="flow-status" class="flow-status" role="status"></p>
<a id="device-link" class="btn btn-primary btn-block" hidden>この端末の設定を開く</a>
</main>`,
  });
}

export function addPageHtml(p: { addserverUrl: string; token: string; tags: Record<string, string>; encrypted: boolean }): string {
  const tagged = Object.keys(p.tags).length > 0;
  const note = `押すと Bark が開き、このサーバーを追加する。この端末は${tagged ? "次のタグで" : "タグなしで"}登録される。このページを開いた 1 台用で、24 時間まで使える。`;
  return invitePage({
    title: "この端末を登録 - bark-admin",
    heading: "この端末を登録",
    lead: `Bark アプリに通知サーバーを追加する。${p.encrypted ? 3 : 2} つの手順で終わる。`,
    token: p.token,
    steps: [addStep(p.addserverUrl, p.tags, "Bark にサーバーを追加", note), deliveryStep(), ...(p.encrypted ? [cryptoStep()] : [])],
  });
}

// 移行の案内ページ (/bark-admin/add/m/:token)。段は招待ページの 1 段目 (見出しを「新しいサーバー名で追加」に) と 2 段目 (受信確認) だけ。
// 鍵は旧端末から引き継ぎ、Bark の暗号化設定はアプリに 1 つなので貼り直さない
export function migratePageHtml(p: { addserverUrl: string; token: string; tags: Record<string, string>; oldHost: string | undefined; newHost: string }): string {
  const tagged = Object.keys(p.tags).length > 0;
  const note = `押すと Bark が開き、新しいサーバー名 ${p.newHost} を追加する。この端末は${tagged ? "今と同じ次のタグで" : "タグなしで"}登録され、暗号化キーもそのまま引き継ぐ。この端末用で、発行から 24 時間まで使える。`;
  const old = p.oldHost ?? "古いサーバー名";
  return invitePage({
    title: "新しいサーバー名で追加 - bark-admin",
    heading: "新しいサーバー名で登録し直す",
    lead: `サーバー名が ${p.newHost} に変わった。新しいサーバー名で登録し直し、済んだら Bark のサーバーリストから ${old} を削除してよい。`,
    token: p.token,
    steps: [addStep(p.addserverUrl, p.tags, "新しいサーバー名で追加", note), deliveryStep()],
  });
}

// ---------- 確認できた・見つからない ----------

// 行き止まりにしないよう TOP へのリンクを置く
export function notFoundPageHtml(message: string, heading = "招待が見つからない"): string {
  return page({
    title: "見つからない - bark-admin",
    body: html`<main class="invite-page">
<header class="invite-head"><span class="app-icon muted" aria-hidden="true">${icon("bell")}</span><h1>${heading}</h1><p>${message}</p></header>
${linkButton("bark-admin の TOP を開く", `${ADMIN}/`, { block: true })}
</main>`,
  });
}

type ConfirmedDevice = {
  registered_at: string;
  tags: Record<string, string>;
  delivery?: { confirmed_at: string | null } | undefined;
  crypto: { confirmed_at: string | null } | null;
  info?: { device_kind?: string | undefined; os_version?: string | undefined; ts_machine?: string | undefined } | undefined;
};

// 確認通知をタップして開かれるページ (crypto は復号できた端末だけが URL を知る)。詳細ページの要約を 1 画面で見せる。
// 節は「端末」(登録簿の固有フィールド) / 「タグ」/ 「端末情報」(観察値) に分け、今回確認した行を強調する。
// Bark のサーバーリストに同じ address が並んでも、その key (= device_id) と見比べて登録簿上のどの端末かが分かるよう、device_id を全文で出す
export function confirmedPageHtml(p: { kind: "delivery" | "crypto"; deviceId: string; device: ConfirmedDevice }): string {
  const d = p.device;
  const what = p.kind === "delivery" ? { title: "受信を確認できた", line: "この端末に通知が届いている。" } : { title: "暗号化を確認できた", line: "この端末は通知を復号できている。" };
  const fields: Row[] = [
    { label: "device_id", value: code(p.deviceId), mono: true },
    { label: "登録日時", value: time(d.registered_at) },
    { label: "受信確認", value: deliveryValue({ delivery: { confirmed_at: d.delivery?.confirmed_at ?? null } }), changed: p.kind === "delivery" },
    { label: "暗号化", value: cryptoValue(d.crypto), changed: p.kind === "crypto" },
  ];
  // 端末の見分けに効く 3 つ (種類・OS の版・Tailscale のマシン名)。ts_hostname は iPadOS が localhost を返すので出さない
  const info = (["device_kind", "os_version", "ts_machine"] as const).flatMap((k): Row[] => {
    const val = d.info?.[k];
    return val === undefined ? [] : [{ label: k, value: val, mono: true }];
  });
  return page({
    title: `${what.title} - bark-admin`,
    body: html`<main class="invite-page">
<header class="invite-head"><span class="app-icon ok" aria-hidden="true">${icon("check")}</span><h1>${what.title}</h1><p>${what.line}Bark のサーバー一覧で、この device_id と同じ key のサーバーがこの端末の登録。</p></header>
${section("fields", "端末", html`${panel(rows(fields))}${hint("登録簿が端末ごとに持つ固有の項目。bark-admin が登録と確認のたびに書く", { class: "below" })}`)}
${section("tags", "タグ", panel(html`<div class="panel-body">${tagChips(d.tags)}${hint(html`宛先の指定に使う ${code("key=value")}。登録簿に保存、自由に直せる`)}</div>`))}
${info.length === 0 ? "" : section("info", "端末情報", html`${panel(rows(info, "observed"))}${hint("Bark アプリが登録するたびに上書きされる観察値。編集はできない", { class: "below" })}`)}
${linkButton("この端末の設定を開く", deviceHref(p.deviceId), { variant: "primary", block: true })}
</main>`,
  });
}
