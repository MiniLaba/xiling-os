import { createApp } from "../../apps/server/dist/app.js";

/**
 * createApp with the local access token wired into non-GET injects, so smoke
 * scripts exercise the same authenticated control plane as the real Web client.
 */
export function createSmokeApp(options) {
  const app = createApp(options);
  const rawInject = app.inject.bind(app);
  const token = app.localAccessToken;
  app.inject = (injectOptions) => {
    const method = String(injectOptions.method ?? "GET").toUpperCase();
    const headers = injectOptions.headers ?? {};
    if (method !== "GET" && method !== "HEAD" && !headers["x-xiling-token"]) {
      return rawInject({ ...injectOptions, headers: { ...headers, "x-xiling-token": token } });
    }
    return rawInject(injectOptions);
  };
  return app;
}
