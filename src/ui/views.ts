import {
  actions,
  alert,
  button,
  chip,
  chips,
  code,
  glyph,
  hint,
  icon,
  linkButton,
  opener,
  rows,
  statuses,
  tagChips,
  time,
  type Row,
} from "./components.ts";
import { CRYPTO_LABELS, deviceStatuses, glyphKind, hostState, type NameOf, type StatusSource } from "./device-status.ts";
import { html, type Html } from "./html.ts";

// 部品を組んだ画面の塊 (端末の行・詳細の中身・招待の行)。一覧と詳細はブラウザが API の値で描き直し、確認できたページはサーバが同じ塊で組む

export const ADMIN = "/bark-admin";

// 通知を送るダイアログでいつも見せる項目。残りは「その他の項目」に畳む
export const PRIMARY_FIELDS: ReadonlySet<string> = new Set(["title", "body", "level", "sound"]);

export function deviceHref(id: string): string {
  return `${ADMIN}/devices/${encodeURIComponent(id)}`;
}

type Confirmed = { confirmed_at: string | null };

// 一覧の 1 行に要る項目 (GET /api/devices の行)
export type DeviceRowData = StatusSource & {
  device_id: string;
  registered_at: string;
  tags: Record<string, string>;
  info: { server_host?: string | undefined; os_version?: string | undefined; ts_hostname?: string | undefined };
};

// 宛先のパターンにタグが当たっているか / 宛先にその k=v そのものがあるか
export type TagMatch = { hits: (k: string, v: string) => boolean; pressed: (k: string, v: string) => boolean };

function tagButton(k: string, v: string, m: TagMatch): Html {
  const pressed = m.pressed(k, v);
  return chip(k, v, { pressed, hit: m.hits(k, v), title: pressed ? `宛先から ${k}=${v} を外す` : `宛先に ${k}=${v} を足す` });
}

// 一覧で見出しの下に並べるチップの数 (name / owner は別の場所に出す)。残りは +n にまとめる
const SHOWN_TAGS = 4;

// 端末の 1 行。名前のリンクが行全体を覆い、タグのチップは宛先の付け外しのボタンとしてその上に乗る
export function deviceRow(d: DeviceRowData, currentHost: string, m: TagMatch, nameOf?: NameOf): Html {
  const { owner, name, ...rest } = d.tags;
  const archived = d.archived_at !== null;
  // 宛先に当たったタグを先に並べ、+n に畳まれて見えなくならないようにする
  const others = Object.entries(rest).toSorted(([a, av], [b, bv]) => Number(m.hits(b, bv)) - Number(m.hits(a, av)));
  const hidden = others.slice(SHOWN_TAGS);
  return html`<li class="device${archived ? " archived" : ""}">
${glyph(glyphKind(d.tags, d.info), { target: !archived })}
<div class="device-head"><a class="name${name === undefined ? " unnamed" : ""}" href="${deviceHref(d.device_id)}">${name ?? "名前なし"}</a>${owner === undefined ? "" : html`<span class="owner">owner ${tagButton("owner", owner, m)}</span>`}</div>
<ul class="chips">${others.slice(0, SHOWN_TAGS).map(([k, v]) => html`<li>${tagButton(k, v, m)}</li>`)}${hidden.length > 0 ? html`<li class="more" title="${hidden.map(([k, v]) => `${k}=${v}`).join("\n")}">+${hidden.length}</li>` : ""}</ul>
<p class="meta">${code(d.device_id, "id")}${time(d.registered_at)}${d.info.os_version === undefined ? "" : html`<span>${d.info.os_version}</span>`}</p>
${statuses(deviceStatuses(d, currentHost, nameOf))}
${icon("chev", "i chev")}
</li>`;
}

// ---------- 詳細 ----------

export type DeviceDetailData = DeviceRowData & {
  crypto: (Confirmed & { key: string }) | null;
  migrated_from: string | null;
  info: Record<string, string | undefined>;
};

// 端末情報の並び (DESIGN.md のデータ節の順)。無い項目は出さない。server_host は状態の行に出す
export const INFO_KEYS = [
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
] as const;

export function deviceHero(d: DeviceDetailData, currentHost: string, nameOf?: NameOf): Html {
  const { name, owner } = d.tags;
  return html`<div class="hero">${glyph(glyphKind(d.tags, d.info), { large: true })}<div class="hero-text"><h1 class="${name === undefined ? "unnamed" : ""}">${name ?? "名前なし"}</h1><p class="owner">${owner === undefined ? "owner なし" : html`owner <b>${owner}</b>`}</p>${statuses(deviceStatuses(d, currentHost, nameOf))}</div></div>`;
}

// アーカイブ済みの端末のページ上部の帯。使われていない端末だと最初に分かるようにし、操作は「アーカイブから戻す」だけ (移行済みなら移行先へのリンクだけ)
export function deviceArchivedBand(d: DeviceDetailData, currentHost: string, nameOf?: NameOf): Html {
  if (d.archived_at === null) return html``;
  const host = hostState(d, currentHost);
  if (host.kind === "migrated") {
    const to = nameOf?.(host.to) ?? host.to;
    return alert(
      "archived",
      html`<b>この端末はアーカイブ済み。通知の宛先に含まれない。</b>新しいサーバー名の端末 <a href="${deviceHref(host.to)}">${to}</a> へ移行した (${time(d.archived_at)} にアーカイブ)。`,
      actions(linkButton(`移行先の ${to} を開く`, deviceHref(host.to), { variant: "primary" })),
    );
  }
  return alert("archived", html`<b>この端末はアーカイブ済み。通知の宛先に含まれない。</b>${time(d.archived_at)} にアーカイブした。`, actions(opener("アーカイブから戻す", "archive-dialog", { variant: "primary" })));
}

// 使われている端末の知らせ (移行して自動アーカイブ待ち・サーバー名が古い)。操作はダイアログを開くボタンだけ
export function deviceAlerts(d: DeviceDetailData, currentHost: string, nameOf?: NameOf): Html {
  const out: Html[] = [];
  if (d.archived_at !== null) return html``;
  const host = hostState(d, currentHost);
  if (host.kind === "migrated") {
    const to = nameOf?.(host.to) ?? host.to;
    out.push(alert("moved", html`<b>新しいサーバー名の端末 ${to} へ移行した。</b>移行先の受信確認が済むと自動でアーカイブする。`, actions(linkButton(`移行先の ${to} を開く`, deviceHref(host.to), { variant: "primary" }))));
  }
  if (host.kind === "stale") {
    out.push(
      alert(
        "warn",
        html`<b>古いサーバー名で登録されている。</b>${host.host} はいずれ使えなくなる。案内の通知を送り、端末でタップすると新しいサーバー名 ${currentHost} で登録し直せる。`,
        actions(opener("新しいサーバー名で登録し直す", "migrate-dialog", { variant: "primary" })),
      ),
    );
  }
  return html`${out}`;
}

function hostValue(d: DeviceDetailData, currentHost: string, nameOf: NameOf | undefined): Html {
  const host = hostState(d, currentHost);
  switch (host.kind) {
    case "migrated": {
      const name = nameOf?.(host.to);
      return html`移行済み → <a href="${deviceHref(host.to)}">${name ?? code(host.to)}</a>`;
    }
    case "unknown":
      return html`不明`;
    case "current":
      return html`${host.host}`;
    case "stale":
      return html`<span class="old">${host.host}</span>`;
  }
}

export function deliveryValue(d: { delivery: Confirmed }): Html {
  return d.delivery.confirmed_at === null ? html`<span class="st st-info">未確認</span>` : html`<span class="st st-ok">確認済み ${time(d.delivery.confirmed_at)}</span>`;
}

export function cryptoValue(c: Confirmed | null): Html {
  if (c === null) return html`<span class="st st-muted">${CRYPTO_LABELS.off}</span>`;
  if (c.confirmed_at === null) return html`<span class="st st-info">${CRYPTO_LABELS.unconfirmed}</span>`;
  return html`<span class="st st-ok">${CRYPTO_LABELS.confirmed} ${time(c.confirmed_at)}</span>`;
}

// 状態の行。各行の右の小さなボタンがその操作のダイアログを開く (アーカイブ済みの端末には操作を出さない)
export function deviceStateRows(d: DeviceDetailData, currentHost: string, nameOf?: NameOf): Html {
  const active = d.archived_at === null;
  const act = (label: string, id: string) => (active ? opener(label, id, { small: true }) : undefined);
  const host = hostState(d, currentHost);
  const items: Row[] = [
    { label: "device_id", value: code(d.device_id), mono: true },
    { label: "登録日時", value: time(d.registered_at) },
    { label: "受信確認", value: deliveryValue(d), action: act("確認を送る", "delivery-dialog") },
    { label: "暗号化", value: cryptoValue(d.crypto), action: act(d.crypto === null ? "設定する" : "鍵と確認", "crypto-dialog") },
    {
      label: "サーバー名",
      value: hostValue(d, currentHost, nameOf),
      mono: host.kind === "current" || host.kind === "stale",
      ...(host.kind === "stale" ? { note: `今のサーバー名は ${currentHost}`, action: act("登録し直す", "migrate-dialog") } : {}),
    },
    ...(d.migrated_from === null ? [] : [{ label: "移行元", value: html`<a href="${deviceHref(d.migrated_from)}">${code(d.migrated_from)}</a>` }]),
  ];
  return rows(items);
}

export function deviceInfoRows(info: Record<string, string | undefined>): Html | null {
  const items = INFO_KEYS.flatMap((k): Row[] => {
    const val = info[k];
    if (val === undefined) return [];
    return [{ label: k, value: k === "last_register_at" ? time(val) : val, mono: true }];
  });
  return items.length === 0 ? null : rows(items, "observed");
}

export function deviceTags(d: { tags: Record<string, string>; archived_at: string | null }): Html {
  return html`${tagChips(d.tags)}${d.archived_at === null ? actions(opener("タグを編集", "tags-dialog", { small: true })) : ""}`;
}

// ---------- 招待 ----------

export type InviteData = { invite: string; add_url: string; tags: Record<string, string>; encrypt: boolean; created_at: string; registered: number };

export function inviteQrUrl(invite: string): string {
  return `${ADMIN}/api/invites/${encodeURIComponent(invite)}/qr.svg`;
}

export function inviteItem(inv: InviteData): Html {
  const tags = Object.entries(inv.tags);
  return html`<li class="invite" data-invite="${inv.invite}">
<button type="button" class="qr-thumb" data-action="show-qr" aria-label="招待の QR を大きく表示"><img src="${inviteQrUrl(inv.invite)}" alt="" width="88" height="88" loading="lazy"></button>
<div class="invite-body">
${chips(
  tags.map(([k, v]) => chip(k, v)),
  "タグなし",
)}
<p class="statuses">${inv.encrypt ? html`<span class="st st-ok">暗号化あり</span>` : html`<span class="st st-muted">暗号化なし</span>`}<span class="st ${inv.registered > 0 ? "st-ok" : "st-muted"}">${inv.registered > 0 ? `${inv.registered} 台登録` : "未登録"}</span></p>
${hint(html`${time(inv.created_at)} に作成`)}
${actions(button("QR を表示", { small: true, attrs: { "data-action": "show-qr" } }), button("URL をコピー", { small: true, attrs: { "data-action": "copy-url" } }), button("削除", { small: true, variant: "quiet-danger", attrs: { "data-action": "delete" } }))}
</div>
</li>`;
}
