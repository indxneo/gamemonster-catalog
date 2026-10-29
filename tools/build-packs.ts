// Builds GameMonster catalog packs from the IGDB CSV dumps in data/dumps/.
//
// Output (data/packs/, then copied into GameMonster/Resources/Catalog/ for the app bundle):
//   catalog.json     – every console/handheld platform, its hardware models,
//                      genres, and the pack file for each platform
//   p{id}.pack       – raw-DEFLATE–compressed JSON with that platform's games
//                      (format must match GameMonster/Data/Catalog/PackFormat.swift)
//   d{n}.pack        – game details (summary, screenshots, artwork, companies, rating,
//                      modes, themes, a trailer for games not out yet) sharded by game id % detailShardCount, so a game on
//                      several platforms is stored once
//
// Usage: node tools/fetch-dumps.ts && node tools/build-packs.ts [--skip-app-copy]
//   --skip-app-copy  only write data/packs/ (the weekly catalog job, which publishes updates
//                    but must never touch the app's bundled catalog)

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { int, intList, readCSV } from "./csv.ts";
import { paths } from "./igdb.ts";

export const packFormatVersion = 1;
export const detailShardCount = 64;
const maxSummaryLength = 1500;
const maxScreenshots = 8;
const maxArtworks = 3;

// Schema versions this builder was written against. If IGDB changes a dump's
// schema, stop instead of silently producing broken packs.
const expectedSchemas: Record<string, string> = JSON.parse(
  readFileSync(join(paths.root, "tools", "expected-schemas.json"), "utf8"),
);

const overrides = JSON.parse(readFileSync(join(paths.root, "tools", "platform-overrides.json"), "utf8")) as {
  shortNames: Record<string, string>;
  families: Record<string, string>;
};

// Where the app bundles the catalog so it works offline from first launch.
const appCatalogDir = join(paths.root, "GameMonster", "Resources", "Catalog");

// IGDB platform_type: 1 = console, 5 = portable console.
const platformTypes: Record<string, "console" | "portable"> = { "1": "console", "5": "portable" };

// Console-typed entries that aren't collectable game platforms.
const excludedPlatforms = new Set([
  55, // Legacy Mobile Device
  143, 144, 145, 146, 147, 148, // General Instrument AY-3 chips
  238, 239, // DVD / Blu-ray players
  384, 385, 386, 387, 388, 471, // VR headsets
]);

// IGDB game_type values that correspond to standalone products someone can own.
// 0 main, 3 bundle, 4 standalone expansion, 8 remake, 9 remaster, 10 expanded, 11 port.
const ownableGameTypes = new Set([0, 3, 4, 8, 9, 10, 11]);

// IGDB game_status values to drop: 6 cancelled, 7 rumored.
const droppedGameStatuses = new Set([6, 7]);

// release_date_statuses: 5 = cancelled.
const cancelledReleaseStatus = 5;
// release_date_statuses that aren't the game coming out: 1 alpha, 2 beta, 34 "Advanced Access"
// (early play for deluxe-edition buyers — Control Resonant's Sep 22 before its Sep 24 release made
// it look out already). Early Access (3) stays: on consoles it's a real, buyable release.
const notAReleaseStatuses = new Set([1, 2, 34]);

const dumps = (name: string) => join(paths.dumps, `${name}.csv`);

function checkSchemas() {
  const actual = JSON.parse(readFileSync(join(paths.dumps, "schemas.json"), "utf8")) as Record<
    string,
    { schemaVersion: string }
  >;
  const changed = Object.entries(expectedSchemas).filter(([name, v]) => actual[name]?.schemaVersion !== v);
  if (changed.length > 0) {
    throw new Error(
      `IGDB dump schema changed for: ${changed.map(([n]) => n).join(", ")}. ` +
        "Review the columns used by build-packs.ts, then update tools/expected-schemas.json.",
    );
  }
}

/** yyyymmdd as an integer (e.g. 19950811); 0 when unknown; month/day 00 when partial. */
function dateKey(date: string, y: string, m: string, dateFormat: string): number {
  // date_format: 0 YYYYMMMMDD, 1 YYYYMMMM, 2 YYYY, 3 YYYYQ1…, 7 TBD
  const year = int(y);
  if (!year) return 0;
  const format = int(dateFormat) ?? 0;
  if (format === 0 && date.length >= 10) return Number(date.slice(0, 10).replaceAll("-", ""));
  const month = format === 1 ? (int(m) ?? 0) : 0;
  return year * 10000 + month * 100;
}

type GameRecord = {
  id: number;
  name: string;
  type: number;
  platforms: number[];
  genres: number[];
  coverID?: number;
  parentID?: number;
  /** IGDB's parent_game: for a remake or remaster, the original. */
  originalID?: number;
  /** IGDB's version_parent: set on an edition of another game. */
  versionParentID?: number;
  remakes: number[];
  remasters: number[];
  popularity: number;
  /** IGDB hypes: follows before release — how anticipated an upcoming game is. */
  hypes: number;
  summary?: string;
  rating?: number;
  modes: number[];
  themes: number[];
};

/** Trims long descriptions at a sentence boundary. */
function trimSummary(text: string): string | undefined {
  const clean = text.replace(/\r/g, "").trim();
  if (!clean) return undefined;
  if (clean.length <= maxSummaryLength) return clean;
  const cut = clean.slice(0, maxSummaryLength);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
  return (lastStop > maxSummaryLength * 0.6 ? cut.slice(0, lastStop + 1) : cut.trimEnd() + "…");
}

async function main() {
  checkSchemas();
  const started = Date.now();
  const log = (message: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);

  // 1. Platforms, logos, families, hardware models.
  const logos = new Map<number, string>();
  for await (const row of readCSV(dumps("platform_logos"))) logos.set(Number(row.id), row.image_id);

  const families = new Map<number, string>();
  for await (const row of readCSV(dumps("platform_families"))) families.set(Number(row.id), row.name);

  const versionRows = new Map<number, { name: string; logo?: number }>();
  for await (const row of readCSV(dumps("platform_versions"))) {
    versionRows.set(Number(row.id), { name: row.name, logo: int(row.platform_logo) });
  }

  type PlatformOut = {
    id: number;
    name: string;
    shortName: string;
    alternativeName?: string;
    generation?: number;
    family?: string;
    kind: "console" | "portable";
    logoImageID?: string;
    models: { id: number; name: string; imageID?: string }[];
    gameCount: number;
    packFile: string;
    packBytes: number;
  };
  const platforms = new Map<number, PlatformOut>();
  for await (const row of readCSV(dumps("platforms"))) {
    const id = Number(row.id);
    const kind = platformTypes[row.platform_type];
    if (!kind || excludedPlatforms.has(id)) continue;
    const models = intList(row.versions)
      .map((versionID) => {
        const version = versionRows.get(versionID);
        if (!version) return undefined;
        return {
          id: versionID,
          name: version.name,
          imageID: version.logo ? logos.get(version.logo) : undefined,
        };
      })
      .filter((m) => m !== undefined);
    platforms.set(id, {
      id,
      name: row.name,
      shortName: overrides.shortNames[row.id] ?? (/[A-Z0-9]/.test(row.abbreviation) ? row.abbreviation : row.name),
      alternativeName: row.alternative_name || undefined,
      generation: int(row.generation),
      family: families.get(int(row.platform_family) ?? -1) ?? overrides.families[row.id],
      kind,
      logoImageID: logos.get(int(row.platform_logo) ?? -1),
      models,
      gameCount: 0,
      packFile: `p${id}.pack`,
      packBytes: 0,
    });
  }
  log(`${platforms.size} console/handheld platforms`);

  // 2. Games on those platforms.
  const games = new Map<number, GameRecord>();
  for await (const row of readCSV(dumps("games"))) {
    const type = int(row.game_type) ?? 0;
    if (!ownableGameTypes.has(type)) continue;
    const status = int(row.game_status) ?? int(row.status);
    if (status !== undefined && droppedGameStatuses.has(status)) continue;
    const gamePlatforms = intList(row.platforms).filter((p) => platforms.has(p));
    if (gamePlatforms.length === 0) continue;
    games.set(Number(row.id), {
      id: Number(row.id),
      name: row.name,
      type,
      platforms: gamePlatforms,
      genres: intList(row.genres),
      coverID: int(row.cover),
      parentID: int(row.version_parent) ?? int(row.parent_game),
      originalID: int(row.parent_game),
      versionParentID: int(row.version_parent),
      remakes: intList(row.remakes),
      remasters: intList(row.remasters),
      popularity: int(row.total_rating_count) ?? 0,
      hypes: int(row.hypes) ?? 0,
      summary: trimSummary(row.summary),
      rating: row.total_rating ? Math.round(Number(row.total_rating)) : undefined,
      modes: intList(row.game_modes),
      themes: intList(row.themes),
    });
  }
  log(`${games.size} ownable games`);

  // 3. Covers.
  const covers = new Map<number, string>();
  for await (const row of readCSV(dumps("covers"))) {
    const game = int(row.game);
    if (game !== undefined && games.has(game) && !row.game_localization) covers.set(Number(row.id), row.image_id);
  }
  log(`${covers.size} covers`);

  // 4. Alternative and localized names (search only).
  const altNames = new Map<number, Set<string>>();
  const addAltName = (gameID: number, name: string) => {
    const game = games.get(gameID);
    if (!game || !name || name === game.name) return;
    let names = altNames.get(gameID);
    if (!names) altNames.set(gameID, (names = new Set()));
    names.add(name);
  };
  for await (const row of readCSV(dumps("alternative_names"))) addAltName(Number(row.game), row.name);
  for await (const row of readCSV(dumps("game_localizations"))) addAltName(Number(row.game), row.name);
  log(`alternative names for ${altNames.size} games`);

  // 5. Physical listings (external_games with game_release_format = 2).
  const physical = new Set<string>(); // "game:platform"
  for await (const row of readCSV(dumps("external_games"))) {
    if (row.game_release_format !== "2") continue;
    const game = Number(row.game);
    if (!games.has(game)) continue;
    physical.add(`${game}:${row.platform || "*"}`);
  }
  log(`${physical.size} physical listings`);

  // 6. Release dates per game and platform.
  const releases = new Map<string, number[][]>(); // "game:platform" -> [[region, yyyymmdd]]
  for await (const row of readCSV(dumps("release_dates"))) {
    const game = Number(row.game);
    const platform = Number(row.platform);
    if (!games.has(game) || !platforms.has(platform)) continue;
    if (int(row.status) === cancelledReleaseStatus) continue;
    if (notAReleaseStatuses.has(int(row.status) ?? -1)) continue;
    const region = int(row.release_region) ?? 8; // 8 = worldwide
    const key = `${game}:${platform}`;
    let list = releases.get(key);
    if (!list) releases.set(key, (list = []));
    const date = dateKey(row.date, row.y, row.m, row.date_format);
    if (!list.some(([r, d]) => r === region && d === date)) list.push([region, date]);
  }
  log(`${releases.size} game/platform release sets`);

  // 6a. The year each game first came out on any catalog platform. Consoles only, on purpose:
  // IGDB's game-level first_release_date includes PC early access, which would make a 2021
  // console release of Hades look like a port. Written into a pack entry as `y` only when it's
  // earlier than the game's first release on that platform (a port or re-release).
  const firstYear = new Map<number, number>();
  const firstDate = new Map<number, number>(); // yyyymmdd, 00 for unknown parts
  for (const [key, list] of releases) {
    const game = Number(key.slice(0, key.indexOf(":")));
    for (const [, date] of list) {
      const year = Math.floor(date / 10000);
      if (year > 0 && year < (firstYear.get(game) ?? Infinity)) firstYear.set(game, year);
      if (date > 0 && date < (firstDate.get(game) ?? Infinity)) firstDate.set(game, date);
    }
  }

  // 6b. Details: screenshots, artwork, developers/publishers.
  const pushLimited = (map: Map<number, string[]>, key: number, value: string, limit: number) => {
    let list = map.get(key);
    if (!list) map.set(key, (list = []));
    if (list.length < limit) list.push(value);
  };
  const screenshots = new Map<number, string[]>();
  for await (const row of readCSV(dumps("screenshots"))) {
    const game = Number(row.game);
    if (games.has(game) && row.image_id) pushLimited(screenshots, game, row.image_id, maxScreenshots);
  }
  const artworks = new Map<number, string[]>();
  for await (const row of readCSV(dumps("artworks"))) {
    const game = Number(row.game);
    if (games.has(game) && row.image_id) pushLimited(artworks, game, row.image_id, maxArtworks);
  }
  const developerIDs = new Map<number, number[]>();
  const publisherIDs = new Map<number, number[]>();
  const neededCompanies = new Set<number>();
  for await (const row of readCSV(dumps("involved_companies"))) {
    const game = Number(row.game);
    const company = int(row.company);
    if (!games.has(game) || company === undefined) continue;
    for (const [flag, map] of [[row.developer, developerIDs], [row.publisher, publisherIDs]] as const) {
      if (flag !== "t") continue;
      let list = map.get(game);
      if (!list) map.set(game, (list = []));
      if (!list.includes(company) && list.length < 4) list.push(company);
      neededCompanies.add(company);
    }
  }
  const companyNames = new Map<number, string>();
  for await (const row of readCSV(dumps("companies"))) {
    const id = Number(row.id);
    if (neededCompanies.has(id)) companyNames.set(id, row.name);
  }
  log(`details: ${screenshots.size} games with screenshots, ${artworks.size} with artwork, ${companyNames.size} companies`);

  // 6c. Local multiplayer per platform: [platform, most players on one console, split screen 0/1,
  // local co-op 0/1], only where more than one can play on the same console. Per platform, because
  // a port can differ (the N64 GoldenEye has four-player split screen, the DS one none).
  const localPlay = new Map<number, number[][]>();
  for await (const row of readCSV(dumps("multiplayer_modes"))) {
    const game = Number(row.game);
    const platform = int(row.platform);
    if (!games.has(game) || platform === undefined || !platforms.has(platform)) continue;
    const players = Math.max(int(row.offlinemax) ?? 0, int(row.offlinecoopmax) ?? 0);
    if (players < 2) continue;
    let list = localPlay.get(game);
    if (!list) localPlay.set(game, (list = []));
    if (!list.some(([p]) => p === platform)) list.push([platform, players, row.splitscreen === "t" ? 1 : 0, row.offlinecoop === "t" ? 1 : 0]);
  }
  log(`local multiplayer for ${localPlay.size} games`);

  // 6d. Originals, remakes and remasters of each other (IGDB's parent_game, remakes, remasters),
  // among the catalog's games: "o" original, "m" remake, "s" remaster.
  const related = new Map<number, { i: number; k: string }[]>();
  const relate = (from: number, to: number, kind: string) => {
    if (from === to || !games.has(from) || !games.has(to)) return;
    let list = related.get(from);
    if (!list) related.set(from, (list = []));
    if (!list.some((r) => r.i === to)) list.push({ i: to, k: kind });
  };
  for (const game of games.values()) {
    for (const id of game.remakes) { relate(game.id, id, "m"); relate(id, game.id, "o"); }
    for (const id of game.remasters) { relate(game.id, id, "s"); relate(id, game.id, "o"); }
    if ((game.type === 8 || game.type === 9) && game.originalID !== undefined) {
      relate(game.id, game.originalID, "o");
      relate(game.originalID, game.id, game.type === 8 ? "m" : "s");
    }
  }
  log(`originals, remakes and remasters linked for ${related.size} games`);

  // 6e. Series (IGDB collections), for "Silent Hill · You own 3 of 10". Main games are what's
  // counted: "Member" games that are main games in their own right (not editions, bundles, ports,
  // expansions, remakes or remasters) and out by today. Remakes and remasters, and "Spin-off" main
  // games, are listed but not counted; a remake carries `o`, the main game it remakes, and owning
  // it counts as owning that game (D69). Only series with at least two main games are kept, and each
  // game points at one series: the biggest one it's counted in, else the biggest it's listed in.
  const today = Number(new Date().toISOString().slice(0, 10).replaceAll("-", ""));
  const isOut = (id: number) => (firstDate.get(id) ?? Infinity) <= today;
  const isMainGame = (g: GameRecord) => g.type === 0 && g.versionParentID === undefined;
  const seriesNames = new Map<number, string>();
  for await (const row of readCSV(dumps("collections"))) seriesNames.set(Number(row.id), row.name);
  type SeriesLists = { main: number[]; remakes: number[]; spinOffs: number[] };
  const seriesLists = new Map<number, SeriesLists>();
  for await (const row of readCSV(dumps("collection_memberships"))) {
    const game = games.get(Number(row.game));
    const series = Number(row.collection);
    if (!game || !seriesNames.has(series) || !isOut(game.id)) continue;
    let lists = seriesLists.get(series);
    if (!lists) seriesLists.set(series, (lists = { main: [], remakes: [], spinOffs: [] }));
    const list = game.type === 8 || game.type === 9 ? lists.remakes
      : !isMainGame(game) ? undefined
      : row.type === "2" ? lists.spinOffs : lists.main;
    if (list && !list.includes(game.id)) list.push(game.id);
  }
  for (const [id, lists] of seriesLists) if (lists.main.length < 2) seriesLists.delete(id);
  const seriesOf = new Map<number, number>();
  const size = (id: number) => seriesLists.get(id)!.main.length;
  for (const [id, lists] of seriesLists) {
    for (const game of lists.main) {
      const current = seriesOf.get(game);
      if (current === undefined || !seriesLists.get(current)!.main.includes(game) || size(id) > size(current)) seriesOf.set(game, id);
    }
    for (const game of [...lists.remakes, ...lists.spinOffs]) {
      const current = seriesOf.get(game);
      if (current === undefined || (!seriesLists.get(current)!.main.includes(game) && size(id) > size(current))) seriesOf.set(game, id);
    }
  }
  const seriesGame = (id: number) => {
    const g = games.get(id)!;
    const cover = g.coverID !== undefined ? covers.get(g.coverID) : undefined;
    return { i: id, n: g.name, y: firstYear.get(id), c: cover, p: g.platforms };
  };
  const byFirstRelease = (a: number, b: number) => (firstDate.get(a) ?? 0) - (firstDate.get(b) ?? 0) || a - b;
  log(`${seriesLists.size} series with two or more main games`);

  // 6f. A trailer for games that aren't out yet on some platform (at the precision the date is
  // known: a month-only date is upcoming through that month). The newest video named a trailer,
  // else a teaser, else the newest video; IGDB ids grow over time, so newest means the highest id
  // ("Release Date Trailer" over "Announcement Trailer"). Released games keep their gallery.
  const isUpcoming = (date: number) => {
    if (date <= 0) return false;
    const month = Math.floor(date / 100) % 100;
    if (month > 0 && date % 100 > 0) return date >= today;
    if (month > 0) return Math.floor(date / 100) >= Math.floor(today / 100);
    return Math.floor(date / 10000) >= Math.floor(today / 10000);
  };
  const upcoming = new Set<number>();
  for (const [key, list] of releases) {
    const dates = list.map(([, date]) => date).filter((date) => date > 0);
    if (dates.length > 0 && isUpcoming(Math.min(...dates))) upcoming.add(Number(key.slice(0, key.indexOf(":"))));
  }
  const videoRank = (name: string) => (/trailer/i.test(name) ? 2 : /teaser/i.test(name) ? 1 : 0);
  const trailers = new Map<number, { id: number; rank: number; y: string; n: string }>();
  for await (const row of readCSV(dumps("game_videos"))) {
    const game = Number(row.game);
    if (!upcoming.has(game) || !/^[A-Za-z0-9_-]{11}$/.test(row.video_id)) continue;
    const id = Number(row.id);
    const rank = videoRank(row.name);
    const current = trailers.get(game);
    if (current && (current.rank > rank || (current.rank === rank && current.id > id))) continue;
    trailers.set(game, { id, rank, y: row.video_id, n: row.name.trim() || "Trailer" });
  }
  log(`trailers for ${trailers.size} of ${upcoming.size} games not out yet`);

  // 7. Write one pack per platform.
  rmSync(paths.packs, { recursive: true, force: true });
  mkdirSync(paths.packs, { recursive: true });
  const byPlatform = new Map<number, object[]>();
  for (const game of games.values()) {
    for (const platform of game.platforms) {
      const key = `${game.id}:${platform}`;
      const entry: Record<string, unknown> = { i: game.id, n: game.name };
      const names = altNames.get(game.id);
      if (names && names.size > 0) entry.a = [...names];
      if (game.type !== 0) entry.t = game.type;
      const cover = game.coverID !== undefined ? covers.get(game.coverID) : undefined;
      if (cover) entry.c = cover;
      if (game.genres.length > 0) entry.g = game.genres;
      const rel = releases.get(key)?.sort((a, b) => a[1] - b[1]);
      if (rel && rel.length > 0) entry.r = rel;
      const hereYears = (rel ?? []).map(([, date]) => Math.floor(date / 10000)).filter((year) => year > 0);
      const originalYear = firstYear.get(game.id);
      if (originalYear !== undefined && hereYears.length > 0 && originalYear < Math.min(...hereYears)) entry.y = originalYear;
      if (physical.has(key) || physical.has(`${game.id}:*`)) entry.f = 1;
      if (game.popularity > 0) entry.s = game.popularity;
      if (game.hypes > 0) entry.h = game.hypes; // ranks "Coming Soon" by anticipation (never shown as a number)
      if (game.parentID !== undefined && games.has(game.parentID)) entry.v = game.parentID;
      const others = game.platforms.filter((p) => p !== platform);
      if (others.length > 0) entry.o = others;
      let list = byPlatform.get(platform);
      if (!list) byPlatform.set(platform, (list = []));
      list.push(entry);
    }
  }

  let totalBytes = 0;
  for (const platform of platforms.values()) {
    const list = byPlatform.get(platform.id) ?? [];
    platform.gameCount = list.length;
    if (list.length === 0) continue;
    const json = JSON.stringify({ format: packFormatVersion, platform: platform.id, games: list });
    const compressed = deflateRawSync(Buffer.from(json), { level: 9 });
    writeFileSync(join(paths.packs, platform.packFile), compressed);
    platform.packBytes = compressed.length;
    totalBytes += compressed.length;
  }

  // 8. Detail shards.
  const shards: Record<string, Record<string, unknown>>[] = Array.from({ length: detailShardCount }, () => ({}));
  const names = (ids: number[] | undefined) => (ids ?? []).map((id) => companyNames.get(id)).filter((n) => n !== undefined);
  for (const game of games.values()) {
    const detail: Record<string, unknown> = {};
    if (game.summary) detail.s = game.summary;
    const shots = screenshots.get(game.id);
    if (shots?.length) detail.sc = shots;
    const art = artworks.get(game.id);
    if (art?.length) detail.ar = art;
    const devs = names(developerIDs.get(game.id));
    if (devs.length) detail.dv = devs;
    const pubs = names(publisherIDs.get(game.id));
    if (pubs.length) detail.pb = pubs;
    if (game.rating !== undefined && game.popularity >= 3) detail.rt = game.rating; // ignore ratings from 1–2 votes
    if (game.modes.length) detail.m = game.modes;
    if (game.themes.length) detail.th = game.themes;
    const local = localPlay.get(game.id);
    if (local?.length) detail.lm = local;
    const series = seriesOf.get(game.id);
    if (series !== undefined) detail.se = series;
    const trailer = trailers.get(game.id);
    if (trailer) detail.tr = { y: trailer.y, n: trailer.n };
    const links = related.get(game.id);
    if (links?.length) {
      detail.rl = links.map(({ i, k }) => {
        const other = games.get(i)!;
        const cover = other.coverID !== undefined ? covers.get(other.coverID) : undefined;
        return { i, n: other.name, k, y: firstYear.get(i), p: other.platforms, c: cover };
      });
    }
    if (Object.keys(detail).length > 0) shards[game.id % detailShardCount][game.id] = detail;
  }
  // Each series once, in the shard of its own id (`id % detailShardCount`), under "series".
  const seriesShards: Record<string, unknown>[] = Array.from({ length: detailShardCount }, () => ({}));
  for (const [id, lists] of seriesLists) {
    const entry: Record<string, unknown> = { n: seriesNames.get(id), m: lists.main.sort(byFirstRelease).map(seriesGame) };
    if (lists.remakes.length) {
      entry.r = lists.remakes.sort(byFirstRelease).map((game) => {
        // Follow remakes of remakes back (Resident Evil HD → the 2002 remake → Resident Evil).
        let original = games.get(game)!.originalID;
        for (let step = 0; step < 4 && original !== undefined && !lists.main.includes(original); step++) {
          original = games.get(original)?.originalID;
        }
        return original !== undefined && lists.main.includes(original) ? { ...seriesGame(game), o: original } : seriesGame(game);
      });
    }
    if (lists.spinOffs.length) entry.s = lists.spinOffs.sort(byFirstRelease).map(seriesGame);
    seriesShards[id % detailShardCount][id] = entry;
  }
  let detailBytes = 0;
  shards.forEach((games, index) => {
    const series = seriesShards[index];
    const compressed = deflateRawSync(Buffer.from(JSON.stringify({ format: packFormatVersion, games, series })), { level: 9 });
    writeFileSync(join(paths.packs, `d${index}.pack`), compressed);
    detailBytes += compressed.length;
  });
  log(`wrote ${detailShardCount} detail shards, ${(detailBytes / 1e6).toFixed(1)} MB compressed`);

  const lookup = async (dump: string) => {
    const table: Record<string, string> = {};
    for await (const row of readCSV(dumps(dump))) table[row.id] = row.name;
    return table;
  };
  const genres = await lookup("genres");

  const catalog = {
    format: packFormatVersion,
    generatedAt: new Date().toISOString(),
    attribution: "Game data provided by IGDB.com",
    uniqueGameCount: [...games.values()].filter((g) => g.platforms.length > 0).length,
    genres,
    gameModes: await lookup("game_modes"),
    themes: await lookup("themes"),
    detailShardCount,
    platforms: [...platforms.values()]
      .filter((p) => p.gameCount > 0 || p.models.length > 0)
      .sort((a, b) => (a.family ?? "~").localeCompare(b.family ?? "~") || (a.generation ?? 0) - (b.generation ?? 0) || a.name.localeCompare(b.name)),
  };
  writeFileSync(join(paths.packs, "catalog.json"), JSON.stringify(catalog));
  log(`wrote ${byPlatform.size} packs, ${(totalBytes / 1e6).toFixed(1)} MB compressed total`);

  if (process.argv.includes("--skip-app-copy")) return;
  // Refresh the copy bundled in the iOS app.
  rmSync(appCatalogDir, { recursive: true, force: true });
  cpSync(paths.packs, appCatalogDir, { recursive: true });
  log(`copied packs to ${appCatalogDir}`);
}

await main();
