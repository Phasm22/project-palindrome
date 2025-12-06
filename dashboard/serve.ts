#!/usr/bin/env bun

import { serve } from "bun";
import { watch } from "node:fs";

const PORT = 8080;
const DASHBOARD_DIR = import.meta.dir;

const connectedClients = new Set<WebSocket>();

// Watch for file changes
const watcher = watch(
  DASHBOARD_DIR,
  { recursive: true },
  (eventType, filename) => {
    if (filename && !filename.toString().includes("node_modules")) {
      // Notify all connected clients to reload
      connectedClients.forEach((ws) => {
        try {
          ws.send("reload");
        } catch (e) {
          // Client disconnected, remove from set
          connectedClients.delete(ws);
        }
      });
    }
  }
);

// Simple file server with auto-reload
const server = serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    
    // Handle WebSocket upgrade for /_reload
    if (url.pathname === "/_reload" && server.upgrade(req)) {
      return; // WebSocket upgrade handled
    }
    
    // Handle favicon requests
    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }
    
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    
    // Security: prevent directory traversal
    if (path.includes("..")) {
      return new Response("Not found", { status: 404 });
    }
    
    try {
      const file = Bun.file(`${DASHBOARD_DIR}${path}`);
      const exists = await file.exists();
      
      if (!exists) {
        return new Response("Not found", { status: 404 });
      }
      
      // Inject auto-reload script for HTML files
      if (path.endsWith(".html")) {
        let content = await file.text();
        const reloadScript = `
<script>
  // Auto-reload on file changes
  (function() {
    const ws = new WebSocket('ws://localhost:${PORT}/_reload');
    ws.onmessage = () => {
      console.log('🔄 Reloading...');
      location.reload();
    };
    ws.onerror = () => console.log('Auto-reload unavailable');
    ws.onclose = () => console.log('Auto-reload disconnected');
  })();
</script>`;
        
        // Inject before closing </body> tag
        if (content.includes("</body>")) {
          content = content.replace("</body>", `${reloadScript}</body>`);
        } else {
          content += reloadScript;
        }
        return new Response(content, {
          headers: { "Content-Type": "text/html" },
        });
      }
      
      return new Response(file);
    } catch (error) {
      return new Response(`Error: ${error}`, { status: 500 });
    }
  },
  
  websocket: {
    message(ws, message) {},
    open(ws) {
      connectedClients.add(ws);
      console.log(`✅ WebSocket client connected for auto-reload`);
    },
    close(ws) {
      connectedClients.delete(ws);
      console.log(`❌ WebSocket client disconnected`);
    },
  },
});

console.log(`🚀 Dashboard server running at http://localhost:${PORT}`);
console.log(`📁 Serving from: ${DASHBOARD_DIR}`);
console.log(`🔄 Auto-reload enabled - changes will refresh automatically`);
console.log(`\nPress Ctrl+C to stop\n`);

