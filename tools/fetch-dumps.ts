// Downloads the IGDB CSV data dumps GameMonster needs into data/dumps/.
// Dumps are refreshed daily by IGDB; download links are valid for 5 minutes.
//
// Usage: node tools/fetch-dumps.ts [endpoint ...]

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { igdbGet, paths } from "./igdb.ts";

export const requiredDumps = [
  "platforms",
  "platform_versions",
  "platform_logos",
  "platform_families",
  "games",
  "release_dates",
  "alternative_names",
  "game_localizations",
  "covers",
  "external_games",
  "genres",
  // Game details (description, screenshots, artwork, companies, modes, themes).
  "screenshots",
  "artworks",
  "involved_companies",
  "companies",
  "game_modes",
  "themes",
  // Local multiplayer per platform (players on one console, split screen).
  "multiplayer_modes",
  // Series ("You own 3 of 10").
  "collections",
  "collection_memberships",
  // Trailers (YouTube ids) for games that aren't out yet.
  "game_videos",
];

type DumpInfo = { s3_url: string; file_name: string; size_bytes: number; schema_version: string; schema: Record<string, string> };

const endpoints = process.argv.slice(2).length > 0 ? process.argv.slice(2) : requiredDumps;
mkdirSync(paths.dumps, { recursive: true });

// Merge into the existing schema list so fetching a subset doesn't drop the others.
const schemasPath = join(paths.dumps, "schemas.json");
const manifest: Record<string, { file: string; schemaVersion: string; schema: Record<string, string> }> =
  existsSync(schemasPath) ? JSON.parse(readFileSync(schemasPath, "utf8")) : {};
for (const endpoint of endpoints) {
  const info = await igdbGet<DumpInfo>(`dumps/${endpoint}`);
  const file = join(paths.dumps, `${endpoint}.csv`);
  process.stdout.write(`↓ ${endpoint} (${(info.size_bytes / 1e6).toFixed(1)} MB)… `);
  const response = await fetch(info.s3_url);
  if (!response.ok || !response.body) throw new Error(`Download failed for ${endpoint}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(file));
  manifest[endpoint] = { file: `${endpoint}.csv`, schemaVersion: info.schema_version, schema: info.schema };
  console.log("done");
}
writeFileSync(schemasPath, JSON.stringify(manifest, null, 2));
