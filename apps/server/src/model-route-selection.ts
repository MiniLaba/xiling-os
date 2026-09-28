import type { ModelCatalogEntry, ModelProviderId, ModelRouteSettings } from "@xiling/contracts";

export type ModelRouteSource = "turn" | "role" | "primary" | "missing";

export function selectModelRoute(
  routes: { primary?: ModelRouteSettings; roleRoutes: Record<string, ModelRouteSettings> },
  request: { roleId?: string; turnOverride?: ModelRouteSettings },
): { route?: ModelRouteSettings; source: ModelRouteSource } {
  if (request.roleId) {
    const roleRoute = routes.roleRoutes[request.roleId];
    if (roleRoute) return { route: roleRoute, source: "role" };
    return routes.primary ? { route: routes.primary, source: "primary" } : { source: "missing" };
  }
  if (request.turnOverride) return { route: request.turnOverride, source: "turn" };
  return routes.primary ? { route: routes.primary, source: "primary" } : { source: "missing" };
}

const DEFAULT_OUTPUT_USD_PER_MILLION = 5;
const ESTIMATED_OUTPUT_TOKENS = 2_000;

export function chooseAutomaticModel(input: {
  providers: ModelProviderId[];
  requiredModalities: Array<"text" | "image">;
  costCapUsd: number;
  catalog: Array<Pick<ModelCatalogEntry, "providerId" | "id" | "inputModalities"> & { outputUsdPerMillion?: number }>;
}): { providerId: ModelProviderId; modelId: string; estimatedUsd: number } | undefined {
  const allowed = new Set(input.providers);
  const ranked = input.catalog
    .filter((model) => allowed.has(model.providerId))
    .filter((model) => input.requiredModalities.every((modality) => model.inputModalities.includes(modality)))
    .map((model) => ({
      providerId: model.providerId,
      modelId: model.id,
      estimatedUsd: ((model.outputUsdPerMillion ?? DEFAULT_OUTPUT_USD_PER_MILLION) * ESTIMATED_OUTPUT_TOKENS) / 1_000_000,
    }))
    .filter((model) => model.estimatedUsd <= input.costCapUsd)
    .sort((left, right) => left.estimatedUsd - right.estimatedUsd || left.providerId.localeCompare(right.providerId) || left.modelId.localeCompare(right.modelId));
  return ranked[0];
}
