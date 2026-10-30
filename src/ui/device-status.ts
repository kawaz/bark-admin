// 端末の状態の読み方 (純粋関数)。一覧の状態ラベル、詳細の状態の行、確認できたページが同じ言い回しになるよう 1 か所に置く

// ok / warn / moved / archived は「その状態にある」(塗りの点)、info は「まだ」(中抜きの点)
export type Tone = "ok" | "info" | "warn" | "moved" | "archived";
export type Status = { tone: Tone; text: string };

type Confirmed = { confirmed_at: string | null };

// 状態を決めるのに要る項目 (一覧の行 DeviceListItem と詳細の DeviceView の共通部分)
export type StatusSource = {
  archived_at: string | null;
  crypto: Confirmed | null;
  delivery: Confirmed;
  migrated_to: string | null;
  info: { server_host?: string | undefined };
};

export type CryptoLevel = "off" | "unconfirmed" | "confirmed";

export function cryptoLevel(c: Confirmed | null): CryptoLevel {
  if (c === null) return "off";
  return c.confirmed_at === null ? "unconfirmed" : "confirmed";
}

export const CRYPTO_LABELS: Record<CryptoLevel, string> = { off: "無効", unconfirmed: "有効・未確認", confirmed: "有効・確認済み" };

// 登録に使ったサーバー名の読み方。Bark アプリはサーバ追加時の address に登録し続けるので、今の公開名と違えば古い。
// 移行済みなら移行先を示す (古さより優先)
export type HostState = { kind: "migrated"; to: string } | { kind: "unknown" } | { kind: "current"; host: string } | { kind: "stale"; host: string };

export function hostState(d: Pick<StatusSource, "migrated_to" | "info">, currentHost: string): HostState {
  if (d.migrated_to !== null) return { kind: "migrated", to: d.migrated_to };
  const host = d.info.server_host;
  if (host === undefined) return { kind: "unknown" };
  return host === currentHost ? { kind: "current", host } : { kind: "stale", host };
}

// device_id → 端末の名前 (name タグ)。分からなければ undefined (device_id をそのまま出す)
export type NameOf = (id: string) => string | undefined;

const noNames: NameOf = () => undefined;

// 一覧と詳細の見出しに並べる状態ラベル。並びは 受信確認 → 暗号化 → サーバー名 (移行) → アーカイブ。
// 何も言うことが無い項目 (暗号化なし、今のサーバー名、サーバー名が不明) はラベルにしない。移行済みは行き先の端末名を添える
export function deviceStatuses(d: StatusSource, currentHost: string, nameOf: NameOf = noNames): Status[] {
  const out: Status[] = [];
  const archived = d.archived_at !== null;
  if (!archived && d.delivery.confirmed_at === null) out.push({ tone: "info", text: "受信未確認" });
  const level = cryptoLevel(d.crypto);
  if (level === "confirmed") out.push({ tone: "ok", text: "暗号化 確認済み" });
  if (level === "unconfirmed") out.push({ tone: "info", text: "暗号化 未確認" });
  const host = hostState(d, currentHost);
  if (host.kind === "migrated") out.push({ tone: "moved", text: `移行済み → ${nameOf(host.to) ?? host.to}` });
  if (host.kind === "stale" && !archived) out.push({ tone: "warn", text: "サーバー名が古い" });
  if (archived) out.push({ tone: "archived", text: "アーカイブ済み" });
  return out;
}

export type GlyphKind = "phone" | "tablet" | "laptop" | "bell";

// 端末の形の絵。招待ページで判定した種類 (詳細だけが持つ) → os タグ → UA の OS 名の順に見る
export function glyphKind(tags: Record<string, string>, info: { device_kind?: string | undefined; os_version?: string | undefined }): GlyphKind {
  const kind = info.device_kind;
  if (kind === "iphone" || kind === "android") return "phone";
  if (kind === "ipad") return "tablet";
  if (kind === "mac") return "laptop";
  const os = tags["os"] ?? info.os_version?.split(" ")[0]?.toLowerCase();
  if (os === "ios" || os === "android") return "phone";
  if (os === "ipados") return "tablet";
  if (os === "macos") return "laptop";
  return "bell";
}

// "2026-10-20T10:02:28+09:00" → "2026-10-20 10:02"。登録簿はローカル時刻で持つので、そのまま切り詰める
export function formatAt(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}
