import type { CryptoKeyOnly, DeviceCrypto, DeviceInfo, DeviceListItem, DeviceRecord, Devices, DeviceView, PatchDevice, Tags } from "./schema/registry.ts";

// 登録簿の操作 (純粋関数)。永続化は store.ts が受け持つ。

// filter の全キーが完全一致する (AND)。空の filter は全件に当たる。
export function matchTags(tags: Tags, filter: Tags): boolean {
  return Object.entries(filter).every(([k, val]) => tags[k] === val);
}

export function view(id: string, { crypto, info, ...rest }: DeviceRecord): DeviceView {
  return { device_id: id, ...rest, crypto: crypto === null ? null : { key: crypto.key, confirmed_at: crypto.confirmed_at }, info: info ?? {} };
}

export function selectDevices(devices: Devices, filter: Tags, includeArchived: boolean): DeviceView[] {
  return Object.entries(devices)
    .filter(([, rec]) => (includeArchived || rec.archived_at === null) && matchTags(rec.tags, filter))
    .map(([id, rec]) => view(id, rec));
}

// 一覧に出す形。鍵そのものは落とし、暗号化の有無と確認状態だけ残す。info は端末名の脇に出す 2 項目だけ
export function listItem({ crypto, info, ...rest }: DeviceView): DeviceListItem {
  return { ...rest, crypto: crypto === null ? null : { confirmed_at: crypto.confirmed_at }, info: { ts_hostname: info.ts_hostname, os_version: info.os_version } };
}

// 新しい鍵 (作り直し含む) は未確認から始める
export function freshCrypto(c: CryptoKeyOnly): DeviceCrypto {
  return { key: c.key, confirmed_at: null, pending_nonce: null };
}

// push の宛先。skipped はタグには当たったが退役済みで外した台数。
export function resolveTargets(devices: Devices, filter: Tags): { deviceIds: string[]; skipped: number } {
  const matched = Object.entries(devices).filter(([, rec]) => matchTags(rec.tags, filter));
  return {
    deviceIds: matched.filter(([, rec]) => rec.archived_at === null).map(([id]) => id),
    skipped: matched.filter(([, rec]) => rec.archived_at !== null).length,
  };
}

// タグの優先は 招待 > 既存 > 自動。自動タグは device に無いキーだけ、既存のタグの後ろに足す (人が並べた順を崩さない)
export function mergeTags(invite: Tags, existing: Tags, auto: Tags): Tags {
  const tags: Tags = { ...existing, ...invite };
  for (const [k, val] of Object.entries(auto)) if (tags[k] === undefined) tags[k] = val;
  return tags;
}

// bark-server が登録を受けた結果を写す。新規は作り、既存は token を更新する。
// tags / crypto は登録トークンを使う登録でだけ渡す招待のタグと鍵 (再登録では空と null)。crypto は既存の端末にも写し、null なら既存の鍵を保つ。
// info は今回の観察値で丸ごと置き換え、自動タグは info から作る
export function upsertRegistration(
  devices: Devices,
  reg: { deviceId: string; deviceToken: string; tags: Tags; crypto: CryptoKeyOnly | null; info: DeviceInfo; autoTags: Tags; now: string },
): { devices: Devices; created: boolean } {
  const cur = devices[reg.deviceId];
  if (cur !== undefined) {
    const next: DeviceRecord = {
      ...cur,
      device_token: reg.deviceToken,
      tags: mergeTags(reg.tags, cur.tags, reg.autoTags),
      ...(reg.crypto === null ? {} : { crypto: freshCrypto(reg.crypto) }),
      info: reg.info,
    };
    return { devices: { ...devices, [reg.deviceId]: next }, created: false };
  }
  const rec: DeviceRecord = {
    device_token: reg.deviceToken,
    registered_at: reg.now,
    archived_at: null,
    tags: mergeTags(reg.tags, {}, reg.autoTags),
    crypto: reg.crypto === null ? null : freshCrypto(reg.crypto),
    info: reg.info,
  };
  return { devices: { ...devices, [reg.deviceId]: rec }, created: true };
}

export function patchDevice(rec: DeviceRecord, patch: PatchDevice): DeviceRecord {
  return {
    ...rec,
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    ...(patch.archived_at !== undefined ? { archived_at: patch.archived_at } : {}),
    ...(patch.crypto !== undefined ? { crypto: patch.crypto === null ? null : freshCrypto(patch.crypto) } : {}),
  };
}

// 退役済みなら最初の退役日時を保つ (DELETE を繰り返しても日時が動かない)
export function archiveDevice(rec: DeviceRecord, now: string): DeviceRecord {
  return rec.archived_at === null ? { ...rec, archived_at: now } : rec;
}

// 確認通知に埋める nonce を記録する。鍵が無ければ null
export function startCryptoConfirm(rec: DeviceRecord, nonce: string): DeviceRecord | null {
  return rec.crypto === null ? null : { ...rec, crypto: { ...rec.crypto, pending_nonce: nonce } };
}

// 確認通知の URL が開かれた。nonce が一致したときだけ確認済みにして nonce を消す (同じ URL は 1 回だけ効く)
export function finishCryptoConfirm(rec: DeviceRecord, nonce: string, now: string): DeviceRecord | null {
  if (rec.crypto === null || rec.crypto.pending_nonce === null || rec.crypto.pending_nonce !== nonce) return null;
  return { ...rec, crypto: { ...rec.crypto, confirmed_at: now, pending_nonce: null } };
}
