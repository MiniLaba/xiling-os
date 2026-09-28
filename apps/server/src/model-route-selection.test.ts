import { describe, expect, it } from "vitest";
import type { ModelRouteSettings } from "@xiling/contracts";
import { chooseAutomaticModel, selectModelRoute } from "./model-route-selection.js";

const route = (modelId: string): ModelRouteSettings => ({ providerId: "openrouter", modelId, reasoning: "medium" });

describe("model route selection", () => {
  it("uses a Chat turn override without changing the persisted primary route", () => {
    const primary = route("primary");
    expect(selectModelRoute({ primary, roleRoutes: {} }, { turnOverride: route("turn") })).toMatchObject({ source: "turn", route: { modelId: "turn" } });
    expect(primary.modelId).toBe("primary");
  });

  it("uses a role-specific route for child Agents even if a turn override is present", () => {
    expect(selectModelRoute({ primary: route("primary"), roleRoutes: { "independent-reviewer": route("review") } }, { roleId: "independent-reviewer", turnOverride: route("turn") })).toMatchObject({ source: "role", route: { modelId: "review" } });
  });

  it("lets an unassigned child Agent inherit the primary route", () => {
    expect(selectModelRoute({ primary: route("primary"), roleRoutes: {} }, { roleId: "domain-executor" })).toMatchObject({ source: "primary", route: { modelId: "primary" } });
  });

  it("returns an explicit missing state instead of selecting a fixture", () => {
    expect(selectModelRoute({ roleRoutes: {} }, {})).toEqual({ source: "missing" });
  });

  it("picks an affordable model from the user-specified providers that can accept the required modalities", () => {
    const catalog = [
      { providerId: "openai" as const, id: "text-only", inputModalities: ["text" as const], outputUsdPerMillion: 1 },
      { providerId: "anthropic" as const, id: "vision", inputModalities: ["text" as const, "image" as const], outputUsdPerMillion: 2 },
      { providerId: "google" as const, id: "expensive-vision", inputModalities: ["text" as const, "image" as const], outputUsdPerMillion: 40 },
    ];
    expect(chooseAutomaticModel({ providers: ["anthropic", "google"], requiredModalities: ["text", "image"], costCapUsd: 0.05, catalog })).toMatchObject({ providerId: "anthropic", modelId: "vision" });
    expect(chooseAutomaticModel({ providers: ["openai"], requiredModalities: ["text", "image"], costCapUsd: 10, catalog })).toBeUndefined();
  });
});
