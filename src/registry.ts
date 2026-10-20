import type { CryptoKeyOnly, DeviceCrypto, DeviceListItem, DeviceRecord, Devices, DeviceView, PatchDevice, Tags } from "./schema/registry.ts";

// 登録簿の操作 (純粋関数)。永続化は store.ts が受け持つ。

// filter の全キーが完全一致する (AND)。空の filter は全件に当たる。
export function matchTags(tags: Tags, filter: Tags): boolean {
  return Object.entries(filter).every(([k, val]) => tags[k] === val);
}

export function view(id: string, { crypto, ...rest }: DeviceRecord): DeviceView {
  return { device_id: id, ...rest, crypto: crypto === null ? null : { key: crypto.key, confirmed_at: crypto.confirmed_at } };
}

export function selectDevices(devices: Devices, filter: Tags, includeArchived: boolean): DeviceView[] {
  return Object.entries(devices)
    .filter(([, rec]) => (includeArchived || rec.archived_at === null) && matchTags(rec.tags, filter))
    .map(([id, rec]) => view(id, rec));
}

// 一覧に出す形。鍵そのものは落とし、暗号化の有無と確認状態だけ残す
export function listItem({ crypto, ...rest }: DeviceView): DeviceListItem {
  return { ...rest, crypto: crypto === null ? null : { confirmed_at: crypto.confirmed_at } };
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

// bark-server が登録を受けた結果を写す。新規は tags / crypto (招待の値) 付きで作り、既存は token だけ更新する。
export function upsertRegistration(
  devices: Devices,
  reg: { deviceId: string; deviceToken: string; tags: Tags; crypto: CryptoKeyOnly | null; now: string },
): { devices: Devices; created: boolean } {
  const cur = devices[reg.deviceId];
  if (cur !== undefined) {
    return { devices: { ...devices, [reg.deviceId]: { ...cur, device_token: reg.deviceToken } }, created: false };
  }
  const rec: DeviceRecord = { device_token: reg.deviceToken, registered_at: reg.now, archived_at: null, tags: reg.tags, crypto: reg.crypto === null ? null : freshCrypto(reg.crypto) };
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
