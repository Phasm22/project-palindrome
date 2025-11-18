#!/usr/bin/env bun
// Check Neo4j Proxmox entities and ACL groups

import { Neo4jGraphStore } from "../src/pce/kg/indexation/neo4j-client";
import { GraphQueryInterface } from "../src/pce/kg/queries/query-interface";

async function checkNeo4j() {
  const graphStore = new Neo4jGraphStore();
  await graphStore.connect();
  
  const queryInterface = new GraphQueryInterface(graphStore);
  
  console.log("=== Checking Neo4j Proxmox Entities ===\n");
  
  // Check all node types and ACL groups
  const allNodes = await queryInterface.executeQuery(`
    MATCH (n)
    RETURN DISTINCT n.type as type, n.aclGroup as aclGroup, count(*) as count
    ORDER BY count DESC
  `);
  
  console.log("Node types and ACL groups:");
  for (const node of allNodes.nodes) {
    const attrs = node.attributes || {};
    console.log(`  Type: ${attrs.type || node.type}, ACL: ${attrs.aclGroup || "NULL"}, Count: ${attrs.count || 0}`);
  }
  
  // Check Proxmox nodes specifically
  const proxmoxNodes = await queryInterface.executeQuery(`
    MATCH (n)
    WHERE n.type = "PVE_NODE" OR n.type = "VM_INSTANCE"
    RETURN n.id as id, n.type as type, n.aclGroup as aclGroup
    LIMIT 25
  `);
  
  console.log("\nProxmox entities:");
  for (const node of proxmoxNodes.nodes) {
    const attrs = node.attributes || {};
    console.log(`  ID: ${attrs.id || node.id}, Type: ${attrs.type || node.type}, ACL: ${attrs.aclGroup || "NULL"}`);
  }
  
  // Check relationships
  const relationships = await queryInterface.executeQuery(`
    MATCH ()-[r]->()
    RETURN DISTINCT r.type as type, r.aclGroup as aclGroup, count(*) as count
    ORDER BY count DESC
    LIMIT 25
  `);
  
  console.log("\nRelationship types and ACL groups:");
  for (const rel of relationships.relationships) {
    const props = rel.properties || {};
    console.log(`  Type: ${props.type || rel.type}, ACL: ${props.aclGroup || "NULL"}, Count: ${props.count || 0}`);
  }
  
  // Search for aiMarketBot
  const aiMarketBot = await queryInterface.findEntitiesByIdOrName("aiMarketBot");
  console.log(`\nSearch for "aiMarketBot": Found ${aiMarketBot.nodes.length} entities`);
  for (const node of aiMarketBot.nodes) {
    console.log(`  ID: ${node.id}, Type: ${node.type}, ACL: ${node.aclGroup || "NULL"}`);
  }
  
  await graphStore.close();
}

checkNeo4j().catch(console.error);
