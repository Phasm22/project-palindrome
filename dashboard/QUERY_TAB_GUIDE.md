# Query Tab Usage Guide

## When to Use the Query Tab

The Query tab is your **interactive exploration interface** for the Palindrome system. Use it when you need to:

### 1. **Quick Information Lookups**
- "What VMs are running on proxBig?"
- "Show me all services that depend on the database"
- "What's the IP address of the windowsVM?"

### 2. **Debugging & Investigation**
- "Why did the agent make that decision?" → Check reasoning traces
- "What data did the RAG system retrieve?" → Test RAG queries
- "What's the relationship between these entities?" → Graph queries

### 3. **Exploratory Analysis**
- "What entities exist in the topology?"
- "Find all hosts with a specific purpose"
- "Show me the dependency chain for this service"

### 4. **Testing & Validation**
- Test RAG queries before using them in production
- Verify graph data structure
- Validate query results match expectations

### 5. **Learning the System**
- Understand what data is available
- See how queries are structured
- Explore the knowledge graph interactively

---

## Why Use the Query Tab vs. Alternatives?

### **Query Tab** (Recommended for Interactive Exploration)
✅ **Best for:**
- Quick lookups and exploration
- Visual feedback and formatted results
- Testing queries before automation
- Non-technical users
- Iterative query refinement

❌ **Not ideal for:**
- Scripting/automation
- High-volume batch queries
- CI/CD pipelines

### **CLI** (`bun src/cli.ts pce-api "query"`)
✅ **Best for:**
- Scripting and automation
- Terminal-based workflows
- Integration with other tools
- Batch processing

❌ **Not ideal for:**
- Visual exploration
- Quick one-off queries
- Non-technical users

### **Direct API** (`POST /query`)
✅ **Best for:**
- Application integration
- Custom frontends
- Programmatic access
- High-performance needs

❌ **Not ideal for:**
- Manual exploration
- Quick testing
- Learning the system

---

## How to Use the Query Tab

### **Natural Language (RAG) Queries**

**Use Case:** Ask questions in plain English about your infrastructure.

**Steps:**
1. Select "Natural Language (RAG)" from the Query Type dropdown
2. Type your question in the text area
3. Click "Query"
4. Review the answer and sources

**Examples:**
```
"What VMs are running on proxBig?"
"Show me all Proxmox nodes and their status"
"What is the IP address of the windowsVM?"
"List all services that depend on the database"
```

**What You Get:**
- Natural language answer
- Source documents with relevance scores
- Total confidence score (sTotalScore)
- Context chunks used to generate the answer

---

### **Graph Query Builder**

**Use Case:** Structured queries about entities and relationships in the knowledge graph.

**Steps:**
1. Select "Graph Query" from the Query Type dropdown
2. Choose a query type from the dropdown
3. Enter the required parameter(s)
4. Click "Query Graph"
5. Review nodes and relationships

**Query Types:**

#### **Find by ID or Name**
- **Parameter:** Entity ID or name (partial match, case-insensitive)
- **Example:** `windowsVM`, `proxBig`, `opnsense`
- **Use When:** You know the entity name but want to see its details

#### **Find by Entity Type**
- **Parameter:** Entity type (e.g., `Host`, `VM`, `Service`, `Container`)
- **Example:** `Host`, `VM`, `Service`
- **Use When:** You want to see all entities of a specific type

#### **Find by Purpose**
- **Parameter:** Purpose keyword (searches in entity attributes)
- **Example:** `database`, `web`, `monitoring`
- **Use When:** You want to find entities by their role/purpose

#### **Find by Role**
- **Parameter:** Role keyword (searches in entity attributes)
- **Example:** `router`, `server`, `client`
- **Use When:** You want to find entities by their specific role

#### **Find Dependencies**
- **Parameter:** Entity ID
- **Example:** `service-123`
- **Use When:** You want to see what a service depends on

#### **Find Dependents**
- **Parameter:** Entity ID
- **Example:** `database-456`
- **Use When:** You want to see what depends on an entity

#### **Find Path Between Entities**
- **Parameters:** 
  - First entity ID
  - Second entity ID
- **Example:** `vm-100` → `vm-101`
- **Use When:** You want to see the relationship path between two entities

#### **Find Hosted Entities**
- **Parameter:** Host ID
- **Example:** `proxBig`
- **Use When:** You want to see all VMs/containers on a specific host

**What You Get:**
- List of nodes (entities) with their attributes
- List of relationships between entities
- Formatted tables for easy reading

---

### **Cypher Query**

**Use Case:** Advanced queries using Neo4j Cypher syntax for custom exploration.

**Steps:**
1. Select "Cypher Query" from the Query Type dropdown
2. Write your Cypher query in the text area
3. Click "Execute Cypher"
4. Review results

**Examples:**

```cypher
# Find all VMs with their IP addresses
MATCH (n:Entity {type: "VM"})
RETURN n.id, n.attributes.ip
LIMIT 50

# Find all relationships for a specific entity
MATCH (n:Entity {id: "windowsVM"})-[r]-(connected)
RETURN n, r, connected
LIMIT 50

# Find dependency chains
MATCH path = (start:Entity)-[:DEPENDS_ON*1..5]->(end:Entity)
WHERE start.id = "service-123"
RETURN path
LIMIT 50

# Find all hosts and what they host
MATCH (host:Entity {type: "Host"})-[r:HOSTS]->(entity:Entity)
RETURN host.id, r.type, entity.id, entity.type
LIMIT 50
```

**What You Get:**
- Raw query results (nodes, relationships, paths)
- Full control over query structure
- Advanced filtering and pattern matching

---

## Common Workflows

### **Workflow 1: Investigating a Problem**

1. **Start with RAG:** "What VMs are having issues?"
2. **Use Graph Query:** Find dependencies for the problematic VM
3. **Use Cypher:** Deep dive into specific relationships

### **Workflow 2: Understanding the Topology**

1. **Use Graph Query:** "Find by Entity Type" → `Host`
2. **For each host:** "Find Hosted Entities"
3. **Use Cypher:** Query relationships between entities

### **Workflow 3: Validating Data**

1. **Use RAG:** "What is the IP address of windowsVM?"
2. **Use Graph Query:** "Find by ID or Name" → `windowsVM`
3. **Compare results** to verify consistency

### **Workflow 4: Testing Before Automation**

1. **Use Query Tab:** Test your query interactively
2. **Verify results** match expectations
3. **Copy query** to your automation script/CLI

---

## Tips & Best Practices

### **RAG Queries**
- Be specific: "What VMs are running on proxBig?" vs. "Show me VMs"
- Use natural language: The system understands context
- Check sources: Verify the answer is grounded in your data

### **Graph Queries**
- Start broad: Use "Find by Entity Type" to see what's available
- Then narrow: Use specific queries once you know entity IDs
- Check relationships: Understanding connections is key

### **Cypher Queries**
- Start simple: Test basic queries first
- Use LIMIT: Always limit results to avoid overwhelming output
- Test in Query Tab: Before using in production code

### **General**
- **Refresh data:** If results seem stale, check when data was last ingested
- **Check reasoning traces:** Use the Reasoning Traces tab to see how the agent interpreted queries
- **Compare methods:** Try the same query in different modes to understand differences

---

## Troubleshooting

### **RAG Query Returns "No Answer"**
- Check if data has been ingested
- Try a more specific query
- Check the RAG Diagnostics tab for query details

### **Graph Query Returns No Results**
- Verify entity IDs exist (try "Find by Entity Type" first)
- Check spelling/case sensitivity
- Try partial matches with "Find by ID or Name"

### **Cypher Query Errors**
- Check Neo4j syntax
- Verify entity types and relationship names
- Use LIMIT to avoid large result sets

---

## Integration with Other Dashboard Tabs

The Query tab works best when combined with other dashboard features:

- **Overview Tab:** See system health before querying
- **Tool Executions Tab:** See what tools were used to gather data
- **Reasoning Traces Tab:** Understand how the agent interpreted queries
- **Ontology Graph Tab:** Visualize query results in the graph
- **RAG Diagnostics Tab:** Deep dive into RAG query processing

---

## Next Steps

1. **Start Simple:** Try a basic RAG query about your infrastructure
2. **Explore Graph:** Use "Find by Entity Type" to see what's available
3. **Try Cypher:** Write a custom query for your specific needs
4. **Combine Methods:** Use multiple query types to get a complete picture

