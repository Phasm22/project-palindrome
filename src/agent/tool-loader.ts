import { BaseTool } from "../tools/BaseTool";
import { GlancesTool } from "../tools/GlancesTool";
import { RunDiagnosticTool } from "../tools/RunDiagnosticTool";
import { CreateIncidentTicketTool } from "../tools/CreateIncidentTicketTool";
import { LookupUserProfileTool } from "../tools/LookupUserProfileTool";

export function loadTools(): BaseTool[] {
  return [
    new GlancesTool(),
    new RunDiagnosticTool(),
    new LookupUserProfileTool(),
    new CreateIncidentTicketTool(),
  ];
}

