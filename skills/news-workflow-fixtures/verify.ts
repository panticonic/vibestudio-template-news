import type { NewsWorld } from "./worlds.js";

function record(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

/** Independent scenario verdict. The authored expectation and stable ordering are host evidence. */
export function verifyNewsWorld(world: NewsWorld, candidate: unknown) {
  const actual = record(candidate);
  const findings: unknown = actual?.["findings"];
  const checks = {
    status: actual?.["status"] === world.expected.status,
    findings:
      Array.isArray(findings) &&
      findings.length === world.expected.findings.length &&
      world.expected.findings.every((expected, index) => {
        const row = record(findings[index]);
        return row?.["code"] === expected.code;
      }),
    evidence:
      Array.isArray(findings) &&
      findings.length === world.expected.findings.length &&
      world.expected.findings.every((expected, index) => {
        const ids: unknown = record(findings[index])?.["evidenceIds"];
        return (
          Array.isArray(ids) &&
          ids.length === new Set(ids).size &&
          ids.length === expected.evidenceIds.length &&
          expected.evidenceIds.every((id, idIndex) => ids[idIndex] === id)
        );
      }),
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}
