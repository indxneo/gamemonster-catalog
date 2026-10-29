// Turns a built catalog (data/packs/, from build-packs.ts) into an update the app can download,
// in a static site folder that the Cloudflare Worker serves as-is:
//
//   <site>/catalog/v1/manifest.json    {format, version, generatedAt, files: [{name, sha256, bytes}]}
//   <site>/catalog/v1/files/<stem>.<first 16 hex of sha256>.<ext>   e.g. files/p8.3fa9c1d2e4b56789.pack
//   <site>/catalog/v1/history.json     the manifests of the last few versions (what the site keeps)
//
// File names carry their content hash, so a cache can never serve an old file for a new version;
// the rule is mirrored in GameMonster/Data/Catalog/CatalogUpdater.swift (CatalogManifest.File.remotePath).
// Files of the last `keepVersions` versions stay, so a phone halfway through a download never gets a 404.
//
// Safety gate: refuses to publish when the new catalog lost more than 2% of all games, or more than
// 5% of any platform that had at least 100 — a bad IGDB dump must never wipe collectors' catalogs.
// Skips publishing when nothing but the build date changed.
//
// Refuses to start a new history while a catalog is live: without the previous version there's
// nothing for the gate to compare against, and deploying would drop the files phones may be
// downloading. tools/restore-site.ts downloads it from the live server (the cloud job does that
// every run, D101). `--new-history` overrides, deliberately.
//
// Usage: node tools/publish-catalog.ts [--packs data/packs] [--site data/site] [--allow-shrink] [--new-history]

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

type ManifestFile = { name: string; sha256: string; bytes: number };
type Manifest = { format: number; version: string; generatedAt: string; files: ManifestFile[] };
type Catalog = { format: number; generatedAt: string; uniqueGameCount: number; platforms: { id: number; name: string; gameCount: number }[] };

export const keepVersions = 3;
export const liveManifestURL = "https://gamemonster.indxneo.workers.dev/catalog/v1/manifest.json";
export const gate = { maxTotalDrop: 0.02, maxPlatformDrop: 0.05, minPlatformGames: 100 } as const;

export function remotePath(file: ManifestFile): string {
  const ext = extname(file.name);
  const stem = basename(file.name, ext);
  return `files/${stem}.${file.sha256.slice(0, 16)}${ext}`;
}

/// "2026-09-22T14:02:16.288Z" → "20260922T140216288Z" (a valid version folder name in the app).
export function versionName(generatedAt: string): string {
  return generatedAt.replace(/[-:.]/g, "");
}

/// Why the new catalog must not be published, or [] when it's safe.
export function gateProblems(previous: Catalog, next: Catalog): string[] {
  const problems: string[] = [];
  const drop = (before: number, after: number) => (before - after) / before;
  if (previous.uniqueGameCount > 0 && drop(previous.uniqueGameCount, next.uniqueGameCount) > gate.maxTotalDrop) {
    problems.push(`total games ${previous.uniqueGameCount} → ${next.uniqueGameCount}`);
  }
  const counts = new Map(next.platforms.map((p) => [p.id, p.gameCount]));
  for (const platform of previous.platforms) {
    if (platform.gameCount < gate.minPlatformGames) continue;
    const after = counts.get(platform.id) ?? 0;
    if (drop(platform.gameCount, after) > gate.maxPlatformDrop) problems.push(`${platform.name} ${platform.gameCount} → ${after}`);
  }
  return problems;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function readJSON<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
}

async function isCatalogLive(): Promise<boolean> {
  try {
    return (await fetch(liveManifestURL, { signal: AbortSignal.timeout(15_000) })).ok;
  } catch {
    return false; // offline: can't tell, and a local-only publish is harmless until deployed
  }
}

async function main() {
  const args = process.argv.slice(2);
  const option = (flag: string, fallback: string) => {
    const index = args.indexOf(flag);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const packsDir = option("--packs", join(root, "data", "packs"));
  const siteDir = join(option("--site", join(root, "data", "site")), "catalog", "v1");
  const allowShrink = args.includes("--allow-shrink");

  const catalogData = readFileSync(join(packsDir, "catalog.json"));
  const catalog = JSON.parse(catalogData.toString("utf8")) as Catalog;
  const files: ManifestFile[] = readdirSync(packsDir)
    .filter((name) => name === "catalog.json" || name.endsWith(".pack"))
    .sort()
    .map((name) => {
      const data = readFileSync(join(packsDir, name));
      return { name, sha256: sha256(data), bytes: data.length };
    });
  const manifest: Manifest = { format: catalog.format, version: versionName(catalog.generatedAt), generatedAt: catalog.generatedAt, files };

  const history = readJSON<Manifest[]>(join(siteDir, "history.json")) ?? [];
  if (history.length === 0 && !args.includes("--new-history") && (await isCatalogLive())) {
    console.error(`Refusing to publish: ${siteDir} has no publish history, but a catalog is live.`);
    console.error("Download it from the live server first:  node tools/restore-site.ts");
    console.error("To start a new history anyway, pass --new-history.");
    process.exit(1);
  }
  const previous = history[0];
  if (previous) {
    const previousCatalogFile = previous.files.find((f) => f.name === "catalog.json");
    const previousCatalog = previousCatalogFile && readJSON<Catalog>(join(siteDir, remotePath(previousCatalogFile)));
    if (previousCatalog) {
      const problems = gateProblems(previousCatalog, catalog);
      if (problems.length > 0 && !allowShrink) {
        console.error(`Refusing to publish: the catalog shrank too much.\n  ${problems.join("\n  ")}`);
        console.error("If this is expected, rerun with --allow-shrink.");
        process.exit(1);
      }
      const { generatedAt: _a, ...previousRest } = previousCatalog;
      const { generatedAt: _b, ...nextRest } = catalog;
      const sameData = JSON.stringify(previousRest) === JSON.stringify(nextRest)
        && files.every((f) => f.name === "catalog.json" || previous.files.some((p) => p.name === f.name && p.sha256 === f.sha256))
        && files.length === previous.files.length;
      if (sameData) {
        console.log(`Nothing changed since ${previous.version}; not publishing.`);
        return;
      }
    }
    if (previous.version === manifest.version) {
      console.log(`${manifest.version} is already published.`);
      return;
    }
  }

  mkdirSync(join(siteDir, "files"), { recursive: true });
  for (const file of files) {
    const target = join(siteDir, remotePath(file));
    if (!existsSync(target)) writeFileSync(target, readFileSync(join(packsDir, file.name)));
  }
  const kept = [manifest, ...history.filter((m) => m.version !== manifest.version)].slice(0, keepVersions);
  const referenced = new Set(kept.flatMap((m) => m.files.map((f) => basename(remotePath(f)))));
  let removed = 0;
  for (const name of readdirSync(join(siteDir, "files"))) {
    if (!referenced.has(name)) {
      rmSync(join(siteDir, "files", name));
      removed++;
    }
  }
  writeFileSync(join(siteDir, "history.json"), JSON.stringify(kept));
  // Written last: until it changes, phones keep seeing the previous, complete version.
  writeFileSync(join(siteDir, "manifest.json"), JSON.stringify(manifest));

  const megabytes = (files.reduce((sum, f) => sum + f.bytes, 0) / 1e6).toFixed(1);
  const changed = previous ? files.filter((f) => !previous.files.some((p) => p.name === f.name && p.sha256 === f.sha256)).length : files.length;
  console.log(`Published ${manifest.version}: ${files.length} files, ${megabytes} MB, ${changed} changed; removed ${removed} old files; keeping ${kept.map((m) => m.version).join(", ")}.`);
}

if (import.meta.main) await main();
