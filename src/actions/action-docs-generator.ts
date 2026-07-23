import { zodToJsonSchema } from "../tools/tool-schema";
import type { JSONSchemaProperty } from "../tools/tool-schema";
import type { ActionDefinition } from "./registry";

/**
 * Generates a human-readable parameter description string for an action,
 * derived from the action's Zod schema field names and descriptions.
 *
 * This is used to produce the dynamic `.describe()` string on the `params`
 * field in ActionTool's getSchema() — keeping it in sync with the registry
 * automatically as actions evolve.
 */
function generateFieldDoc(key: string, prop: JSONSchemaProperty, isRequired: boolean): string {
  const optional = isRequired ? "" : " (optional)";
  const def = prop.default !== undefined ? ` (default: ${JSON.stringify(prop.default)})` : "";
  const desc = prop.description ? ` — ${prop.description}` : "";
  return `${key}${optional}${def}${desc}`;
}

/**
 * Generates a combined parameter documentation string for all registered actions.
 *
 * Each action contributes one sentence of the form:
 *   "For <action.name>: {field1; field2; ...}. <action.description>"
 *
 * The resulting string is suitable for use as the `.describe()` annotation on
 * the `params` field of the ActionTool schema.
 */
export function generateActionParamsDoc(actions: ActionDefinition[]): string {
  const lines = actions.map((action) => {
    const schema = zodToJsonSchema(action.schema);
    const props = schema.properties ?? {};
    const requiredFields: string[] = schema.required ?? [];

    const fields = Object.entries(props)
      .map(([key, prop]) => generateFieldDoc(key, prop, requiredFields.includes(key)))
      .join("; ");

    return `For ${action.name}: {${fields}}. ${action.description}`;
  });

  return `Action parameters as an object. ${lines.join(" ")} Must be an object.`;
}
