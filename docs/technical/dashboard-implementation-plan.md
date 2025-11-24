# Dashboard Implementation Plan

## Phase 1: Foundation (Week 1) - Critical Prerequisites

### 1.1 Persistent Tool Execution Store

**File:** `src/pce/api/tool-execution-store.ts`

```typescript
import { Database } from "bun:sqlite";
import type { ExecutionResult, ACLGroup } from "../../types";

export interface ToolExecution {
  id: string;
  toolName: string;
  parameters: Record<string, any>;
  result: ExecutionResult;
  userId: string;
  aclGroup: ACLGroup;
  durationMs: number;
  timestamp: Date;
  error?: string;
}

export class ToolExecutionStore {
  private db: Database;

  constructor(dbPath: string = ".pce-dashboard/tool-executions.db") {
    this.db = new Database(dbPath);
    this.initializeSchema();
  }

  private initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_executions (
        id TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        parameters TEXT NOT NULL,
        result_data TEXT,
        result_error TEXT,
        user_id TEXT NOT NULL,
        acl_group TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        timestamp INTEGER NOT NULL
      );
      
      CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_executions(tool_name);
      CREATE INDEX IF NOT EXISTS idx_user_id ON tool_executions(user_id);
      CREATE INDEX IF NOT EXISTS idx_timestamp ON tool_executions(timestamp);
    `);
  }

  async recordExecution(execution: Omit<ToolExecution, "id">): Promise<void> {
    const id = crypto.randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO tool_executions 
      (id, tool_name, parameters, result_data, result_error, user_id, acl_group, duration_ms, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      id,
      execution.toolName,
      JSON.stringify(execution.parameters),
      execution.result.data ? JSON.stringify(execution.result.data) : null,
      execution.result.error || null,
      execution.userId,
      execution.aclGroup,
      execution.durationMs,
      execution.timestamp.getTime()
    );
  }

  async getExecutions(filters: {
    toolName?: string;
    userId?: string;
    since?: Date;
    limit?: number;
  }): Promise<ToolExecution[]> {
    let query = "SELECT * FROM tool_executions WHERE 1=1";
    const params: any[] = [];

    if (filters.toolName) {
      query += " AND tool_name = ?";
      params.push(filters.toolName);
    }

    if (filters.userId) {
      query += " AND user_id = ?";
      params.push(filters.userId);
    }

    if (filters.since) {
      query += " AND timestamp >= ?";
      params.push(filters.since.getTime());
    }

    query += " ORDER BY timestamp DESC LIMIT ?";
    params.push(filters.limit || 100);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    return rows.map(row => ({
      id: row.id,
      toolName: row.tool_name,
      parameters: JSON.parse(row.parameters),
      result: {
        data: row.result_data ? JSON.parse(row.result_data) : undefined,
        error: row.result_error || undefined,
      },
      userId: row.user_id,
      aclGroup: row.acl_group as ACLGroup,
      durationMs: row.duration_ms,
      timestamp: new Date(row.timestamp),
    }));
  }

  async getExecutionStats(since?: Date): Promise<{
    total: number;
    byTool: Record<string, number>;
    byUser: Record<string, number>;
    errorRate: number;
  }> {
    // Implementation for stats aggregation
    // ...
  }
}
```

### 1.2 Integrate Tool Execution Store into Tool Executor

**File:** `src/agent/tool-executor.ts` (modify)

```typescript
import { ToolExecutionStore } from "../pce/api/tool-execution-store";

// Add singleton instance
const toolExecutionStore = new ToolExecutionStore();

export async function executeToolCall(
  call: ToolCall,
  tools: BaseTool[],
  context?: { userId?: string; aclGroup?: ACLGroup }
): Promise<ExecutionResult> {
  const tool = tools.find(t => t.metadata.name === call.toolName);
  if (!tool) {
    logger.error(`Tool not found: ${call.toolName}`);
    return { error: `Unknown tool: ${call.toolName}` };
  }

  const executionContext: ExecutionContext = {
    toolName: call.toolName,
    startedAt: Date.now(),
  };

  logger.info(`Executing tool: ${call.toolName}`);
  
  const startTime = Date.now();
  const result = await tool.execute(call.parameters ?? {}, executionContext);
  const durationMs = Date.now() - startTime;
  
  // Record execution for dashboard
  if (context?.userId) {
    await toolExecutionStore.recordExecution({
      toolName: call.toolName,
      parameters: call.parameters ?? {},
      result,
      userId: context.userId,
      aclGroup: context.aclGroup || "viewer",
      durationMs,
      timestamp: new Date(),
    });
  }
  
  if (result.error) {
    logger.error(`Tool execution failed: ${call.toolName}`, {
      error: result.error,
    });
  }
  
  return result;
}
```

### 1.3 Add Dashboard API Endpoints

**File:** `src/pce/api/server.ts` (add new routes)

```typescript
// Add to handleRequest method:
if (req.method === "GET" && url.pathname === "/api/dashboard/tool-executions") {
  return await this.handleToolExecutions(req);
}

if (req.method === "GET" && url.pathname === "/api/dashboard/cluster-status") {
  return await this.handleClusterStatus(req);
}

if (req.method === "GET" && url.pathname === "/api/dashboard/ontology-graph") {
  return await this.handleOntologyGraph(req);
}

if (req.method === "GET" && url.pathname === "/api/dashboard/vector-stats") {
  return await this.handleVectorStats(req);
}

// Add handler methods:
private async handleToolExecutions(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const toolName = url.searchParams.get("toolName");
  const userId = url.searchParams.get("userId");
  const since = url.searchParams.get("since");
  const limit = parseInt(url.searchParams.get("limit") || "100");

  const store = new ToolExecutionStore();
  const executions = await store.getExecutions({
    toolName: toolName || undefined,
    userId: userId || undefined,
    since: since ? new Date(since) : undefined,
    limit,
  });

  return this.jsonResponse(200, { executions });
}

private async handleClusterStatus(req: Request): Promise<Response> {
  // Aggregate Proxmox cluster status
  // Call proxmox_readonly tool internally or use ProxmoxClient directly
  // Return: { nodes: [...], vms: [...], alerts: [...] }
}

private async handleOntologyGraph(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") || "100");
  
  // Query Neo4j for graph data
  const graphStore = new Neo4jGraphStore();
  await graphStore.connect();
  const queryInterface = new GraphQueryInterface(graphStore);
  
  const result = await queryInterface.executeQuery(`
    MATCH (n)-[r]->(m)
    RETURN n, r, m
    LIMIT $limit
  `, { limit });

  return this.jsonResponse(200, {
    nodes: result.nodes,
    relationships: result.relationships,
  });
}

private async handleVectorStats(req: Request): Promise<Response> {
  const vectorStore = new QdrantVectorStore();
  // Get collection stats from Qdrant
  // Return: { totalChunks, lastIngestion, collectionSize, ... }
}
```

---

## Phase 2: Dashboard Setup (Week 2)

### 2.1 Initialize Refine.dev Project

```bash
cd /home/tj/project-palindrome
mkdir dashboard
cd dashboard

# Initialize with Bun (since you use Bun)
bun create refine-app@latest . --preset refine-vite --ui-framework react --data-provider simple-rest

# Or use npm if preferred
npm create refine-app@latest . --preset refine-vite
```

### 2.2 Configure API Client

**File:** `dashboard/src/providers/dataProvider.ts`

```typescript
import { DataProvider } from "@refinedev/core";
import axios from "axios";

const API_URL = import.meta.env.VITE_PCE_API_URL || "http://localhost:4000";

export const dataProvider: DataProvider = {
  getList: async ({ resource, pagination, filters, sorters }) => {
    const { current = 1, pageSize = 10 } = pagination ?? {};
    
    if (resource === "tool-executions") {
      const params = new URLSearchParams({
        limit: pageSize.toString(),
        offset: ((current - 1) * pageSize).toString(),
      });
      
      // Add filters
      filters?.forEach((filter) => {
        if (filter.field === "toolName" && filter.value) {
          params.append("toolName", filter.value);
        }
        if (filter.field === "userId" && filter.value) {
          params.append("userId", filter.value);
        }
      });
      
      const response = await axios.get(
        `${API_URL}/api/dashboard/tool-executions?${params}`
      );
      
      return {
        data: response.data.executions,
        total: response.data.total || response.data.executions.length,
      };
    }
    
    // Handle other resources...
    throw new Error(`Unknown resource: ${resource}`);
  },
  
  getOne: async ({ resource, id }) => {
    // Implementation
  },
  
  // ... other methods
};
```

### 2.3 Create Dashboard Layout

**File:** `dashboard/src/App.tsx`

```typescript
import { Refine } from "@refinedev/core";
import { RefineKbar, RefineKbarProvider } from "@refinedev/kbar";
import {
  ErrorComponent,
  ThemedLayoutV2,
  notificationProvider,
  RefineThemes,
} from "@refinedev/antd";
import { dataProvider } from "./providers/dataProvider";
import { resources } from "./config/resources";
import { DashboardPage } from "./pages/dashboard";
import { ToolExecutionsPage } from "./pages/tool-executions";
import { ClusterStatusPage } from "./pages/cluster-status";
import { OntologyGraphPage } from "./pages/ontology-graph";

function App() {
  return (
    <RefineKbarProvider>
      <Refine
        dataProvider={dataProvider}
        resources={resources}
        notificationProvider={notificationProvider}
        options={{
          syncWithLocation: true,
          warnWhenUnsavedChanges: true,
        }}
      >
        <ThemedLayoutV2>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/tool-executions" element={<ToolExecutionsPage />} />
            <Route path="/cluster-status" element={<ClusterStatusPage />} />
            <Route path="/ontology-graph" element={<OntologyGraphPage />} />
          </Routes>
        </ThemedLayoutV2>
        <RefineKbar />
        <UnsavedChangesNotifier />
      </Refine>
    </RefineKbarProvider>
  );
}
```

---

## Phase 3: Dashboard Components (Week 3)

### 3.1 Tool Execution Log Table

**File:** `dashboard/src/pages/tool-executions/index.tsx`

```typescript
import { useTable } from "@refinedev/antd";
import { Table, Tag, Space } from "antd";
import { ToolExecution } from "./types";

export const ToolExecutionsPage = () => {
  const { tableProps } = useTable<ToolExecution>({
    resource: "tool-executions",
    pagination: {
      pageSize: 50,
    },
  });

  return (
    <Table
      {...tableProps}
      columns={[
        {
          title: "Timestamp",
          dataIndex: "timestamp",
          render: (value) => new Date(value).toLocaleString(),
        },
        {
          title: "Tool",
          dataIndex: "toolName",
          render: (value) => <Tag color="blue">{value}</Tag>,
        },
        {
          title: "User",
          dataIndex: "userId",
        },
        {
          title: "Status",
          dataIndex: "result",
          render: (result) => (
            <Tag color={result.error ? "red" : "green"}>
              {result.error ? "Failed" : "Success"}
            </Tag>
          ),
        },
        {
          title: "Duration",
          dataIndex: "durationMs",
          render: (value) => `${value}ms`,
        },
        {
          title: "Parameters",
          dataIndex: "parameters",
          render: (params) => (
            <pre style={{ fontSize: "12px", maxWidth: "300px" }}>
              {JSON.stringify(params, null, 2)}
            </pre>
          ),
        },
      ]}
    />
  );
};
```

### 3.2 Cluster Status Panel

**File:** `dashboard/src/pages/cluster-status/index.tsx`

```typescript
import { useCustom } from "@refinedev/core";
import { Card, Row, Col, Statistic, Alert } from "antd";
import { useEffect, useState } from "react";

export const ClusterStatusPage = () => {
  const { data, isLoading } = useCustom({
    url: "/api/dashboard/cluster-status",
    method: "get",
  });

  const clusterData = data?.data;

  return (
    <div>
      <Row gutter={16}>
        {clusterData?.nodes?.map((node: any) => (
          <Col span={8} key={node.name}>
            <Card title={node.name}>
              <Statistic
                title="CPU Usage"
                value={node.cpu}
                suffix="%"
                valueStyle={{ color: node.cpu > 80 ? "#cf1322" : "#3f8600" }}
              />
              <Statistic
                title="Memory Usage"
                value={node.memory}
                suffix="%"
                valueStyle={{ color: node.memory > 80 ? "#cf1322" : "#3f8600" }}
              />
              <Statistic
                title="VMs Running"
                value={node.vmsRunning}
              />
            </Card>
          </Col>
        ))}
      </Row>
      
      {clusterData?.alerts && clusterData.alerts.length > 0 && (
        <Alert
          message="Cluster Alerts"
          description={clusterData.alerts.map((a: any) => a.message).join(", ")}
          type="warning"
          showIcon
        />
      )}
    </div>
  );
};
```

### 3.3 Ontology Graph Visualization

**File:** `dashboard/src/pages/ontology-graph/index.tsx`

```typescript
import { useCustom } from "@refinedev/core";
import { useEffect, useRef } from "react";
import { Network } from "vis-network";

export const OntologyGraphPage = () => {
  const { data } = useCustom({
    url: "/api/dashboard/ontology-graph",
    method: "get",
  });

  const networkRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!data?.data || !networkRef.current) return;

    const graphData = data.data;
    
    // Transform Neo4j data to vis.js format
    const nodes = graphData.nodes.map((node: any) => ({
      id: node.id,
      label: node.name || node.id,
      group: node.type,
      title: JSON.stringify(node, null, 2),
    }));

    const edges = graphData.relationships.map((rel: any) => ({
      from: rel.from,
      to: rel.to,
      label: rel.type,
      arrows: "to",
    }));

    const visData = { nodes, edges };
    const options = {
      nodes: {
        shape: "dot",
        size: 16,
      },
      edges: {
        arrows: {
          to: { enabled: true },
        },
      },
      physics: {
        enabled: true,
      },
    };

    const network = new Network(networkRef.current, visData, options);
    
    return () => {
      network.destroy();
    };
  }, [data]);

  return (
    <div>
      <div ref={networkRef} style={{ height: "800px", border: "1px solid #ccc" }} />
    </div>
  );
};
```

---

## Phase 4: Real-Time Updates (Week 4)

### 4.1 Add WebSocket Support

**File:** `src/pce/api/server.ts` (add WebSocket handler)

```typescript
import { ServerWebSocket } from "bun";

private handleToolExecutionWebSocket(req: Request, server: BunServer) {
  const upgrade = server.upgrade(req, {
    data: { subscribed: new Set<string>() },
  });

  if (!upgrade) {
    return new Response("Upgrade failed", { status: 400 });
  }

  return undefined; // WebSocket connection established
}

// In server setup, add WebSocket handler:
server.upgrade = (req, server, data) => {
  const url = new URL(req.url);
  
  if (url.pathname === "/ws/tool-executions") {
    return {
      data: { subscribed: new Set<string>() },
    };
  }
  
  return undefined;
};

// Broadcast tool executions to connected clients
private broadcastToolExecution(execution: ToolExecution) {
  // Implementation to send to all connected WebSocket clients
}
```

### 4.2 Connect Dashboard to WebSocket

**File:** `dashboard/src/hooks/useToolExecutionWebSocket.ts`

```typescript
import { useEffect, useState } from "react";

export const useToolExecutionWebSocket = () => {
  const [executions, setExecutions] = useState<any[]>([]);

  useEffect(() => {
    const ws = new WebSocket("ws://localhost:4000/ws/tool-executions");

    ws.onmessage = (event) => {
      const execution = JSON.parse(event.data);
      setExecutions((prev) => [execution, ...prev].slice(0, 100));
    };

    return () => {
      ws.close();
    };
  }, []);

  return executions;
};
```

---

## Quick Start: Minimal Viable Dashboard

If you want to start even simpler, here's a **minimal HTML dashboard** that you can build in a few hours:

**File:** `dashboard/index.html`

```html
<!DOCTYPE html>
<html>
<head>
  <title>Palindrome Dashboard</title>
  <script src="https://unpkg.com/vis-network@latest/dist/vis-network.min.js"></script>
  <style>
    body { font-family: sans-serif; margin: 20px; }
    .panel { border: 1px solid #ccc; padding: 20px; margin: 10px 0; }
    #graph { height: 600px; border: 1px solid #ccc; }
  </style>
</head>
<body>
  <h1>Palindrome Dashboard</h1>
  
  <div class="panel">
    <h2>Cluster Status</h2>
    <div id="cluster-status">Loading...</div>
  </div>
  
  <div class="panel">
    <h2>Tool Executions</h2>
    <div id="tool-executions">Loading...</div>
  </div>
  
  <div class="panel">
    <h2>Ontology Graph</h2>
    <div id="graph"></div>
  </div>

  <script>
    const API_URL = "http://localhost:4000";
    
    // Fetch cluster status
    fetch(`${API_URL}/api/dashboard/cluster-status`)
      .then(r => r.json())
      .then(data => {
        document.getElementById("cluster-status").innerHTML = 
          JSON.stringify(data, null, 2);
      });
    
    // Fetch tool executions
    fetch(`${API_URL}/api/dashboard/tool-executions?limit=20`)
      .then(r => r.json())
      .then(data => {
        document.getElementById("tool-executions").innerHTML = 
          JSON.stringify(data, null, 2);
      });
    
    // Fetch and render graph
    fetch(`${API_URL}/api/dashboard/ontology-graph?limit=50`)
      .then(r => r.json())
      .then(data => {
        const nodes = data.nodes.map(n => ({
          id: n.id,
          label: n.name || n.id,
        }));
        const edges = data.relationships.map(r => ({
          from: r.from,
          to: r.to,
        }));
        const visData = { nodes, edges };
        const options = {};
        new vis.Network(document.getElementById("graph"), visData, options);
      });
  </script>
</body>
</html>
```

This gives you a **working dashboard in 1 hour** that you can then enhance incrementally.

---

## Next Steps

1. **Start with Phase 1** - Add tool execution store and API endpoints
2. **Test with simple HTML dashboard** - Verify API works
3. **Build Refine.dev dashboard** - If you want a proper admin panel
4. **Add real-time updates** - WebSocket integration
5. **Polish and iterate** - Add more panels as needed

