# GameMonster catalog job

Builds the game list that the GameMonster iPhone app downloads, from [IGDB](https://www.igdb.com)'s
daily data dumps, and publishes it to `https://gamemonster.indxneo.workers.dev/catalog/v1/`.

- `.github/workflows/catalog.yml` runs it every day; it publishes when the live list is a week old.
- `status.json` is the list that's live now (updated by the job).
- **Don't edit files here.** They're copied from the app's private repository by
  `tools/sync-catalog-repo.sh`; change them there and sync.

Game data courtesy of IGDB.
