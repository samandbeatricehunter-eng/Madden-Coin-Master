# Companion Import Endpoint

Public API base:

```text
https://workspaceapi-server-production-455d.up.railway.app/api
```

Canonical companion schedule endpoint:

```text
POST https://workspaceapi-server-production-455d.up.railway.app/api/imports/companion/<guildId>/schedule
```

For REC League:

```text
https://workspaceapi-server-production-455d.up.railway.app/api/imports/companion/1493688089883971735/schedule?secret=<REC_IMPORT_SECRET>
```

Preferred security is the header:

```text
x-rec-import-secret: <REC_IMPORT_SECRET>
```

The query-string `secret` is supported for exporter apps that cannot set custom headers.

Body can be either the raw Madden Companion payload or:

```json
{
  "platform": "pc",
  "leagueId": 123456,
  "weekType": "reg",
  "weekNumber": 10,
  "payload": { "scheduleInfoList": [] }
}
```

Schedule payloads are written through the canonical writer into `rec_league_games` and tracked in `rec_import_jobs` / `rec_import_payloads`.

Other payload types are accepted and stored for audit while canonical roster/stat writers are completed.
