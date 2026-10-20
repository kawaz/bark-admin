import type { InviteBrowser, RegistrationRecord, Registrations } from "./schema/registry.ts";
import { localIso } from "./time.ts";

// 招待 (再利用できるテンプレ) と登録トークン (使い切り) の判断 (純粋関数)。永続化は store.ts、HTTP は app.ts。

// 登録トークンの有効期間。招待ページを開いてから Bark で追加し終えるまでの猶予
export const REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000;

export function isExpired(rec: RegistrationRecord, now: Date): boolean {
  return Date.parse(rec.expires_at) <= now.getTime();
}

// 招待ページを開いた 1 回分のトークンを足す。ついでに期限切れで未使用のトークンを捨てる
// (使用済みは残す: 登録した端末のアプリが同じ URL で再登録し続けるので)
export function issueRegistration(
  regs: Registrations,
  token: string,
  r: { invite: string; key: string | null; browser: InviteBrowser; now: Date },
): Registrations {
  const kept = Object.fromEntries(Object.entries(regs).filter(([, rec]) => rec.used_by !== null || !isExpired(rec, r.now)));
  const rec: RegistrationRecord = {
    invite: r.invite,
    crypto: r.key === null ? null : { key: r.key },
    browser: r.browser,
    created_at: localIso(r.now),
    expires_at: localIso(new Date(r.now.getTime() + REGISTRATION_TTL_MS)),
    used_by: null,
    used_at: null,
  };
  return { ...kept, [token]: rec };
}

// /r/<token>/* を通すか。consume は「この登録でトークンを使う」(招待のタグと鍵を写して使用済みにする)
export type TokenGate = { kind: "pass"; consume: boolean } | { kind: "gone"; message: string };

export function gateToken(rec: RegistrationRecord, p: { isRegister: boolean; requestedKey: string; inviteExists: boolean; now: Date }): TokenGate {
  if (rec.used_by !== null) {
    // 使った本人のアプリは起動のたびに同じ URL で再登録してくる。期限や招待の削除に関わらず通す (トークンはもう使わない)
    if (!p.isRegister || p.requestedKey === rec.used_by) return { kind: "pass", consume: false };
    return { kind: "gone", message: "this registration link was already used. Open the invite page again to get a new one" };
  }
  if (isExpired(rec, p.now)) return { kind: "gone", message: "this registration link has expired. Open the invite page again to get a new one" };
  if (!p.inviteExists) return { kind: "gone", message: "the invite of this registration link was deleted. Ask for a new invite" };
  return { kind: "pass", consume: p.isRegister };
}

// 招待ページが見る登録トークンの状態。used が先 (使った後は期限や招待の削除に関わらず used)
export type RegistrationState = "unused" | "used" | "expired" | "invite-deleted";

export function registrationState(rec: RegistrationRecord, p: { inviteExists: boolean; now: Date }): RegistrationState {
  if (rec.used_by !== null) return "used";
  if (isExpired(rec, p.now)) return "expired";
  return p.inviteExists ? "unused" : "invite-deleted";
}
