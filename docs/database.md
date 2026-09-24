# Database storage

## Runtime choices

- Local server development defaults to SQLite at `apps/server/data/numeral-lord.sqlite`.
- The production service uses the existing PostgreSQL database `numeral_lord` over its private Unix socket. The PostgreSQL role is mapped to the Linux `numeral-lord` service account with peer authentication; no database password is placed in the repository or exposed to the network.
- Both stores persist the same version-1 JSON records for maps and terrain Mods. SQLite stores them as text; PostgreSQL stores the same payload as text with searchable ID/code/version columns. The browser UI does not execute uploaded Mod source.
- Legacy `data/workshop/workshop.json` files are merged once on first database startup. Existing rows are never truncated or replaced; duplicate records are skipped, and an invalid legacy file stops initialization rather than being discarded.

## Current boundaries

The persistent database currently covers public Workshop submissions. Player names, the browser guest identity, and the personal map library are still held in that browser's `localStorage`; they are not authenticated profiles and do not follow a user to another device. Match snapshots and clocks are live room state in the relay process, not durable match history. Account login, profile/map synchronization, and saved match records need their own data model and API before they can honestly be called database-backed user data.

## Moving local Workshop records to PostgreSQL

From `apps/server`, export the local SQLite content to a new file (the command refuses to overwrite an existing path):

```powershell
pnpm export:workshop -- C:\app\workshop-export.json
```

Copy the export into the destination server's configured `WORKSHOP_DATA_DIR` as `workshop.json`, then start the PostgreSQL-backed service. It imports the records once and records the migration marker in `nl_schema_migrations`. Keep the export until the destination catalog has been verified. Do not replace a populated destination database with a local snapshot.

## Configuration

Local SQLite may be relocated with `LOCAL_DATABASE_PATH`. The Workshop JSON import directory is `WORKSHOP_DATA_DIR` (defaults to `apps/server/data/workshop`). Set `PGHOST` or `DATABASE_URL` to select PostgreSQL; use a private socket or loopback, never expose PostgreSQL to the public internet.
