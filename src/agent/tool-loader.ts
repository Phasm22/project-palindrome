import { BaseTool } from "../tools/BaseTool";
import { RunDiagnosticTool } from "../tools/RunDiagnosticTool";
import { InfrastructureDiagnosticTool } from "../tools/InfrastructureDiagnosticTool";
import { CreateIncidentTicketTool } from "../tools/CreateIncidentTicketTool";
import { LookupUserProfileTool } from "../tools/LookupUserProfileTool";
import { OpnsenseReadOnlyTool } from "../tools/opnsense/readonly";
import { OpnsenseSafeWriteTool } from "../tools/opnsense/writes";
import { ProxmoxReadOnlyTool } from "../tools/proxmox/readonly";
import { ProxmoxWriteTool } from "../tools/proxmox/writes";
import { SSHTool } from "../tools/SSHTool";
import { MCPOpnsenseTool } from "../tools/MCPOpnsenseTool";
import { TwinQueryTool } from "../tools/TwinQueryTool";
import { ActionTool } from "../tools/ActionTool";
import { SummarizeObservationsTool } from "../tools/SummarizeObservationsTool";
import { NextStepsTool } from "../tools/NextStepsTool";
import { AskMissingTool } from "../tools/AskMissingTool";

export function loadTools(): BaseTool[] {
  return [
    new SummarizeObservationsTool(),
    new NextStepsTool(),
    new AskMissingTool(),
    new RunDiagnosticTool(),
    new InfrastructureDiagnosticTool(),
    new LookupUserProfileTool(),
    new CreateIncidentTicketTool(),
    new OpnsenseReadOnlyTool(),
    new OpnsenseSafeWriteTool(),
    new ProxmoxReadOnlyTool(),
    new ProxmoxWriteTool(),
    new SSHTool(),
    new MCPOpnsenseTool(),
    new TwinQueryTool(),
    new ActionTool(),
  ];
}

