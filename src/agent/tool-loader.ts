import { BaseTool } from "../tools/BaseTool";
import { GlancesTool } from "../tools/GlancesTool";

export function loadTools(): BaseTool[] {
  return [
    new GlancesTool()
    // future tools go here
  ];
}

