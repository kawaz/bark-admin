import { CRYPTO_LABELS, formatAt, type CryptoLevel, type GlyphKind, type Status } from "./device-status.ts";
import { attrs, html, Html, type Attrs, type Part } from "./html.ts";

// 画面の部品。サーバのページ (src/ui/pages.ts) とブラウザの描き直し (src/client/) の両方がここだけを使う。
// 見た目は src/ui/style.css (色・字・角丸のトークンは :root の 1 か所)。判断は docs/design/ui.md

// ---------- 絵 ----------

const ICONS = {
  chev: `<path d="M9 5.5l6.5 6.5L9 18.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  back: `<path d="M15 5.5L8.5 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  plus: `<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`,
  close: `<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`,
  check: `<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  ok: `<circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7.5 12.3l3 3 6-6.3" fill="none" style="stroke: var(--bg)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
  ng: `<circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 7v6.2" style="stroke: var(--bg)" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="16.8" r="1.4" style="fill: var(--bg)"/>`,
  bell: `<path d="M12 3.2c-3.3 0-5.6 2.5-5.6 5.8v3.6L4.6 15.8c-.4.7.1 1.5.9 1.5h13c.8 0 1.3-.8.9-1.5l-1.8-3.2V9c0-3.3-2.3-5.8-5.6-5.8z" fill="currentColor"/><path d="M9.6 19.2a2.5 2.5 0 004.8 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
  send: `<path d="M4 11.5L20 4l-5.5 16-3-6.5L4 11.5z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M11.5 13.5L20 4" fill="none" stroke="currentColor" stroke-width="1.9"/>`,
  phone: `<rect x="7" y="2.5" width="10" height="19" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.6 5.2h2.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,
  tablet: `<rect x="4.5" y="2.5" width="15" height="19" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="18.6" r="0.9" fill="currentColor"/>`,
  laptop: `<rect x="4.5" y="5" width="15" height="10.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M2.5 18.8h19" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, className = "i"): Html {
  return new Html(`<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`);
}

// 端末の形の絵。target は「送信先に入る」の黄色い印
export function glyph(kind: GlyphKind, opts: { target?: boolean; large?: boolean } = {}): Html {
  return html`<span class="glyph${opts.large === true ? " glyph-lg" : ""}" aria-hidden="true">${icon(kind)}${opts.target === true ? html`<span class="target">${icon("check")}</span>` : ""}</span>`;
}

// ---------- 文字の小物 ----------

export function time(iso: string): Html {
  return html`<time datetime="${iso}" title="${iso}">${formatAt(iso)}</time>`;
}

export function code(text: string, className?: string): Html {
  return html`<code${attrs({ class: className })}>${text}</code>`;
}

export function hint(body: Part, a: Attrs = {}): Html {
  return html`<p class="hint"${attrs(a)}>${body}</p>`;
}

// ---------- ボタン ----------

export type ButtonVariant = "primary" | "plain" | "quiet" | "danger" | "quiet-danger";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "btn btn-primary",
  plain: "btn",
  quiet: "btn btn-quiet",
  danger: "btn btn-danger",
  "quiet-danger": "btn btn-quiet is-danger",
};

// className は部品の class に足す (画面ごとの置き方の調整)
export type ButtonOpts = { variant?: ButtonVariant; small?: boolean; block?: boolean; icon?: IconName; className?: string; attrs?: Attrs };

function buttonClass(o: ButtonOpts): string {
  return [VARIANT_CLASS[o.variant ?? "plain"], o.small === true ? "btn-small" : "", o.block === true ? "btn-block" : "", o.className ?? ""].filter((c) => c !== "").join(" ");
}

export function button(label: Part, o: ButtonOpts = {}): Html {
  return html`<button${attrs({ type: "button", class: buttonClass(o), ...o.attrs })}>${o.icon === undefined ? "" : icon(o.icon)}${label}</button>`;
}

export function linkButton(label: Part, href: string, o: ButtonOpts = {}): Html {
  return html`<a${attrs({ class: buttonClass(o), href, ...o.attrs })}>${o.icon === undefined ? "" : icon(o.icon)}${label}</a>`;
}

// <dialog> を開くボタン (Invoker Commands)
export function opener(label: Part, dialogId: string, o: ButtonOpts = {}): Html {
  return button(label, { ...o, attrs: { commandfor: dialogId, command: "show-modal", ...o.attrs } });
}

export function actions(...items: Part[]): Html {
  return html`<div class="acts">${items}</div>`;
}

// ---------- タグ・状態 ----------

// k=v のチップ。button を渡すと宛先の付け外しに使うボタンになる (hit は宛先のパターンに当たっている、pressed は宛先にこの k=v そのものがある)
export function chip(k: string, v: string, b?: { pressed: boolean; hit: boolean; title: string }): Html {
  const inner = html`<span class="k">${k}</span><span class="v">${v}</span>`;
  if (b === undefined) return html`<span class="chip">${inner}</span>`;
  return html`<button${attrs({ type: "button", class: b.hit && !b.pressed ? "chip hit" : "chip", "aria-pressed": String(b.pressed), title: b.title, "data-tag-k": k, "data-tag-v": v })}>${inner}</button>`;
}

export function chips(items: readonly Html[], empty: Part = "タグなし"): Html {
  if (items.length === 0) return html`<p class="hint">${empty}</p>`;
  return html`<ul class="chips">${items.map((c) => html`<li>${c}</li>`)}</ul>`;
}

export function tagChips(tags: Record<string, string>): Html {
  return chips(Object.entries(tags).map(([k, v]) => chip(k, v)));
}

export function statusLabel(s: Status): Html {
  return html`<span class="st st-${s.tone}">${s.text}</span>`;
}

export function statuses(list: readonly Status[]): Html {
  return list.length === 0 ? html`` : html`<span class="statuses">${list.map(statusLabel)}</span>`;
}

// 暗号化の 3 段 (無効 / 有効・未確認 / 有効・確認済み) のうち今の段を示す
export function cryptoMeter(level: CryptoLevel): Html {
  const levels: CryptoLevel[] = ["off", "unconfirmed", "confirmed"];
  return html`<ol class="meter" aria-label="暗号化の状態">${levels.map((l) => html`<li${attrs({ "aria-current": l === level ? "true" : undefined, "data-level": l })}>${CRYPTO_LABELS[l]}</li>`)}</ol>`;
}

// ---------- 節・行 ----------

// 見出しの id は `<id>-heading`
export function section(id: string, title: string, body: Part, o: { aside?: Part; attrs?: Attrs } = {}): Html {
  return html`<section${attrs({ "aria-labelledby": `${id}-heading`, ...o.attrs })}><div class="section-head"><h2 id="${id}-heading">${title}</h2>${o.aside === undefined ? "" : html`<span class="aside">${o.aside}</span>`}</div>${body}</section>`;
}

export function panel(body: Part, className = ""): Html {
  return html`<div class="panel${className === "" ? "" : ` ${className}`}">${body}</div>`;
}

// 定義リストの 1 行。value の後ろに小さな操作ボタン (action) を置ける。changed は今回変わった行の強調
export type Row = { label: Part; value: Part; action?: Part; note?: Part; changed?: boolean; mono?: boolean; id?: string };

export function rows(items: readonly Row[], className = ""): Html {
  return html`<dl class="rows${className === "" ? "" : ` ${className}`}">${items.map(
    (r) =>
      html`<div${attrs({ class: r.changed === true ? "row changed" : "row", id: r.id })}><dt>${r.label}</dt><dd><span class="v${r.mono === true ? " mono" : ""}">${r.value}</span>${r.action === undefined ? "" : html`<span class="row-act">${r.action}</span>`}${r.note === undefined ? "" : html`<span class="row-note">${r.note}</span>`}</dd></div>`,
  )}</dl>`;
}

export type AlertTone = "warn" | "info" | "muted";

export function alert(tone: AlertTone, body: Part, acts: Part = "", a: Attrs = {}): Html {
  return html`<div${attrs({ class: `alert alert-${tone}`, role: "status", ...a })}><p>${body}</p>${acts}</div>`;
}

// ---------- フォーム ----------

export function field(o: { id: string; label: Part; param?: string; control: Html; hint?: Part; className?: string }): Html {
  return html`<div class="field${o.className === undefined ? "" : ` ${o.className}`}"><label for="${o.id}">${o.label}${o.param === undefined ? "" : html` <span class="param">${o.param}</span>`}</label>${o.control}${o.hint === undefined ? "" : html`<small class="hint">${o.hint}</small>`}</div>`;
}

export function textarea(id: string, value: string, o: { rows?: number; kv?: boolean; name?: string; attrs?: Attrs } = {}): Html {
  const kv = o.kv === true;
  return html`<textarea${attrs({ id, name: o.name, rows: o.rows ?? 3, class: kv ? "kv" : undefined, spellcheck: kv ? "false" : undefined, autocapitalize: kv ? "off" : undefined, autocomplete: kv ? "off" : undefined, ...o.attrs })}>${value}</textarea>`;
}

export function switchRow(o: { id: string; label: Part; hint?: Part; checked?: boolean; name?: string; value?: string }): Html {
  return html`<label class="switch" for="${o.id}"><span class="switch-text"><b>${o.label}</b>${o.hint === undefined ? "" : html`<small>${o.hint}</small>`}</span><input${attrs({ type: "checkbox", id: o.id, name: o.name, value: o.value, checked: o.checked === true })}><span class="track" aria-hidden="true"></span></label>`;
}

export function segmented(o: { name: string; label: Part; param?: string; options: readonly { value: string; label: string; title?: string }[]; checked: string }): Html {
  return html`<fieldset class="seg-wrap"><legend>${o.label}${o.param === undefined ? "" : html` <span class="param">${o.param}</span>`}</legend><div class="seg">${o.options.map(
    (op, i) =>
      html`<input${attrs({ type: "radio", name: o.name, id: `${o.name}-${i}`, value: op.value, checked: op.value === o.checked })}><label${attrs({ for: `${o.name}-${i}`, title: op.title })}>${op.label}</label>`,
  )}</div></fieldset>`;
}

// ---------- ダイアログ ----------

// 閉じるボタンと見出しを持つ modal。外側のクリックと Esc でも閉じる (closedby="any")
export function dialog(o: { id: string; title: Part; body: Part; wide?: boolean }): Html {
  return html`<dialog id="${o.id}" class="sheet${o.wide === true ? " sheet-wide" : ""}" closedby="any" aria-labelledby="${o.id}-title"><div class="sheet-head"><h2 id="${o.id}-title">${o.title}</h2><button type="button" class="btn btn-quiet icon-only" commandfor="${o.id}" command="close" aria-label="閉じる">${icon("close")}</button></div><div class="sheet-body">${o.body}</div></dialog>`;
}

// ---------- ステップ (招待ページ) ----------

export type StepMode = "done" | "current" | "later";

const STEP_STATE: Record<StepMode, string> = { done: "済み", current: "今ここ", later: "" };

// 段の印 (済みは ✓)・見出し・状態の 1 行・中身。中身は今の段の時だけ見える。
// 済んだ時の 1 行 (.done-line) と今の段の案内 (.message) は src/client/add.ts が状態に合わせて書く
export function step(o: { id: string; n: number; title: string; mode: StepMode; body: Part }): Html {
  return html`<li id="step-${o.id}" class="step ${o.mode}"><span class="num" aria-hidden="true"><span class="n">${o.n}</span>${icon("check", "i tick")}</span><div class="step-head"><h2>${o.title}</h2><p class="state" data-state-text>${STEP_STATE[o.mode]}</p><p class="done-line" hidden></p></div><div class="content"${o.mode === "current" ? "" : " hidden"}><p class="message" role="status"></p>${o.body}</div></li>`;
}

export function stepStateText(mode: StepMode): string {
  return STEP_STATE[mode];
}

// 鍵の表示欄。最初は伏せ字で、値は見せると決めた時にだけ入れる
export function keyBox(id: string, actionsHtml: Part = ""): Html {
  return html`<div class="keybox"><code id="${id}" class="key masked" aria-label="暗号化キー (隠している)">••••••••</code>${actionsHtml}</div>`;
}

// ---------- 画面の枠 ----------

export function appBar(o: { title: Part; sub?: Part; actions?: Part }): Html {
  return html`<header class="appbar"><div class="appbar-row"><div class="appbar-title"><h1>${o.title}</h1>${o.sub === undefined ? "" : html`<p class="sub">${o.sub}</p>`}</div>${o.actions === undefined ? "" : html`<div class="appbar-acts">${o.actions}</div>`}</div></header>`;
}

// 一覧へ戻るリンクだけの見出し (詳細ページ。画面の名前は本文の見出しが持つ)
export function backBar(href: string, label: string): Html {
  return html`<nav class="appbar"><a class="back" href="${href}">${icon("back")}${label}</a></nav>`;
}

// ロック画面に届く通知の見本 (通知テストの上に置く)
export function notificationPreview(title: string, body: string): Html {
  return html`<div class="preview-stage" aria-label="届き方の見本"><div class="banner"><span class="app-icon" aria-hidden="true">${icon("bell")}</span><div class="banner-text"><div class="banner-top"><span>Bark</span><span>今</span></div><p class="banner-title" id="preview-title">${title}</p><p class="banner-body" id="preview-body">${body}</p></div></div></div>`;
}

export function emptyState(text: Part, a: Attrs = {}): Html {
  return html`<p class="empty"${attrs(a)}>${text}</p>`;
}
