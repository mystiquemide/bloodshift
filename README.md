# Bloodshift

Platelets expire about five days after collection. One hospital throws them out while a hospital nearby runs short. Bloodshift reads every hospital's live platelet stock in place through Zetaris, so a network coordinator sees the whole picture on one screen without anyone posting stock by hand.

All hospital data here is synthetic.

## How it works

Each hospital keeps its own system. Site A and Site B run Postgres, and Site C exports a CSV. A mock courier service publishes transport slots over REST. Zetaris federates all four, and the app reads them with one query per source. Nothing is copied or synced, so an edit at a source shows up on the next refresh. If one source is offline, the view names it and keeps showing the rest.

## Run it

You need Node 22+, Docker, and a running Zetaris instance. To run Zetaris yourself, use the Docker Compose bundle from Zetaris Cloud ("Run locally").

```bash
npm install
cp .env.example .env        # fill in the Zetaris login and two site database passwords
npm run sources:up          # Site A, Site B and the courier, on the Zetaris Docker network
npm run seed                # synthetic stock and 30 days of usage, from a fixed seed
npm run register            # registers all four sources in Zetaris
npm start                   # http://localhost:4000
```

`npm test` runs the unit tests. `npm run typecheck` runs the TypeScript checks.

## Try the live read

Change a unit at a source, then click Refresh:

```bash
docker exec bs_site_a psql -U site_a -d site_a \
  -c "UPDATE platelet_units SET status='used' WHERE unit_id='U-A-0112'"
```

Stop a site with `docker stop bs_site_b` to see the partial view, and `docker start bs_site_b` to bring it back.
