// Rebuilds the publish history (data/site/) from the live server: history.json, manifest.json and
// every file of the versions history.json keeps, each checked against its SHA-256. The cloud job
// (tools/catalog-cloud-job.sh) starts on an empty machine every run, and `wrangler deploy` replaces
// everything the Worker serves, so publishing without this would drop the files of the versions
// phones may still be downloading — and leave the shrink gate nothing to compare against.
//
// Also the way back for a lost history on any machine (it replaces data/site/ entirely).
//
// Usage: node tools/restore-site.ts [--site data/site]

import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveManifestURL, remotePath } from "./publish-catalog.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const liveBase = liveManifestURL.slice(0, liveManifestURL.lastIndexOf("/") + 1);

type ManifestFile = { name: string; sha256: string; bytes: number };
type Manifest = { format: number; version: string; generatedAt: string; files: ManifestFile[] };

async function download(path: string): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(liveBase + path, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt === 3) throw new Error(`Couldn't download ${path}: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
    }
  }
}

const args = process.argv.slice(2);
const siteIndex = args.indexOf("--site");
const siteDir = join(siteIndex >= 0 ? args[siteIndex + 1] : join(root, "data", "site"), "catalog", "v1");

const historyData = await download("history.json");
const manifestData = await download("manifest.json");
const history = JSON.parse(historyData.toString("utf8")) as Manifest[];
const manifest = JSON.parse(manifestData.toString("utf8")) as Manifest;
if (history.length === 0 || JSON.stringify(history[0]) !== JSON.stringify(manifest)) {
  throw new Error("The live history.json doesn't start with the live manifest; not restoring.");
}

// Download everything first, so a failure leaves the folder as it was.
const files = new Map<string, Buffer>();
for (const file of history.flatMap((m) => m.files)) {
  const path = remotePath(file);
  if (files.has(path)) continue;
  const data = await download(path);
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (sha256 !== file.sha256 || data.length !== file.bytes) throw new Error(`${path} doesn't match its manifest entry`);
  files.set(path, data);
}

rmSync(siteDir, { recursive: true, force: true });
mkdirSync(join(siteDir, "files"), { recursive: true });
for (const [path, data] of files) writeFileSync(join(siteDir, "files", basename(path)), data);
writeFileSync(join(siteDir, "history.json"), historyData);
writeFileSync(join(siteDir, "manifest.json"), manifestData);
const megabytes = ([...files.values()].reduce((sum, data) => sum + data.length, 0) / 1e6).toFixed(1);
console.log(`Restored ${history.map((m) => m.version).join(", ")} from the live server: ${files.size} files, ${megabytes} MB, all checked.`);
