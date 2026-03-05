#!/usr/bin/env bun

import { serve } from "bun";
import { watch } from "node:fs";

const HTTP_PORT = 8080;
const HTTPS_PORT = 8443;
const DASHBOARD_DIR = import.meta.dir;
const PROJECT_ROOT = `${DASHBOARD_DIR}/..`;
const API_PROXY_BASE = process.env.PCE_API_URL || "http://127.0.0.1:4000";

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

    const shouldProxyToApi =
      url.pathname.startsWith("/api/") ||
      url.pathname === "/query" ||
      url.pathname === "/metrics" ||
      url.pathname === "/health" ||
      url.pathname.startsWith("/history/");

    if (shouldProxyToApi) {
      const upstreamPath =
        url.pathname === "/api/health"
          ? "/health"
          : url.pathname === "/api/metrics"
            ? "/metrics"
            : url.pathname;
      const upstreamUrl = `${API_PROXY_BASE}${upstreamPath}${url.search}`;
      const headers = new Headers(req.headers);
      headers.set("host", new URL(API_PROXY_BASE).host);

      const upstreamResponse = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      });

      const responseHeaders = new Headers(upstreamResponse.headers);
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
      responseHeaders.set("Access-Control-Allow-Headers", "Content-Type");

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      });
    }
    
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
      
      // If file doesn't exist, check if it's a client-side route
      if (!exists) {
        // Check if it's a static asset request (has a file extension)
        // Common static file extensions
        const staticExtensions = ['.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.json', '.map', '.pdf'];
        const hasStaticExtension = staticExtensions.some(ext => path.toLowerCase().endsWith(ext));
        
        // If it's a static asset that doesn't exist, return 404
        if (hasStaticExtension) {
          return new Response("Not found", { status: 404 });
        }
        
        // Otherwise, it's a client-side route - serve index.html for SPA routing
        path = "/index.html";
        const indexFile = Bun.file(`${DASHBOARD_DIR}${path}`);
        const indexExists = await indexFile.exists();
        
        if (!indexExists) {
          return new Response("Not found", { status: 404 });
        }
        
        // Serve index.html with reload script
        let content = await indexFile.text();
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
        
        if (content.includes("</body>")) {
          content = content.replace("</body>", `${reloadScript}</body>`);
        } else {
          content += reloadScript;
        }
        return new Response(content, {
          headers: { "Content-Type": "text/html" },
        });
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
console.log(`🔀 API proxy target: ${API_PROXY_BASE}`);

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
