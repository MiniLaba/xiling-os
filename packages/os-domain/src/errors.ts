// 内核错误：带稳定错误码，供 IPC / UI 层做类型化处理。

export type OsErrorCode =
  | "permission_denied"
  | "illegal_transition"
  | "entity_not_found"
  | "attenuation_denied"
  | "memory_policy_denied"
  | "duplicate_side_effect"
  | "invalid_command"
  | "runtime_not_found";

export class OsError extends Error {
  readonly code: OsErrorCode;
  constructor(code: OsErrorCode, message: string) {
    super(message);
    this.name = "OsError";
    this.code = code;
  }
}

export function entityNotFound(entity: string, id: string): OsError {
  return new OsError("entity_not_found", `${entity} not found: ${id}`);
}

export function permissionDenied(message: string): OsError {
  return new OsError("permission_denied", message);
}
