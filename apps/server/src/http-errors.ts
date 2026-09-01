import type { FastifyError, FastifyInstance, FastifyReply } from "fastify";
import type { ZodError } from "zod";

export type ApiErrorEnvelope = { error: string; code?: string; details?: unknown };

/** Unified 400 body for Zod validation failures: `error` stays a readable message; raw issues move to `details`. */
export function validationFailure(error: ZodError): ApiErrorEnvelope {
  return { error: "Invalid request", code: "validation_error", details: error.issues };
}

export function apiError(reply: FastifyReply, status: number, error: string, code?: string, details?: unknown): FastifyReply {
  return reply.code(status).send({ error, ...(code ? { code } : {}), ...(details === undefined ? {} : { details }) } satisfies ApiErrorEnvelope);
}

/**
 * Single owner of uncaught failures: any route that throws (or a Fastify body
 * parser error) is logged once and answered with the unified envelope instead
 * of the framework default shape.
 */
export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
    if (status >= 500) console.error(`[xiling] ${request.method} ${request.url} failed:`, error instanceof Error ? error.stack ?? error.message : error);
    else console.warn(`[xiling] ${request.method} ${request.url} rejected with ${status}: ${error.message}`);
    const body: ApiErrorEnvelope = status >= 500
      ? { error: "Internal server error", code: "internal_error" }
      : { error: error.message || "Request failed", code: "request_error" };
    void reply.code(status).send(body);
  });
  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({ error: `Route ${request.method}:${request.url} not found`, code: "not_found" } satisfies ApiErrorEnvelope);
  });
}
