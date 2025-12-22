#!/usr/bin/env bun

import { serve } from "bun";
import { watch } from "node:fs";

const HTTP_PORT = 8080;
const HTTPS_PORT = 8443;
const DASHBOARD_DIR = import.meta.dir;
const PROJECT_ROOT = `${DASHBOARD_DIR}/..`;

// Check if certs exist
const certPath = `${PROJECT_ROOT}/certs/cert.pem`;
const keyPath = `${PROJECT_ROOT}/certs/key.pem`;
const hasCerts = await Bun.file(certPath).exists() && await Bun.file(keyPath).exists();

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

// Request handler
async function handleRequest(req: Request, server: any) {
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
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(wsProtocol + '//' + location.host + '/_reload');
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
}

const websocketHandlers = {
  message(ws: any, message: any) {},
  open(ws: any) {
    connectedClients.add(ws);
    console.log(`✅ WebSocket client connected for auto-reload`);
  },
  close(ws: any) {
    connectedClients.delete(ws);
    console.log(`❌ WebSocket client disconnected`);
  },
};

// HTTP server (always start)
const httpServer = serve({
  port: HTTP_PORT,
  hostname: "0.0.0.0",
  fetch: handleRequest,
  websocket: websocketHandlers,
});

console.log(`🚀 Dashboard server running at http://0.0.0.0:${HTTP_PORT}`);

// HTTPS server (if certs exist)
if (hasCerts) {
  const httpsServer = serve({
    port: HTTPS_PORT,
    hostname: "0.0.0.0",
    fetch: handleRequest,
    websocket: websocketHandlers,
    tls: {
      cert: Bun.file(certPath),
      key: Bun.file(keyPath),
    },
  });
  console.log(`🔒 HTTPS server running at https://0.0.0.0:${HTTPS_PORT}`);
} else {
  console.log(`⚠️  No certs found at ${certPath} - HTTPS disabled`);
  console.log(`   Run: openssl req -x509 -newkey rsa:2048 -keyout certs/key.pem -out certs/cert.pem -days 365 -nodes`);
}

console.log(`📁 Serving from: ${DASHBOARD_DIR}`);
console.log(`🔄 Auto-reload enabled - changes will refresh automatically`);
console.log(`\nPress Ctrl+C to stop\n`);

