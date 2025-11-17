import { BaseTool } from "../tools/BaseTool";
import { GlancesTool } from "../tools/GlancesTool";
import { OpnsenseTool } from "../tools/OpnsenseTool";
import { SSHTool } from "../tools/SSHTool";

export function loadTools(): BaseTool[] {
  return [
    new GlancesTool(),
    new OpnsenseTool(),
    new SSHTool(),
  ];
}

