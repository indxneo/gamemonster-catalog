// Minimal IGDB client for local tooling (probe, pack builder).
// Runs on Node 26+ directly (`node tools/<script>.ts`), no dependencies.
// Secrets are read from proxy/.dev.vars (or, without that file, the environment variables of the
// same names — the cloud job's secrets) and never printed.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const secretsPath = join(root, "proxy", ".dev.vars");
const tokenCachePath = join(root, ".igdb-token.json");

type Credentials = { clientId: string; clientSecret: string };
type CachedToken = { accessToken: string; expiresAt: number };

function loadCredentials(): Credentials {
  if (!existsSync(secretsPath)) {
    const clientId = process.env.TWITCH_CLIENT_ID ?? "";
    const clientSecret = process.env.TWITCH_CLIENT_SECRET ?? "";
    if (!clientId || !clientSecret) {
      throw new Error(`Missing ${secretsPath} (or TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET in the environment)`);
    }
    return { clientId, clientSecret };
  }
  const vars: Record<string, string> = {};
  for (const line of readFileSync(secretsPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match) vars[match[1]] = match[2];
  }
  const clientId = vars.TWITCH_CLIENT_ID ?? "";
  const clientSecret = vars.TWITCH_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) {
    throw new Error("TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are empty in proxy/.dev.vars");
  }
  return { clientId, clientSecret };
}

async function getAccessToken(creds: Credentials): Promise<string> {
  if (existsSync(tokenCachePath)) {
    const cached: CachedToken = JSON.parse(readFileSync(tokenCachePath, "utf8"));
    // Refresh a day early.
    if (cached.expiresAt - Date.now() > 24 * 60 * 60 * 1000) return cached.accessToken;
  }
  const url = new URL("https://id.twitch.tv/oauth2/token");
  url.searchParams.set("client_id", creds.clientId);
  url.searchParams.set("client_secret", creds.clientSecret);
  url.searchParams.set("grant_type", "client_credentials");
  const response = await fetch(url, { method: "POST" });
  if (!response.ok) {
    throw new Error(`Twitch token request failed: HTTP ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { access_token: string; expires_in: number };
  const token: CachedToken = {
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  writeFileSync(tokenCachePath, JSON.stringify(token), { mode: 0o600 });
  return token.accessToken;
}

// IGDB allows 4 requests/second; space calls ~300 ms apart to stay safely under it.
const minInterval = 300;
let lastCall = 0;

let session: { creds: Credentials; token: string } | undefined;

export async function igdb<T = unknown>(endpoint: string, query: string): Promise<T> {
  if (!session) {
    const creds = loadCredentials();
    session = { creds, token: await getAccessToken(creds) };
  }
  const wait = lastCall + minInterval - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCall = Date.now();

  const response = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
    method: "POST",
    headers: {
      "Client-ID": session.creds.clientId,
      Authorization: `Bearer ${session.token}`,
      Accept: "application/json",
    },
    body: query,
  });
  if (response.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return igdb<T>(endpoint, query);
  }
  if (!response.ok) {
    throw new Error(`IGDB ${endpoint} failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

// GET requests (used by the data dumps endpoints).
export async function igdbGet<T = unknown>(endpoint: string): Promise<T> {
  if (!session) {
    const creds = loadCredentials();
    session = { creds, token: await getAccessToken(creds) };
  }
  const response = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
    headers: { "Client-ID": session.creds.clientId, Authorization: `Bearer ${session.token}` },
  });
  if (!response.ok) throw new Error(`IGDB GET ${endpoint} failed: HTTP ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

export const paths = {
  root,
  samples: join(root, "data", "samples"),
  dumps: join(root, "data", "dumps"),
  packs: join(root, "data", "packs"),
};
