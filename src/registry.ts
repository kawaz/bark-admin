import type { DeviceRecord, Devices, DeviceView, PatchDevice, Tags } from "./schema/registry.ts";

// 登録簿の操作 (純粋関数)。永続化は store.ts が受け持つ。

// filter の全キーが完全一致する (AND)。空の filter は全件に当たる。
export function matchTags(tags: Tags, filter: Tags): boolean {
  return Object.entries(filter).every(([k, val]) => tags[k] === val);
}

function view(id: string, rec: DeviceRecord): DeviceView {
  return { device_id: id, ...rec };
}

export function selectDevices(devices: Devices, filter: Tags, includeArchived: boolean): DeviceView[] {
  return Object.entries(devices)
    .filter(([, rec]) => (includeArchived || rec.archived_at === null) && matchTags(rec.tags, filter))
    .map(([id, rec]) => view(id, rec));
}

// push の宛先。skipped はタグには当たったが退役済みで外した台数。
export function resolveTargets(devices: Devices, filter: Tags): { deviceIds: string[]; skipped: number } {
  const matched = Object.entries(devices).filter(([, rec]) => matchTags(rec.tags, filter));
  return {
    deviceIds: matched.filter(([, rec]) => rec.archived_at === null).map(([id]) => id),
    skipped: matched.filter(([, rec]) => rec.archived_at !== null).length,
  };
}

// bark-server が登録を受けた結果を写す。新規は tags 付きで作り、既存は token だけ更新する。
export function upsertRegistration(
  devices: Devices,
  reg: { deviceId: string; deviceToken: string; tags: Tags; now: string },
): { devices: Devices; created: boolean } {
  const cur = devices[reg.deviceId];
  if (cur !== undefined) {
    return { devices: { ...devices, [reg.deviceId]: { ...cur, device_token: reg.deviceToken } }, created: false };
  }
  const rec: DeviceRecord = { device_token: reg.deviceToken, registered_at: reg.now, archived_at: null, tags: reg.tags };
  return { devices: { ...devices, [reg.deviceId]: rec }, created: true };
}

export function patchDevice(rec: DeviceRecord, patch: PatchDevice): DeviceRecord {
  return {
    ...rec,
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    ...(patch.archived_at !== undefined ? { archived_at: patch.archived_at } : {}),
  };
}

// 退役済みなら最初の退役日時を保つ (DELETE を繰り返しても日時が動かない)
export function archiveDevice(rec: DeviceRecord, now: string): DeviceRecord {
  return rec.archived_at === null ? { ...rec, archived_at: now } : rec;
}
