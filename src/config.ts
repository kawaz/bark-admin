import { homedir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { parseTomlWith } from "./parse.ts";

const ConfigFileSchema = v.object({
  // 招待 URL / QR に埋める公開 URL。末尾の / は落として持つ
  server_url: v.pipe(
    v.string(),
    v.url(),
    v.transform((s) => s.replace(/\/+$/, "")),
  ),
  db_path: v.optional(v.pipe(v.string(), v.minLength(1))),
});

export type Config = {
  serverUrl: string;
  dbPath: string;
  listen: { hostname: string; port: number };
  barkServerUrl: string;
};

type Env = Record<string, string | undefined>;

function xdg(env: Env, name: "XDG_CONFIG_HOME" | "XDG_DATA_HOME", fallback: string): string {
  const val = env[name];
  return val !== undefined && val !== "" ? val : join(homedir(), fallback);
}

export function configPath(env: Env): string {
  return join(xdg(env, "XDG_CONFIG_HOME", ".config"), "bark-admin", "config.toml");
}

function parseAddr(addr: string): { hostname: string; port: number } {
  const m = /^(.+):(\d+)$/.exec(addr);
  if (m === null || m[1] === undefined || m[2] === undefined) {
    throw new Error(`BARK_ADMIN_ADDR must be host:port, got "${addr}"`);
  }
  return { hostname: m[1], port: Number(m[2]) };
}

export async function loadConfig(env: Env): Promise<Config> {
  const path = configPath(env);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`${path} not found. Create it with server_url = "https://bark.<host>" (the public URL embedded in invite links)`);
  }
  const r = parseTomlWith(ConfigFileSchema, await file.text());
  if (!r.ok) throw new Error(`${path}: ${r.error.message}`);
  return {
    serverUrl: r.value.server_url,
    dbPath: r.value.db_path ?? join(xdg(env, "XDG_DATA_HOME", ".local/share"), "bark-admin", "devices.json"),
    listen: parseAddr(env["BARK_ADMIN_ADDR"] || "127.0.0.1:8086"),
    barkServerUrl: (env["BARK_SERVER_URL"] || "http://127.0.0.1:8085").replace(/\/+$/, ""),
  };
}
