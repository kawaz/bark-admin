import { createApp } from "./app.ts";
import { BarkServer } from "./bark-server.ts";
import { loadConfig } from "./config.ts";
import { openStore } from "./store.ts";

const config = await loadConfig(process.env);
const app = createApp({
  serverUrl: config.serverUrl,
  store: openStore(config.dbPath),
  bark: new BarkServer(config.barkServerUrl),
});

const server = Bun.serve({
  hostname: config.listen.hostname,
  port: config.listen.port,
  routes: app.routes,
  fetch: app.fetch,
});

console.log(`bark-admin listening on ${server.url} (db: ${config.dbPath}, bark-server: ${config.barkServerUrl}, public: ${config.serverUrl})`);
