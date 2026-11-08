import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { parseConfig, watchConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createHr } from "./hr.ts";
import { log } from "./log.ts";
import { parseProducts } from "./products.ts";
import { createKeyring } from "./seal.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.HR_DB ?? "/data/hr.db";
const configPath = process.env.HR_CONFIG?.trim() || "/config/hr.yaml";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.HR_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.HR_METRICS_PORT ? Number(process.env.HR_METRICS_PORT) : undefined;
const publicUrl = (process.env.HR_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");

// Personal data is sealed with the install's key (ADR 0021, KVKK md. 12): HR does not start without it.
const secretsKeyFile = process.env.HR_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
let kek: Buffer | undefined;
try {
  kek = readSecretsKey(secretsKeyFile);
} catch (err) {
  log("error", `the key-encryption key cannot be read: ${(err as Error).message}`, { file: secretsKeyFile });
}
if (!kek) {
  log("error", "HR needs the install's key to seal personal data: mount a 32-byte key (openssl rand -hex 32 > openasy-kek)", { file: secretsKeyFile });
  process.exit(1);
}

const db = openDb(dbPath);
const auth = createAuth({
  db,
  product: "hr",
  productName: "OpenAsy HR",
  origin: publicUrl,
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.HR_PASSWORD_SIGN_IN !== "false",
  // Employees sign in with the user role to see their own record, ask for leave and approve their team's.
  users: true,
  oidc: oidcFromEnv(process.env),
  secretsKey: kek,
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
let file: ReturnType<typeof watchConfig> | undefined;
const hr = createHr(db, { publicUrl, keyring: createKeyring(kek), fileState: () => file?.state ?? null });
file = watchConfig(configPath, (config, text) => hr.setConfig(config, text), {
  onChange: (state) =>
    state.error
      ? log("warn", "settings file not applied: the last good version stays until it is fixed", { file: state.path, error: state.error })
      : log("info", "settings file applied", { file: state.path, warnings: state.warnings }),
});
// Without a file, HR starts on Türkiye's defaults, so a first look needs nothing written.
if (!hr.config()) {
  hr.setConfig(parseConfig(""), "");
  log("warn", "no settings file applied: using Türkiye's defaults until it can be read", { file: configPath });
}
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });
const server = createServer(
  createApp({
    db,
    hr,
    version,
    auth,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(hr, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "hr started", { version, port, db: dbPath, config: configPath, headless }));
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl))
  log("warn", "HR_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys. Put it behind TLS (ADR 0026)", { url: publicUrl });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

const timers: NodeJS.Timeout[] = [setInterval(() => auth.purge(), 5 * 60_000), setInterval(() => void hr.tick(), 30_000)];
void hr.tick();

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  file?.stop();
  metricsServer?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
