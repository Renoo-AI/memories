#!/usr/bin/env node
/**
 * Local dev server for DeepSeek Co-Coder.
 *
 * WHY THIS EXISTS
 * ---------------
 * Opening index.html straight off the disk (file:///...) cannot work:
 *
 *   1. Firefox gives every file:// document its own opaque origin
 *      (privacy.file_unique_origin), so the browser refuses to load app.js from
 *      file:// -> "Cross-Origin Request Blocked ... (Reason: CORS request not http)".
 *      app.js never runs, so nothing in the UI is wired up.
 *   2. fetch("/api/chat") resolves to file:///api/chat, which does not exist.
 *   3. chat.deepseek.com answers CORS preflights with 403 and no
 *      Access-Control-Allow-Origin, so the free Web-session-token channel is
 *      impossible from any browser origin. It only works from a server.
 *
 * Serving the app over http://localhost and proxying /api/chat here fixes all
 * three: same-origin static assets, same-origin API, and the DeepSeek calls
 * happen from Node where CORS does not apply.
 *
 * Usage:  node server.mjs [--port 8787] [--no-open]
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import chatHandler from "./api/chat.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const getFlag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const PORT = Number(getFlag("--port") || process.env.PORT || 8000);
const HOST = "127.0.0.1";
const OPEN_BROWSER = !argv.includes("--no-open");

const APP_ENTRY = "/index.html";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".zip": "application/zip",
};

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

function resolveRequestPath(urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/") rel = APP_ENTRY;
  if (rel.endsWith("/")) rel += "index.html";

  const abs = path.resolve(ROOT, "." + path.posix.normalize(rel));
  // Block path traversal outside the project root.
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

function serveStatic(req, res) {
  const abs = resolveRequestPath(req.url || "/");
  if (!abs) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("403 — path escapes the project root.");
  }

  fs.stat(abs, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(
        `<h1>404</h1><p>Not found: <code>${abs}</code></p>` +
          `<p>Start here: <a href="${APP_ENTRY}">${APP_ENTRY}</a></p>`
      );
    }

    const type = MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": stat.size,
      // Dev server: never let the browser serve a stale app.js.
      "Cache-Control": "no-store, must-revalidate",
    });

    if (req.method === "HEAD") return res.end();

    const stream = fs.createReadStream(abs);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  });
}

// ---------------------------------------------------------------------------
// /api/chat — Vercel handler shim
// ---------------------------------------------------------------------------

function statusCodesShim(res) {
  res.status = (code) => {
    res.statusCode = code;
    return {
      json(obj) {
        if (!res.headersSent) res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(obj));
      },
      end() {
        res.end();
      },
    };
  };
  return res;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error("Invalid JSON body: " + err.message));
      }
    });
    req.on("error", reject);
  });
}

async function handleApiChat(req, res) {
  const origin = req.headers.origin || '';
  const isLocalOrigin = origin === 'null' || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (isLocalOrigin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "Method not allowed. Use POST." }));
  }

  try {
    req.body = await readJsonBody(req);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: err.message }));
  }

  // Long-lived SSE streams must not be cut off by socket timeouts.
  req.socket.setTimeout(0);

  try {
    await chatHandler(req, statusCodesShim(res));
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    }
    res.write(`data: ${JSON.stringify({ error: "Proxy crashed: " + (err?.message || String(err)) })}\n\n`);
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const pathname = (req.url || "/").split("?")[0];

  if (pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true, service: "school-memory-local", root: ROOT }));
  }

  if (pathname === "/api/chat") return handleApiChat(req, res);

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("405 — static server only accepts GET/HEAD.");
  }

  serveStatic(req, res);
});

server.keepAliveTimeout = 0;
server.headersTimeout = 0;

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Either that instance is already running (just open the URL below),`);
    console.error(`  or start on another port:  node server.mjs --port ${PORT + 1}\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}${APP_ENTRY}`;
  console.log(`\n  SchoolMemory is running`);
  console.log(`  ${url}`);
  console.log(`\n  Keep this window open while you use the app. Ctrl+C to stop.\n`);

  if (!OPEN_BROWSER) return;
  const opener =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try {
    spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* the user can open the URL manually */
  }
});

