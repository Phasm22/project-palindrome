#!/usr/bin/env bun

/**
 * Check what files are indexed in the PCE system
 * Reports on:
 * - Snapshot log (files processed)
 * - Vector database (Qdrant)
 * - Knowledge graph (Neo4j)
 */

import { SnapshotLog } from "./dlm";
import { QdrantVectorStore } from "./vector";
import { Neo4jGraphStore } from "./kg/indexation/neo4j-client";
import { pceLogger } from "./utils/logger";

const SNAPSHOT_LOG_PATH = process.env.PCE_SNAPSHOT_LOG_PATH || "./.pce/snapshots.json";

async function checkVectorIndex(vectorStore: QdrantVectorStore) {
  console.log("\n📊 Vector Database (Qdrant) Status:");
  try {
    const collectionName = (vectorStore as any).collectionName;
    
    // Get collection info
    try {
      const collectionInfo = await (vectorStore as any).getCollectionInfo();
      console.log(`  ✅ Collection '${collectionName}' exists`);
      console.log(`  📈 Points (chunks): ${collectionInfo.points_count || 0}`);
    } catch (err: any) {
      console.log(`  ⚠️  Could not get collection info: ${err.message}`);
    }
    
    // Try to scroll through points to see what's indexed
    try {
      const scrollResult = await (vectorStore as any).client.scroll(collectionName, {
        limit: 100,
        with_payload: true,
      });
      
      if (scrollResult.points && scrollResult.points.length > 0) {
        console.log(`  📄 Indexed files (from ${scrollResult.points.length} sample chunks):`);
        const uniqueFiles = new Map<string, number>();
        scrollResult.points.forEach((point: any) => {
          if (point.payload?.source_path) {
            const path = point.payload.source_path;
            uniqueFiles.set(path, (uniqueFiles.get(path) || 0) + 1);
          }
        });
        
        Array.from(uniqueFiles.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .forEach(([path, count]) => {
            console.log(`     - ${path} (${count} chunk${count !== 1 ? 's' : ''})`);
          });
        
        if (uniqueFiles.size > 10) {
          console.log(`     ... and ${uniqueFiles.size - 10} more file(s)`);
        }
      } else {
        console.log(`  ⚠️  No chunks found in collection`);
      }
    } catch (err: any) {
      console.log(`  ⚠️  Could not query points: ${err.message}`);
    }
  } catch (error: any) {
    console.log(`  ❌ Error checking vector DB: ${error.message}`);
  }
}

async function checkKnowledgeGraph(graphStore: Neo4jGraphStore) {
  console.log("\n📊 Knowledge Graph (Neo4j) Status:");
  try {
    // Connect if not already connected
    try {
      await graphStore.connect();
    } catch (err: any) {
      if (!err.message.includes("already connected")) {
        throw err;
      }
    }
    
    const driver = graphStore.getDriver();
    const session = driver.session();
    
    try {
      // Count nodes
      const nodeResult = await session.run("MATCH (n) RETURN count(n) as count");
      const nodeCount = nodeResult.records[0]?.get("count") || 0;
      console.log(`  📈 Total nodes: ${nodeCount}`);
      
      // Count relationships
      const relResult = await session.run("MATCH ()-[r]->() RETURN count(r) as count");
      const relCount = relResult.records[0]?.get("count") || 0;
      console.log(`  🔗 Total relationships: ${relCount}`);
      
      // Get unique source paths
      const sourceResult = await session.run(`
        MATCH (n)
        WHERE n.sourcePath IS NOT NULL
        RETURN DISTINCT n.sourcePath as path
        LIMIT 10
      `);
      
      if (sourceResult.records.length > 0) {
        console.log(`  📄 Sample indexed files:`);
        sourceResult.records.forEach((record) => {
          const path = record.get("path");
          if (path) console.log(`     - ${path}`);
        });
      }
      
      // Get node types
      const typeResult = await session.run(`
        MATCH (n)
        RETURN DISTINCT labels(n)[0] as type, count(*) as count
        ORDER BY count DESC
        LIMIT 10
      `);
      
      if (typeResult.records.length > 0) {
        console.log(`  🏷️  Node types:`);
        typeResult.records.forEach((record) => {
          const type = record.get("type");
          const count = record.get("count");
          console.log(`     - ${type}: ${count}`);
        });
      }
    } finally {
      await session.close();
    }
  } catch (error: any) {
    console.log(`  ❌ Error checking knowledge graph: ${error.message}`);
    if (error.message.includes("ECONNREFUSED") || error.message.includes("connect")) {
      console.log(`     💡 Is Neo4j running? Check connection settings.`);
    }
  }
}

async function main() {
  console.log("🔍 Checking PCE Index Status...\n");
  
  // Check snapshot log
  console.log("📊 Snapshot Log Status:");
  try {
    const snapshotLog = new SnapshotLog(SNAPSHOT_LOG_PATH);
    await snapshotLog.initialize();
    const snapshots = snapshotLog.getAllSnapshots();
    
    console.log(`  ✅ Snapshot log loaded: ${snapshots.length} file(s) tracked`);
    
    if (snapshots.length > 0) {
      console.log(`  📄 Tracked files:`);
      snapshots.forEach((snapshot) => {
        console.log(`     - ${snapshot.filePath} (${snapshot.documentType}, ${snapshot.aclGroup})`);
      });
    } else {
      console.log(`  ⚠️  No files have been indexed yet`);
    }
  } catch (error: any) {
    console.log(`  ❌ Error loading snapshot log: ${error.message}`);
  }
  
  // Check vector database
  try {
    const vectorStore = new QdrantVectorStore();
    await checkVectorIndex(vectorStore);
  } catch (error: any) {
    console.log(`\n❌ Could not connect to vector DB: ${error.message}`);
    console.log(`   💡 Is Qdrant running? Check QDRANT_URL environment variable.`);
  }
  
  // Check knowledge graph
  try {
    const graphStore = new Neo4jGraphStore();
    await checkKnowledgeGraph(graphStore);
  } catch (error: any) {
    console.log(`\n❌ Could not connect to knowledge graph: ${error.message}`);
    console.log(`   💡 Is Neo4j running? Check NEO4J_URI environment variable.`);
  }
  
  console.log("\n" + "=".repeat(60));
  console.log("✅ Index check complete");
  console.log("=".repeat(60) + "\n");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

