import { BaseTool } from "./BaseTool";
import {
  LookupUserProfileParams,
  LookupUserProfileJSONSchema,
  type LookupUserProfileParamsType,
} from "./schemas/user-profile";
import type { ExecutionContext, ExecutionResult } from "../types";

interface DirectoryEntry {
  employeeId: string;
  username: string;
  email: string;
  fullName: string;
  department: string;
  roles: string[];
  skills: string[];
  phone?: string;
  manager: string;
  onCall: boolean;
  lastLogin: string;
  access: string[];
  location: string;
}

const DIRECTORY: DirectoryEntry[] = [
  {
    employeeId: "E-1042",
    username: "jdoe",
    email: "jdoe@example.com",
    fullName: "Jordan Doe",
    department: "Network Operations",
    roles: ["sre", "oncall"],
    skills: ["firewall", "linux"],
    phone: "+1-415-555-0110",
    manager: "E-1001",
    onCall: true,
    lastLogin: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
    access: ["grafana", "neo4j", "qdrant"],
    location: "SFO",
  },
  {
    employeeId: "E-1077",
    username: "asmith",
    email: "asmith@example.com",
    fullName: "Alex Smith",
    department: "Security Engineering",
    roles: ["security", "incident"],
    skills: ["threat-hunting", "iam"],
    phone: "+1-212-555-0198",
    manager: "E-1002",
    onCall: false,
    lastLogin: new Date(Date.now() - 1000 * 60 * 60 * 12).toISOString(),
    access: ["splunk", "vault"],
    location: "NYC",
  },
  {
    employeeId: "E-1090",
    username: "khu",
    email: "khu@example.com",
    fullName: "Kim Hu",
    department: "Platform",
    roles: ["devops"],
    skills: ["kubernetes", "terraform"],
    manager: "E-1003",
    onCall: false,
    lastLogin: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    access: ["argocd", "pagerduty"],
    location: "Remote",
  },
];

const FIELD_MAP: Record<LookupUserProfileParamsType["identifierType"], keyof DirectoryEntry> = {
  email: "email",
  username: "username",
  employee_id: "employeeId",
};

export class LookupUserProfileTool extends BaseTool {
  constructor() {
    super({
      name: "lookup_user_profile",
      description: "Fetches user directory details (roles, on-call status, access scopes)",
      categories: ["user-intel", "security"],
      parameters: LookupUserProfileJSONSchema,
      allowedAcls: ["admin", "ops", "security", "helpdesk", "sre"],
      risk: "medium",
    });
  }

  async execute(params: Record<string, any>, context: ExecutionContext): Promise<ExecutionResult> {
    const parsed = LookupUserProfileParams.safeParse(params);
    if (!parsed.success) {
      return { error: parsed.error.message };
    }

    const started = context.startedAt ?? Date.now();
    const payload = parsed.data;
    const lookupField = FIELD_MAP[payload.identifierType];
    const normalizedIdentifier = payload.identifier.trim().toLowerCase();
    const entry = DIRECTORY.find((record) => record[lookupField].toLowerCase() === normalizedIdentifier);

    if (!entry) {
      return {
        error: "No matching profile found",
        durationMs: Date.now() - started,
      };
    }

    const profile = this.buildResponse(entry, payload);

    return {
      data: profile,
      durationMs: Date.now() - started,
    };
  }

  private buildResponse(entry: DirectoryEntry, payload: LookupUserProfileParamsType) {
    return {
      employeeId: entry.employeeId,
      username: entry.username,
      fullName: entry.fullName,
      department: entry.department,
      roles: entry.roles,
      skills: entry.skills,
      onCall: entry.onCall,
      location: entry.location,
      lastLogin: entry.lastLogin,
      contact: payload.includeContact
        ? {
            email: entry.email,
            phone: entry.phone ?? null,
          }
        : undefined,
      access: payload.includeAccess ? entry.access : undefined,
      manager: entry.manager,
      provenance: "directory-cache",
    };
  }
}
