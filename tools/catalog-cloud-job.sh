#!/usr/bin/env bash
# The catalog job in the cloud (BLUEPRINT D101): run daily by GitHub Actions in the public repo
# indxneo/gamemonster-catalog (.github/workflows/catalog.yml), which tools/sync-catalog-repo.sh
# fills from this repo. Same steps as the Mac's tools/catalog-job.sh, but on an empty machine:
# restore the publish history from the live server, then download IGDB's dumps, build, publish
# behind the shrink gate and deploy. Publishes at most weekly (a catalog younger than
# min_age_hours is left alone), so a run lost or failed one day is simply retried the next.
#
# Secrets come from the environment: TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET (IGDB), and
# CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (wrangler).
# CATALOG_MODE: normal (default) | force (ignore the catalog's age) | dry-run (everything but the deploy).
#
# Exit 0 = nothing to do or published; anything else = failed (GitHub emails the repo owner).

set -euo pipefail
cd "$(dirname "$0")/.."

live_url=https://gamemonster.indxneo.workers.dev/catalog/v1/manifest.json
manifest=data/site/catalog/v1/manifest.json
min_age_hours=156 # 6.5 days: a daily run publishes on the 7th day after the last catalog
mode="${CATALOG_MODE:-normal}"

# Prints "<version> <age in whole hours>" of the live catalog.
live_version() {
  curl -fsS --retry 3 "$live_url" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const m = JSON.parse(s);
      console.log(m.version, Math.floor((Date.now() - Date.parse(m.generatedAt)) / 3_600_000));
    });'
}

read -r version age_hours < <(live_version)
echo "Live: $version ($age_hours hours old). Mode: $mode."
if [[ "$mode" == normal && $age_hours -lt $min_age_hours ]]; then
  echo "Fresh enough; the next catalog goes out once it's $min_age_hours hours old."
  exit 0
fi

node tools/restore-site.ts

# IGDB's download links sometimes drop mid-file (ECONNRESET, 2026-10-18): try three times.
for attempt in 1 2 3; do
  node tools/fetch-dumps.ts && break
  [[ $attempt == 3 ]] && { echo "Couldn't download IGDB's dumps."; exit 1; }
  echo "Download failed; trying again in a minute."
  sleep 60
done
node tools/build-packs.ts --skip-app-copy

before=$(sha256sum < "$manifest")
node tools/publish-catalog.ts # exits 1 when the shrink gate refuses
after=$(sha256sum < "$manifest")
if [[ "$before" == "$after" ]]; then
  # Nothing new, but the server must still serve it (the Worker lost its files once, D100).
  if [[ "$(curl -fsS "$live_url" | sha256sum)" == "$after" ]]; then
    echo "Nothing new to deploy."
    exit 0
  fi
  echo "The live server doesn't serve the current catalog; deploying it again."
fi

if [[ "$mode" == dry-run ]]; then
  echo "Dry run: built and published into data/site/, not deployed. Checking the Cloudflare token instead:"
  (cd proxy && npx --yes wrangler@4 whoami)
  exit 0
fi

(cd proxy && npx --yes wrangler@4 deploy)
# The live manifest must now be the one just published (allow the edge a minute).
for attempt in 1 2 3 4 5 6; do
  if [[ "$(curl -fsS "$live_url" | sha256sum)" == "$after" ]]; then
    echo "Live: $(node -p "require('./$manifest').version")"
    exit 0
  fi
  sleep 10
done
echo "The live manifest doesn't match the one just published."
exit 1
