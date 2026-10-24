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

// Per-site rule settings. Both values are Assumed until checked against a transfusion guideline.
export const SITE_POLICIES: Record<SiteId, { safetyStock: number; needsIrradiated: boolean }> = {
  SITE_A: { safetyStock: 1, needsIrradiated: false },
  // Riverside runs the oncology unit, so it's the site flagged for irradiated platelets
  SITE_B: { safetyStock: 1, needsIrradiated: true },
  SITE_C: { safetyStock: 1, needsIrradiated: false },
};

// ABO and Rh mix of platelet supply, used by the seed and the simulation
export const BLOOD_GROUPS: [string, string, number][] = [
  // abo, rh, share of supply
  ["O", "+", 0.38], ["A", "+", 0.32], ["B", "+", 0.1], ["O", "-", 0.07],
  ["A", "-", 0.06], ["AB", "+", 0.04], ["B", "-", 0.02], ["AB", "-", 0.01],
];
