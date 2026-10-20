import { createApp } from "./app.ts";
import { BarkServer } from "./bark-server.ts";
import { loadConfig } from "./config.ts";
import { openStore, setAsideLegacyInvites } from "./store.ts";
import { localIso } from "./time.ts";

const config = await loadConfig(process.env);
const store = openStore(config.dbPath);
const legacy = await setAsideLegacyInvites(store, localIso().replaceAll(":", ""));
if (legacy !== null) console.log(`invites.json was in the one-time invite format; moved it to ${legacy} and starting with no invites`);
const app = createApp({
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
