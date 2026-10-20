// add-state.js の型 (bun test から import するため)。
export type StepMode = "done" | "current" | "later";

export type RegistrationStatus = {
  state: "unused" | "used" | "expired" | "invite-deleted" | "gone";
  device?: { delivery: { confirmed_at: string | null }; crypto: { confirmed_at: string | null } | null } | null;
};

export type FlowView = {
  add: StepMode;
  delivery: StepMode;
  crypto: StepMode;
  addButton: "enabled" | "removed";
  current: "add" | "delivery" | "crypto" | null;
  message: string;
  finished: boolean;
  deviceLink: boolean;
};

export declare const MESSAGES: { unusable: string; registered: string; delivered: string; allDone: string; cryptoDone: string };

export declare function flowView(r: RegistrationStatus, hasCrypto: boolean): FlowView;
