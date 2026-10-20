import { existsSync } from "node:fs";
import { createApp } from "./app.ts";
import { BarkServer } from "./bark-server.ts";
import { trustedProxies } from "./client-ip.ts";
import { loadConfig } from "./config.ts";
import { TAILSCALE } from "./device-info.ts";
import { openStore, setAsideLegacyInvites } from "./store.ts";
import { localIso } from "./time.ts";

const config = await loadConfig(process.env);
const store = openStore(config.dbPath);
const legacy = await setAsideLegacyInvites(store, localIso().replaceAll(":", ""));
if (legacy !== null) console.log(`invites.json was in the one-time invite format; moved it to ${legacy} and starting with no invites`);
// Tailscale はあれば使うおまけ。無ければ ts_* を記録しないだけ
if (!existsSync(TAILSCALE)) console.log(`tailscale: not available (${TAILSCALE}); device info will not have ts_*`);
const app = createApp({
  trustedProxies: trustedProxies(process.env["BARK_ADMIN_TRUSTED_PROXIES"]),
  serverUrl: config.serverUrl,
  store,
  bark: new BarkServer(config.barkServerUrl),
});

const server = Bun.serve({
  hostname: config.listen.hostname,
  port: config.listen.port,
  routes: app.routes,
  fetch: app.fetch,
});

console.log(`bark-admin listening on ${server.url} (db: ${config.dbPath}, bark-server: ${config.barkServerUrl}, public: ${config.serverUrl})`);
