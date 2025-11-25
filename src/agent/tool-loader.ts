import { BaseTool } from "../tools/BaseTool";
import { RunDiagnosticTool } from "../tools/RunDiagnosticTool";
import { CreateIncidentTicketTool } from "../tools/CreateIncidentTicketTool";
import { LookupUserProfileTool } from "../tools/LookupUserProfileTool";
import { OpnsenseReadOnlyTool } from "../tools/opnsense/readonly";
import { OpnsenseSafeWriteTool } from "../tools/opnsense/writes";
import { ProxmoxReadOnlyTool } from "../tools/proxmox/readonly";
import { ProxmoxWriteTool } from "../tools/proxmox/writes";
import { SSHTool } from "../tools/SSHTool";

export function loadTools(): BaseTool[] {
  return [
    new RunDiagnosticTool(),
    new LookupUserProfileTool(),
    new CreateIncidentTicketTool(),
    new OpnsenseReadOnlyTool(),
    new OpnsenseSafeWriteTool(),
    new ProxmoxReadOnlyTool(),
    new ProxmoxWriteTool(),
    new SSHTool(),
  ];
}

