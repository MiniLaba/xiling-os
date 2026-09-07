import { UI_COMPONENT_VERSION, type UIAction, type UISurfaceKind } from "@xiling/os-domain";
import { OsError } from "@xiling/os-domain";

type Validator = (value: unknown) => boolean;

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const array = (value: unknown): value is unknown[] => Array.isArray(value);

const validators: Partial<Record<UISurfaceKind, Validator>> = {
  approval: object,
  table: (value) => object(value) && array(value.columns) && value.columns.every((item) => string(item) || (object(item) && string(item.id) && string(item.label))) && array(value.rows) && value.rows.every(object),
  form: (value) => object(value) && array(value.fields) && value.fields.every((item) => object(item) && string(item.id) && string(item.label) && ["text", "number", "select", "checkbox", "textarea"].includes(String(item.type)) && (item.type !== "select" || (array(item.options) && item.options.length > 0 && item.options.every(string)))),
  comparison: (value) => object(value) && array(value.items) && value.items.every((item) => object(item) && string(item.label)),
  diff: (value) => object(value) && string(value.before) && string(value.after),
  chart: (value) => object(value) && ["line", "bar", "scatter"].includes(String(value.type)) && array(value.series) && value.series.length > 0 && value.series.length <= 40 && value.series.every((point) => object(point) && string(point.label) && typeof point.value === "number" && Number.isFinite(point.value)),
  artifact: (value) => object(value) && string(value.artifactId),
  task_board: (value) => object(value) && array(value.columns) && value.columns.every((item) => object(item) && string(item.id) && string(item.title) && array(item.tasks)),
};

export class TrustedUIRegistry {
  validate(kind: UISurfaceKind, version: number, data: unknown, actions: UIAction[]): void {
    if (version !== UI_COMPONENT_VERSION) throw new OsError("invalid_command", `不支持的 UI 组件版本 ${version}`);
    const validator = validators[kind];
    if (!validator) throw new OsError("invalid_command", `UI 组件 ${kind} 未注册`);
    if (!validator(data)) throw new OsError("invalid_command", `UI 组件 ${kind} 的数据不符合可信契约`);
    const ids = new Set<string>();
    for (const action of actions) {
      if (!action.id.trim() || ids.has(action.id)) throw new OsError("invalid_command", `UI 组件 ${kind} 含有空白或重复 action id`);
      ids.add(action.id);
      if (!action.label.trim() || action.label.length > 80) throw new OsError("invalid_command", `UI action ${action.id} 标签无效`);
    }
  }

  validateActionInput(schema: unknown, input: unknown): void {
    if (schema === undefined) return;
    if (!matchesSchema(schema, input)) throw new OsError("invalid_command", "UI action 输入不符合声明的结构");
  }
}

function matchesSchema(schema: unknown, value: unknown): boolean {
  if (!object(schema)) return false;
  if (array(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) return false;
  if (schema.type === "string") return string(value) && (typeof schema.maxLength !== "number" || value.length <= schema.maxLength);
  if (schema.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (schema.type === "integer") return Number.isInteger(value);
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "array") return array(value) && (schema.items === undefined || value.every((item) => matchesSchema(schema.items, item)));
  if (schema.type === "object") {
    if (!object(value)) return false;
    const properties = object(schema.properties) ? schema.properties : {};
    if (array(schema.required) && schema.required.some((key) => !string(key) || !(key in value))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !(key in properties))) return false;
    return Object.entries(properties).every(([key, child]) => !(key in value) || matchesSchema(child, value[key]));
  }
  return false;
}
