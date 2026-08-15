const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const PORT = process.env.PORT || 3000;
const BRIDGE_PORT = 19877;
const SECRET = process.env.BRIDGE_SECRET || "doi-ngay-chuoi-nay";

console.log("[boot] starting internal sign_bridge on", BRIDGE_PORT);

const bridge = spawn("node", ["sign_bridge.js", "--serve", String(BRIDGE_PORT)], {
  cwd: __dirname,
  stdio: ["ignore", "pipe", "pipe"]
});

bridge.stdout.on("data", (d) => process.stdout.write("[bridge-out] " + d));
bridge.stderr.on("data", (d) => process.stderr.write("[bridge-err] " + d));
bridge.on("exit", (code) => {
  console.error("[bridge] exited with code", code);
  process.exit(1);
});

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitBridgeReady(maxMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await proxy("GET", "/health");
      if (r.status === 200) return true;
    } catch (_) {}
    await wait(500);
  }
  throw new Error("Internal sign_bridge not ready");
}

function proxy(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: BRIDGE_PORT,
        path: urlPath,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {})
        },
        timeout: 20000
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(raw || "{}") });
          } catch {
            resolve({ status: res.statusCode, json: { raw } });
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("bridge timeout"));
    });
    if (data) req.write(data);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Bridge-Secret");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const secret = req.headers["x-bridge-secret"] || "";
  if (req.url !== "/health" && secret !== SECRET) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  try {
    if (req.url === "/health" && req.method === "GET") {
      try {
        const h = await proxy("GET", "/health");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, bridge: h.json }));
      } catch (e) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    let body = "";
    for await (const chunk of req) body += chunk;
    let json = {};
    try {
      json = body ? JSON.parse(body) : {};
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    if (req.url === "/init" && req.method === "POST") {
      if (!json.encryption) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing encryption" }));
        return;
      }
      const r = await proxy("POST", "/init", {
        encryption: json.encryption,
        campRoleid: json.campRoleid || json.roleId || ""
      });
      res.writeHead(r.status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.json));
      return;
    }

    if (req.url === "/sign" && req.method === "POST") {
      const r = await proxy("POST", "/sign", {
        roleid: json.roleid || json.roleId || ""
      });
      res.writeHead(r.status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.json));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Use GET /health, POST /init, POST /sign" }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message || "server error" }));
  }
});

(async () => {
  try {
    await waitBridgeReady();
    console.log("[boot] internal bridge ready");
  } catch (e) {
    console.error("[boot] bridge failed:", e.message);
  }
  server.listen(PORT, "0.0.0.0", () => {
    console.log("[boot] public server on port", PORT);
  });
})();

process.on("SIGTERM", () => {
  try { bridge.kill(); } catch (_) {}
  process.exit(0);
});
