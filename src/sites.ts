// The network: three hospitals, each with its own system, plus the courier.
export type SiteId = "SITE_A" | "SITE_B" | "SITE_C";

export interface Site {
  id: SiteId;
  name: string;
  system: string;
  // Zetaris namespace the site's tables are registered under
  zetarisSource: string;
}

export const SITES: Site[] = [
  { id: "SITE_A", name: "Northgate General", system: "Postgres (Site A LIS)", zetarisSource: "bs_site_a" },
  { id: "SITE_B", name: "Riverside Medical", system: "Postgres (Site B LIS)", zetarisSource: "bs_site_b" },
  { id: "SITE_C", name: "Hillcrest Community", system: "CSV export (Site C)", zetarisSource: "bs_site_c" },
];

export const COURIER_SOURCE = "bs_courier";
