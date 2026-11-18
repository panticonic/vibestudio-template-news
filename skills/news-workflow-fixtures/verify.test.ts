import { expect, it } from "vitest";
import { verifyNewsWorld } from "./verify.js";
import { newsWorlds } from "./worlds.js";

function collectEvidence(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectEvidence);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, body]) =>
    (key === "id" || key === "briefingId") && typeof body === "string"
      ? [body]
      : collectEvidence(body),
  );
}

it("keeps scenario keys unique and covers all News workflow branches", () => {
  expect(new Set(newsWorlds.map((world) => world.id)).size).toBe(
    newsWorlds.length,
  );
  expect(new Set(newsWorlds.map((world) => world.request.kind))).toEqual(
    new Set(["reader", "triage", "briefing", "deep-dive", "schedule"]),
  );
});

it.each(newsWorlds)(
  "$id passes its reference and alias and rejects broken attribution",
  (world) => {
    const seen = new Set(collectEvidence(world.request));
    for (const finding of world.expected.findings) {
      expect(finding.evidenceIds.length).toBeGreaterThan(0);
      expect(finding.evidenceIds.every((id) => seen.has(id))).toBe(true);
    }
    expect(verifyNewsWorld(world, world.expected).passed).toBe(true);
    const negative = structuredClone(world.expected);
    negative.findings[0]!.evidenceIds[0] = "unscoped-decoy";
    expect(verifyNewsWorld(world, negative).passed).toBe(false);

    const aliases = new Map(
      [...seen].map((id, index) => [id, `alias-${index}`]),
    );
    const alias = JSON.parse(
      JSON.stringify(world, (_key, value: unknown) =>
        typeof value === "string" ? (aliases.get(value) ?? value) : value,
      ),
    ) as typeof world;
    expect(verifyNewsWorld(alias, alias.expected).passed).toBe(true);
    expect(verifyNewsWorld(alias, world.expected).passed).toBe(false);
  },
);
