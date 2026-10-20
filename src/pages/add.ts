import { assetUrl } from "../assets.ts";

// /bark-admin/add/:invite の案内ページと、確認通知から開かれるページ。QR から iPhone の Safari で開かれ、Bark アプリにサーバ (登録トークン入り URL) を追加させる。
// 案内ページは 3 段のステップ (1. サーバーを追加 → 2. 受信確認 → 3. 暗号化 (鍵付きの招待だけ)) を縦に並べる (見た目の判断は docs/design/ui.md)。
// 動きは public/assets/add.js: 段の進み具合は GET /bark-admin/api/registrations/:token で読む。

export const APP_STORE_URL = "https://apps.apple.com/app/bark-custom-notifications/id1403753865";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, main: string, script = ""): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="${assetUrl("style.css")}">
${script === "" ? "" : `<script type="module" src="${assetUrl(script)}"></script>\n`}</head>
<body>
<main class="invite">
${main}
</main>
</body>
</html>
`;
}

// 段の見出しと、済んだ時に出す 1 行 (add.js が書く)。段の中身は今の段の時だけ見える。
// 中身の先頭の .message には、今の段の案内を add.js が状態に合わせて書く (public/assets/add-state.js の MESSAGES)
// 最初は 1 段目が今の段、残りは先の段
function step(id: string, n: number, title: string, body: string): string {
  return `<li id="step-${id}" class="step ${n === 1 ? "current" : "later"}">
<h2><span class="mark" aria-hidden="true">${n}</span>${esc(title)}</h2>
<p class="done-line" hidden></p>
<div class="body stack"${n === 1 ? "" : " hidden"}>
<p class="message" role="status"></p>
${body}
</div>
</li>`;
}

// 1. サーバーを追加。ボタンは登録を見つけるまで押せる。Bark が開かなかった時だけ App Store への案内を出す
function addStep(addserverUrl: string, tags: string): string {
  return step(
    "add",
    1,
    "Bark にサーバーを追加",
    `<button type="button" id="add-server" class="open" data-href="${esc(addserverUrl)}">Bark にサーバーを追加</button>
<p id="no-bark" class="hint" hidden>Bark が開かなかった。入っていなければ <a href="${esc(APP_STORE_URL)}">App Store から入れて</a>からもう一度</p>
<p>押すと Bark が開き、このサーバーを追加する。この端末は${tags === "" ? "タグなしで" : "次のタグで"}登録される。このページを開いた 1 台用で、24 時間まで使える。</p>
${tags === "" ? "" : `<ul class="tags">${tags}</ul>`}`,
  );
}

// 2. 受信確認。登録できたら add.js が平文の確認通知を 1 回送る。届かない・消した時は再送する
function deliveryStep(): string {
  return step(
    "delivery",
    2,
    "受信確認",
    `<div class="actions"><button type="button" id="delivery-again" class="secondary">確認通知を再送する</button><output id="delivery-status" class="hint"></output></div>`,
  );
}

// 3. 暗号化。鍵はページに埋めず、ボタンを押した時に取ってクリップボードへ写す (写せなかった時だけ見せる)
function cryptoStep(): string {
  return step(
    "crypto",
    3,
    "暗号化",
    `<div class="key-row"><code id="crypto-key" class="key masked" aria-label="暗号化キー (隠している)">••••••••</code></div>
<button type="button" id="crypto-copy">暗号化キーをコピーして Bark を開く</button>
<p id="crypto-status" class="hint" role="status"></p>
<ol class="steps">
<li>Bark のホームで「推送加密 / Push Encryption」を開く</li>
<li>Algorithm を AES256、Mode を GCM、Padding を noPadding にする</li>
<li>Key に鍵を貼って保存する</li>
</ol>
<div class="actions"><button type="button" id="crypto-confirm" class="secondary">暗号化の確認通知を送る</button><output id="crypto-confirm-status" class="hint"></output></div>`,
  );
}

export function addPageHtml(p: { addserverUrl: string; token: string; tags: Record<string, string>; encrypted: boolean }): string {
  const tags = Object.entries(p.tags)
    .map(([k, val]) => `<li class="tag">${esc(k)}=${esc(val)}</li>`)
    .join("");
  return page(
    "bark-admin: Bark にサーバーを追加",
    `<h1>Bark にこのサーバーを追加</h1>
<ol id="flow" class="flow" data-token="${esc(p.token)}">
${addStep(p.addserverUrl, tags)}
${deliveryStep()}
${p.encrypted ? `${cryptoStep()}\n` : ""}</ol>
<p id="flow-status" class="flow-status" role="status"></p>
<a id="device-link" class="button open" hidden>この端末の設定を開く</a>`,
    "add.js",
  );
}

// 行き止まりにしないよう TOP へのリンクを置く
export function notFoundPageHtml(message: string, heading = "招待が見つからない"): string {
  return page("bark-admin: 見つからない", `<h1>${esc(heading)}</h1>\n<p>${esc(message)}</p>\n<a class="button secondary" href="/bark-admin/">bark-admin の TOP を開く</a>`);
}

function time(iso: string): string {
  return `<time datetime="${esc(iso)}">${esc(iso.slice(0, 16).replace("T", " "))}</time>`;
}

// 受信確認・暗号化の状態の 1 行 (詳細ページの public/assets/device.js と同じ言い回し)
function deliveryState(d: { confirmed_at: string | null } | undefined): string {
  return d === undefined || d.confirmed_at === null ? "未確認" : `確認済み ${time(d.confirmed_at)}`;
}

function cryptoState(c: { confirmed_at: string | null } | null): string {
  if (c === null) return "無効";
  return c.confirmed_at === null ? "有効・未確認" : `有効・確認済み ${time(c.confirmed_at)}`;
}

type ConfirmedDevice = {
  registered_at: string;
  tags: Record<string, string>;
  delivery?: { confirmed_at: string | null } | undefined;
  crypto: { confirmed_at: string | null } | null;
  info?: { device_kind?: string | undefined; os_version?: string | undefined; ts_machine?: string | undefined } | undefined;
};

// 確認通知をタップして開かれるページ (crypto は復号できた端末だけが URL を知る)。詳細ページの要約を 1 画面で見せる。
// 節は詳細ページと同じ「端末」(登録簿の固有フィールド) / 「タグ」(編集できる k=v) / 「端末情報」(観察値) に分け、今回確認した行を強調する。
// Bark のサーバーリストに同じ address が並んでも、その key (= device_id) と見比べて登録簿上のどの端末かが分かるよう、device_id を全文で出す
export function confirmedPageHtml(p: { kind: "delivery" | "crypto"; deviceId: string; device: ConfirmedDevice }): string {
  const d = p.device;
  const what = p.kind === "delivery" ? { title: "受信を確認できた", line: "この端末に通知が届いている。" } : { title: "暗号化を確認できた", line: "この端末は通知を復号できている。" };
  const row = (label: string, value: string, changed = false) => `<dt${changed ? ' class="changed"' : ""}>${label}</dt><dd${changed ? ' class="changed"' : ""}>${value}</dd>`;
  const fields = [
    row("device_id", `<code>${esc(p.deviceId)}</code>`),
    row("registered_at", time(d.registered_at)),
    row("受信確認", deliveryState(d.delivery), p.kind === "delivery"),
    row("暗号化", cryptoState(d.crypto), p.kind === "crypto"),
  ].join("");
  const tags = Object.entries(d.tags);
  // 端末の見分けに効く 3 つ (種類・OS の版・Tailscale のマシン名)。ts_hostname は iPadOS が localhost を返すので出さない
  const info = (["device_kind", "os_version", "ts_machine"] as const)
    .flatMap((k) => {
      const val = d.info?.[k];
      return val === undefined ? [] : [row(k, esc(val))];
    })
    .join("");
  return page(
    `bark-admin: ${what.title}`,
    `<h1>${what.title}</h1>
<p>${what.line}Bark のサーバー一覧で、この device_id と同じ key のサーバーがこの端末の登録。</p>
<section class="stack" aria-labelledby="fields-heading">
<h2 id="fields-heading">端末</h2>
<p class="hint">登録簿が端末ごとに持つ固有の項目。bark-admin が登録と確認のたびに書く</p>
<dl class="facts">${fields}</dl>
</section>
<section class="stack" aria-labelledby="tags-heading">
<h2 id="tags-heading">タグ</h2>
<p class="hint">宛先の指定に使う <code>key=value</code>。登録簿に保存、自由に直せる</p>
${tags.length === 0 ? `<p class="hint">タグなし</p>` : `<ul class="tags">${tags.map(([k, val]) => `<li class="tag">${esc(k)}=${esc(val)}</li>`).join("")}</ul>`}
</section>
${
  info === ""
    ? ""
    : `<section class="stack" aria-labelledby="info-heading">
<h2 id="info-heading">端末情報</h2>
<p class="hint">登録簿に保存されている観察値 (<code>device.info</code>)。Bark アプリが登録するたびに上書きされる。編集はできない</p>
<dl class="facts">${info}</dl>
</section>
`
}<a class="button open" href="/bark-admin/devices/${encodeURIComponent(p.deviceId)}">この端末の設定を開く</a>`,
  );
}
