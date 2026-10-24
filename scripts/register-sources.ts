// Registers the four sources in Zetaris. Safe to re-run: existing registrations are kept.
// Writes stay with each site. Zetaris only gets read access.
import { loadEnv, optional, required } from "../src/config.js";
import { ZetarisClient, ZetarisError } from "../src/zetaris.js";

loadEnv();

const zetaris = new ZetarisClient({
  baseUrl: optional("ZETARIS_BASE_URL", "http://localhost:3000"),
  username: required("ZETARIS_USERNAME"),
  password: required("ZETARIS_PASSWORD"),
  orgId: process.env.ZETARIS_ORG_ID,
});

const siteCDir = optional("SITE_C_DIR", "/home/zetaris/customer-data/shared/bloodshift/site_c");

// Values are embedded in Zetaris DDL, which has no bind parameters. Reject anything
// that could break out of a double-quoted option.
function opt(value: string): string {
  if (/["\\\n]/.test(value)) throw new Error(`Unsafe character in Zetaris option value: ${value}`);
  return `"${value}"`;
}

function postgresSource(name: string, host: string, db: string, userVar: string, passVar: string, userDefault: string) {
  return `CREATE DATASOURCE ${name} DESCRIBE BY 'Bloodshift ${db}, synthetic' OPTIONS (
    jdbcdriver "org.postgresql.Driver",
    jdbcurl ${opt(`jdbc:postgresql://${host}:5432/${db}`)},
    username ${opt(optional(userVar, userDefault))},
    password ${opt(required(passVar))}
  )`;
}

const steps: { label: string; sql: string }[] = [
  { label: "Site A datasource", sql: postgresSource("bs_site_a", "bs_site_a", "site_a", "SITE_A_USER", "SITE_A_PASSWORD", "site_a") },
  { label: "Site A units", sql: `REGISTER DATASOURCE TABLE 'platelet_units' FROM bs_site_a` },
  { label: "Site A usage", sql: `REGISTER DATASOURCE TABLE 'usage_history' FROM bs_site_a` },
  { label: "Site B datasource", sql: postgresSource("bs_site_b", "bs_site_b", "site_b", "SITE_B_USER", "SITE_B_PASSWORD", "site_b") },
  { label: "Site B units", sql: `REGISTER DATASOURCE TABLE 'platelet_units' FROM bs_site_b` },
  { label: "Site B usage", sql: `REGISTER DATASOURCE TABLE 'usage_history' FROM bs_site_b` },
  { label: "Site C database", sql: `CREATE LIGHTNING DATABASE bs_site_c DESCRIBE BY 'Bloodshift Site C CSV export, synthetic'` },
  {
    label: "Site C units",
    sql: `CREATE LIGHTNING FILESTORE TABLE platelet_units FROM bs_site_c FORMAT CSV OPTIONS (path ${opt(`file://${siteCDir}/units.csv`)}, header "true", inferSchema "true")`,
  },
  {
    label: "Site C usage",
    sql: `CREATE LIGHTNING FILESTORE TABLE usage_history FROM bs_site_c FORMAT CSV OPTIONS (path ${opt(`file://${siteCDir}/usage.csv`)}, header "true", inferSchema "true")`,
  },
  { label: "Courier database", sql: `CREATE LIGHTNING DATABASE bs_courier DESCRIBE BY 'Bloodshift mock courier service'` },
  {
    label: "Courier slots",
    sql: `CREATE LIGHTNING REST TABLE slots FROM bs_courier REQUEST (endpoint "http://bs_courier:8080/slots", method "GET", http_encoding "URLENCODED", response_type "JSON", insecure_ssl "false") HEADER () BODY ()`,
  },
];

const ALREADY = /already exist|duplicate|exists/i;

async function main() {
  for (const step of steps) {
    try {
      await zetaris.query(step.sql);
      console.log(`registered  ${step.label}`);
    } catch (err) {
      if (err instanceof ZetarisError && err.kind === "query" && ALREADY.test(err.message)) {
        console.log(`kept        ${step.label} (already registered)`);
        continue;
      }
      throw err;
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
