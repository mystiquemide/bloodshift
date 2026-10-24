// Platelet ABO and RhD selection, from the SNBTS Policy for Platelet Selection
// (NATP CLIN 10 003 04, Table 1 and section 3), which follows the BCSH guideline
// for the use of platelet transfusions:
// https://www.nss.nhs.scot/media/1014/policy-for-platelet-selection.pdf
//
// - ABO identical first. Non-identical is acceptable practice and reduces wastage.
// - Group O platelets go to non-O patients only as a last resort in a clinical emergency.
//   A planned rebalance is never that, so O is never offered to A, B or AB patients here.
// - RhD-negative patients get RhD-negative platelets. Patient sex and age aren't known,
//   so RhD-positive units are never issued to RhD-negative patients.

const ABO_CHOICES: Record<string, string[]> = {
  O: ["O", "A", "B"],
  A: ["A", "B"],
  B: ["B", "A"],
  AB: ["AB", "A", "B"],
};

// Unit groups a patient group can receive, best first
export function acceptableFor(patient: string): string[] {
  const m = patient.match(/^(O|A|B|AB)([+-])$/);
  if (!m) throw new Error(`Unknown blood group ${patient}`);
  const [, abo, rh] = m as unknown as [string, string, string];
  const rhs = rh === "+" ? ["+", "-"] : ["-"];
  return ABO_CHOICES[abo]!.flatMap((a) => rhs.map((r) => `${a}${r}`));
}

// Patient groups that can receive a unit of this group
export function recipientsOf(unitGroup: string, patientGroups: string[]): string[] {
  return patientGroups.filter((p) => acceptableFor(p).includes(unitGroup));
}
