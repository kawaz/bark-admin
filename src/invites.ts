import type { CarriedCrypto, Invites, RegistrationRecord, Registrations, Tags } from "./schema/registry.ts";
import { localIso } from "./time.ts";

// 招待 (再利用できるテンプレ) と登録トークン (使い切り) の判断 (純粋関数)。永続化は store.ts、HTTP は app.ts。

// 登録トークンの有効期間。招待ページを開いてから Bark で追加し終えるまでの猶予
export const REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000;

export function isExpired(rec: RegistrationRecord, now: Date): boolean {
  return Date.parse(rec.expires_at) <= now.getTime();
}

// 期限切れで未使用のトークンを捨てる (使用済みは残す: 登録した端末のアプリが同じ URL で再登録し続けるので)
function dropExpired(regs: Registrations, now: Date): Registrations {
  return Object.fromEntries(Object.entries(regs).filter(([, rec]) => rec.used_by !== null || !isExpired(rec, now)));
}

function lifetime(now: Date) {
  return { client: null, created_at: localIso(now), expires_at: localIso(new Date(now.getTime() + REGISTRATION_TTL_MS)), used_by: null, used_at: null };
}

// 招待ページを開いた 1 回分のトークンを足す。ついでに期限切れで未使用のトークンを捨てる
export function issueRegistration(
  regs: Registrations,
  token: string,
  r: { invite: string; key: string | null; now: Date },
): Registrations {
  const rec: RegistrationRecord = { invite: r.invite, migrate_from: null, crypto: r.key === null ? null : { key: r.key }, ...lifetime(r.now) };
  return { ...dropExpired(regs, r.now), [token]: rec };
}

// 旧端末 (from) の移行トークンを用意する。期限内で未使用の移行トークンがあればそれを使い回し (タグと鍵は今の旧端末の値に写し直す)、無ければ token で発行する。
// 案内の通知を送り直すたびにトークンが増えないようにするため
export function issueMigration(
  regs: Registrations,
  token: string,
  r: { from: string; tags: Tags; crypto: CarriedCrypto | null; now: Date },
): { regs: Registrations; token: string } {
  const kept = dropExpired(regs, r.now);
  for (const [t, rec] of Object.entries(kept)) {
    if (rec.migrate_from === r.from && rec.used_by === null) return { regs: { ...kept, [t]: { ...rec, tags: r.tags, crypto: r.crypto } }, token: t };
  }
  const rec: RegistrationRecord = { migrate_from: r.from, tags: r.tags, crypto: r.crypto, ...lifetime(r.now) };
  return { regs: { ...kept, [token]: rec }, token };
}

// トークンの発行元がまだあるか。移行トークンはタグと鍵を自分で持ち招待に依らないので、常にある
export function sourceExists(rec: RegistrationRecord, invites: Invites): boolean {
  return rec.migrate_from !== null || invites[rec.invite] !== undefined;
}

// /r/<token>/* を通すか。consume は「この登録でトークンを使う」(招待のタグと鍵を写して使用済みにする)
export type TokenGate = { kind: "pass"; consume: boolean } | { kind: "gone"; message: string };

export function gateToken(rec: RegistrationRecord, p: { isRegister: boolean; requestedKey: string; inviteExists: boolean; now: Date }): TokenGate {
  // 新しいトークンの取り直し方 (移行トークンは管理画面の端末の詳細から送り直す)
  const again = rec.migrate_from === null ? "Open the invite page again to get a new one" : "Send the migration again from the device page of bark-admin";
  if (rec.used_by !== null) {
    // 使った本人のアプリは起動のたびに同じ URL で再登録してくる。期限や招待の削除に関わらず通す (トークンはもう使わない)
    if (!p.isRegister || p.requestedKey === rec.used_by) return { kind: "pass", consume: false };
    return { kind: "gone", message: `this registration link was already used. ${again}` };
  }
  if (isExpired(rec, p.now)) return { kind: "gone", message: `this registration link has expired. ${again}` };
  if (!p.inviteExists) return { kind: "gone", message: "the invite of this registration link was deleted. Ask for a new invite" };
  return { kind: "pass", consume: p.isRegister };
}

// 案内ページが見る登録トークンの状態。used が先 (使った後は期限や招待の削除に関わらず used)。移行トークンは invite-deleted にならない (sourceExists)
export type RegistrationState = "unused" | "used" | "expired" | "invite-deleted";

export function registrationState(rec: RegistrationRecord, p: { inviteExists: boolean; now: Date }): RegistrationState {
  if (rec.used_by !== null) return "used";
  if (isExpired(rec, p.now)) return "expired";
  return p.inviteExists ? "unused" : "invite-deleted";
}
