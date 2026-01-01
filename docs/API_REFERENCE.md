# Palindrome API Reference

Complete reference for all Palindrome API endpoints.

**Base URL:** `http://localhost:4000` (default)

## Table of Contents

- [Health & Metrics](#health--metrics)
- [Agent Endpoints](#agent-endpoints)
- [Dashboard Endpoints](#dashboard-endpoints)
- [Chat Endpoints](#chat-endpoints)
- [User Preferences](#user-preferences)
- [Legacy Endpoints](#legacy-endpoints)

---

## Health & Metrics

### GET /health

Check API health status.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-01-20T12:00:00.000Z",
  "services": {
    "neo4j": "connected",
    "qdrant": "connected"
  }
}
```

### GET /metrics

Get API metrics in JSON format.

**Query Parameters:**
- `format=prometheus` - Return Prometheus format instead of JSON

**Response (JSON):**
```json
{
  "requests_total": 1234,
  "requests_per_second": 5.2,
  "errors_total": 12,
  "error_rate": 0.0097
}
```

**Response (Prometheus):**
```
# HELP api_requests_total Total number of API requests
# TYPE api_requests_total counter
api_requests_total 1234
```

---

## Agent Endpoints

### GET /api/agent/stream

Stream agent responses using Server-Sent Events (SSE).

**Query Parameters:**
- `userInput` (required) - User's question or command
- `sessionId` (optional) - Session identifier for conversation continuity
- `userId` (optional) - User identifier (defaults to "dashboard-user")
- `aclGroup` (optional) - ACL group (defaults to "admin")

**Example:**
```bash
curl "http://localhost:4000/api/agent/stream?userInput=list%20all%20VMs&sessionId=test-123"
```

**Response:** SSE stream with events:
- `agent:thinking` - Agent is processing
- `agent:tool_call` - Tool execution started
- `agent:tool_result` - Tool execution completed
- `agent:final` - Final response
- `agent:error` - Error occurred

### POST /api/agent/query

Trigger agent with tool calling (non-streaming).

**Request Body:**
```json
{
  "userInput": "list all VMs",
  "sessionId": "test-123",
  "userId": "dashboard-user",
  "aclGroup": "admin"
}
```

**Response:**
```json
{
  "success": true,
  "response": "Here are all VMs: ...",
  "sessionId": "test-123",
  "toolCalls": [...]
}
```

---

## Dashboard Endpoints

### GET /api/dashboard/execution-stats

Get execution statistics.

**Response:**
```json
{
  "totalExecutions": 1234,
  "successfulExecutions": 1200,
  "failedExecutions": 34,
  "errorRate": 0.0276,
  "averageDurationMs": 1250
}
```

### GET /api/dashboard/tool-executions

Get paginated tool execution log.

**Query Parameters:**
- `page` (optional, default: 1) - Page number
- `limit` (optional, default: 50) - Items per page
- `toolName` (optional) - Filter by tool name
- `userId` (optional) - Filter by user ID
- `aclGroup` (optional) - Filter by ACL group

**Response:**
```json
{
  "executions": [
    {
      "id": "exec-123",
      "toolName": "proxmox_readonly",
      "userId": "dashboard-user",
      "aclGroup": "admin",
      "parameters": {...},
      "result": {...},
      "durationMs": 250,
      "timestamp": "2025-01-20T12:00:00.000Z",
      "success": true
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 1234,
    "totalPages": 25
  }
}
```

### GET /api/dashboard/cluster-status

Get Proxmox cluster status.

**Response:**
```json
{
  "clusters": [
    {
      "name": "yang",
      "nodes": [...],
      "status": "healthy"
    }
  ]
}
```

### GET /api/dashboard/ontology-graph

Get Neo4j graph data for visualization.

**Query Parameters:**
- `limit` (optional, default: 100) - Maximum nodes to return
- `nodeTypes` (optional) - Comma-separated node types to filter

**Response:**
```json
{
  "nodes": [
    {
      "id": "compute-vm:proxbig:100",
      "label": "windowsVM",
      "type": "VM_INSTANCE",
      "properties": {...}
    }
  ],
  "edges": [
    {
      "source": "compute-vm:proxbig:100",
      "target": "compute-node:proxbig",
      "type": "HOSTS_ON",
      "properties": {...}
    }
  ]
}
```

### GET /api/dashboard/vector-stats

Get vector store statistics.

**Response:**
```json
{
  "totalDocuments": 1234,
  "totalChunks": 5678,
  "collectionName": "pce_documents"
}
```

### GET /api/dashboard/rag-diagnostics

Get RAG query diagnostics.

**Query Parameters:**
- `query` (required) - Query string to diagnose

**Response:**
```json
{
  "query": "What VMs are running?",
  "queryType": "HYBRID",
  "sTotalScore": 0.85,
  "sourcesCount": 3,
  "topChunks": [
    {
      "sourcePath": "/path/to/doc.txt",
      "score": 0.92,
      "textPreview": "..."
    }
  ],
  "graphContext": {
    "entitiesFound": 5,
    "relationshipsFound": 3
  }
}
```

### GET /api/dashboard/reasoning-traces

Get paginated reasoning traces.

**Query Parameters:**
- `page` (optional, default: 1) - Page number
- `limit` (optional, default: 50) - Items per page
- `userId` (optional) - Filter by user ID

**Response:**
```json
{
  "traces": [
    {
      "id": "trace-123",
      "userId": "dashboard-user",
      "userInput": "list all VMs",
      "finalResponse": "Here are all VMs...",
      "steps": [...],
      "timestamp": "2025-01-20T12:00:00.000Z",
      "durationMs": 1250
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 1234
  }
}
```

### GET /api/dashboard/reasoning-traces/{traceId}

Get a specific reasoning trace by ID.

**Response:**
```json
{
  "id": "trace-123",
  "userId": "dashboard-user",
  "userInput": "list all VMs",
  "finalResponse": "Here are all VMs...",
  "steps": [
    {
      "step": 1,
      "toolCalls": [...],
      "decisions": [...],
      "ragContext": {...}
    }
  ],
  "timestamp": "2025-01-20T12:00:00.000Z",
  "durationMs": 1250
}
```

### POST /api/dashboard/query/rag

Execute a RAG query.

**Request Body:**
```json
{
  "query": "What VMs are running?",
  "userId": "dashboard-user",
  "aclGroup": "admin"
}
```

**Response:**
```json
{
  "success": true,
  "answer": "The following VMs are running: ...",
  "sources": [
    {
      "path": "/path/to/doc.txt",
      "score": 0.92
    }
  ]
}
```

### POST /api/dashboard/query/graph

Execute a graph query using preset queries.

**Request Body:**
```json
{
  "queryType": "list_all_vms",
  "parameters": {}
}
```

**Response:**
```json
{
  "success": true,
  "results": [...]
}
```

### POST /api/dashboard/query/cypher

Execute a custom Neo4j Cypher query.

**Request Body:**
```json
{
  "query": "MATCH (v:VM_INSTANCE) RETURN v LIMIT 10",
  "parameters": {}
}
```

**Response:**
```json
{
  "success": true,
  "results": [
    {
      "v": {
        "id": "compute-vm:proxbig:100",
        "name": "windowsVM",
        ...
      }
    }
  ]
}
```

---

## Chat Endpoints

### GET /api/chat/history

Get chat history.

**Query Parameters:**
- `limit` (optional, default: 50) - Number of messages to return

**Response:**
```json
{
  "messages": [
    {
      "id": "msg-123",
      "userId": "dashboard-user",
      "userInput": "list all VMs",
      "response": "Here are all VMs...",
      "timestamp": "2025-01-20T12:00:00.000Z"
    }
  ]
}
```

### DELETE /api/chat/history/{messageId}

Delete a specific chat message.

**Response:**
```json
{
  "success": true,
  "messageId": "msg-123"
}
```

### GET /api/chat/conversations

Get all conversations.

**Response:**
```json
{
  "conversations": [
    {
      "id": "conv-123",
      "title": "VM Management",
      "messageCount": 5,
      "lastMessageAt": "2025-01-20T12:00:00.000Z",
      "createdAt": "2025-01-20T11:00:00.000Z"
    }
  ]
}
```

### POST /api/chat/conversations

Create a new conversation.

**Request Body:**
```json
{
  "title": "New Conversation"
}
```

**Response:**
```json
{
  "success": true,
  "conversation": {
    "id": "conv-123",
    "title": "New Conversation",
    "createdAt": "2025-01-20T12:00:00.000Z"
  }
}
```

### GET /api/chat/conversations/{conversationId}/messages

Get messages for a specific conversation.

**Response:**
```json
{
  "conversationId": "conv-123",
  "messages": [
    {
      "id": "msg-123",
      "userInput": "list all VMs",
      "response": "Here are all VMs...",
      "timestamp": "2025-01-20T12:00:00.000Z"
    }
  ]
}
```

### DELETE /api/chat/conversations/{conversationId}

Delete a conversation and all its messages.

**Response:**
```json
{
  "success": true,
  "conversationId": "conv-123"
}
```

### PATCH /api/chat/conversations/{conversationId}

Update conversation title.

**Request Body:**
```json
{
  "title": "Updated Title"
}
```

**Response:**
```json
{
  "success": true,
  "conversation": {
    "id": "conv-123",
    "title": "Updated Title"
  }
}
```

---

## User Preferences

### GET /api/user/preferences

Get user preferences.

**Response:**
```json
{
  "userId": "dashboard-user",
  "preferences": {
    "theme": "dark",
    "notifications": true
  }
}
```

### PUT /api/user/preferences

Update user preferences.

**Request Body:**
```json
{
  "theme": "dark",
  "notifications": true
}
```

**Response:**
```json
{
  "success": true,
  "preferences": {
    "theme": "dark",
    "notifications": true
  }
}
```

---

## Legacy Endpoints

### POST /query

Legacy query endpoint (use `/api/agent/query` instead).

**Request Body:**
```json
{
  "query": "list all VMs",
  "userId": "dashboard-user",
  "aclGroup": "admin"
}
```

### GET /history/{sessionId}

Get history for a session (legacy endpoint).

---

## Error Responses

All endpoints may return error responses in the following format:

```json
{
  "success": false,
  "error": "Error message",
  "code": "ERROR_CODE"
}
```

**Common HTTP Status Codes:**
- `200` - Success
- `400` - Bad Request (invalid parameters)
- `404` - Not Found
- `429` - Rate Limit Exceeded
- `500` - Internal Server Error

---

## Rate Limiting

The API implements rate limiting:
- **Global limit:** 100 requests per minute
- **Per-IP limit:** 20 requests per minute

When rate limited, responses include:
```json
{
  "success": false,
  "error": "Rate limit exceeded",
  "retryAfterMs": 5000,
  "scope": "global"
}
```

---

## CORS

All endpoints support CORS with the following headers:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, PATCH, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type`

---

## Authentication

Currently, authentication is handled via:
- `userId` query parameter or request body
- `aclGroup` query parameter or request body

Future versions may implement token-based authentication.

---

**See Also:**
- [Getting Started Guide](GETTING_STARTED.md)
- [Dashboard Documentation](../dashboard/README.md)
- [Troubleshooting Guide](TROUBLESHOOTING.md)

