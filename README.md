# Bloodshift

Platelets expire about five days after collection. One hospital throws them out while a hospital nearby runs short. Bloodshift reads every hospital's live platelet stock in place through Zetaris, proposes transfers that would prevent waste, and moves a unit only after re-checking the sending hospital's own record.

All hospital data here is synthetic, and the courier is a mock service.

## How it works

1. **Live stock.** Site A and Site B run Postgres, Site C exports a CSV, and a courier service publishes transport slots over REST. Zetaris federates all four. Nothing is copied or synced.
2. **Morning plan.** A deterministic rule projects which units will expire unused and finds transfers that pass every business rule, including a published platelet ABO and RhD selection policy. NVIDIA Nemotron chooses among those options and writes the requests. It can't add a unit, site or slot, and its output is validated.
3. **Accept.** The receiving lab accepts from its inbox. Bloodshift re-reads the unit and the slot through Zetaris. If either changed, the transfer is refused and a replacement is offered. Otherwise the unit is reserved in the sending hospital's own system and the courier is booked.
4. **Decline.** A lab can decline with a reason. The reason is kept in Meterless H-MEM, and the unit is replanned to another site.

Transfer history is an event log in the Meterless World Model, so it survives refreshes and restarts.

## Run it

You need Node 22+, Docker, and a running Zetaris instance. To run Zetaris yourself, use the Docker Compose bundle from Zetaris Cloud ("Run locally"). An NVIDIA API key from build.nvidia.com is optional. Without it, requests use a standard template.

```bash
npm install
cp .env.example .env        # Zetaris login, two site database passwords, optional NVIDIA_API_KEY
npm run sources:up          # Site A, Site B and the courier, on the Zetaris Docker network
npm run seed                # synthetic stock and 30 days of usage, from a fixed seed
npm run register            # registers all four sources in Zetaris
npm start                   # http://localhost:4000, the app is at /app
```

Use "View as" to switch between the network coordinator and each hospital's lab.

### On a server

`infra/deploy.sh` sets up Zetaris and Bloodshift on one Ubuntu 24.04 server. Download `zetaris-platform.zip` from Zetaris Cloud ("Run locally") onto the server, then:

```bash
git clone https://github.com/mystiquemide/bloodshift.git && cd bloodshift
sudo ZETARIS_ZIP=/root/zetaris-platform.zip MODE=standalone bash infra/deploy.sh
```

It asks for a Zetaris admin password, an optional NVIDIA key and the Zetaris registry login, keeps Zetaris on 127.0.0.1, and serves Bloodshift over HTTPS at `bloodshift.<ip>.sslip.io`. Use `MODE=proxy` when another reverse proxy already holds ports 80 and 443. The server needs about 4 GB of free memory and 15 GB of disk.

## Try it

- **Live read.** Change a unit at its source, then click Refresh:
  ```bash
  docker exec bs_site_a psql -U site_a -d site_a \
    -c "UPDATE platelet_units SET status='used' WHERE unit_id='U-A-0112'"
  ```
- **Plan and accept.** As the coordinator, run the morning plan and send the requests. Switch to Riverside Medical and accept one. Site A's table and the courier's slot both change.
- **Refusal.** Mark a requested unit `used` with the command above, then accept it. It's refused with Site A's reason, nothing is written, and another unit is offered.
- **Partial view.** `docker stop bs_site_b` shows the other sites with Riverside marked unavailable. `docker start bs_site_b` brings it back.

## Checks

| Command | What it does |
|---|---|
| `npm test` | Unit tests, including one passing and one failing case per business rule |
| `npm run typecheck` | TypeScript checks |
| `npm run simulate` | 30-day simulation of the rule against no sharing, over 20 seeds by default. `npm run simulate -- 100` for more |
| `npm run eval:declines` | 10 decline scenarios against the live Nemotron model |
| `npm run screenshots` | Recaptures the landing page images from the running app. Needs Playwright and one reserved transfer |

## Results so far

- In simulation, the rule cuts outdated platelets by 12.8% against no sharing over the 20 runs shown on the Simulation page, and 11.6% over 100 runs. Outdates of the most common groups, O+ and A+, fall by about a third, with slightly fewer shortages. The simulation uses synthetic demand and isn't a measured result.
- The decline evaluation gave valid replans in 8 to 10 of 10 scenarios per run, including a reason that tries to inject instructions.

## Limits

- Writes go to each hospital's system through small adapters, not through Zetaris. Hospitals keep write control, and Zetaris only reads.
- The lab switcher has no sign-in. It's a demo of the workflow, not an access-controlled product.
- Platelet selection follows the SNBTS Policy for Platelet Selection (2014). Check current national guidance before any clinical use.
