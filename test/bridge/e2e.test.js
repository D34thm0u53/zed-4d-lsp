// End-to-end test: runs the real bridge, which downloads the real tool4d for this OS, and talks LSP to it.
// Needs network access. `node --test test/bridge/e2e.test.js`
// Set TOOL4D_PATH to skip the download and test against an existing tool4d.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..", "..");
const BRIDGE = path.join(ROOT, "bridge", "bridge.js");

/** Minimal LSP client over a child process's stdio (Content-Length framing). */
class Client {
  constructor(child) {
    this.child = child;
    this.buf = Buffer.alloc(0);
    this.pending = new Map();
    this.rejects = new Map();
    this.messages = [];
    this.nextId = 1;
    child.stdout.on("data", (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.drain();
    });
    // Fail fast if the bridge dies instead of waiting for a request timeout.
    child.on("exit", (code, sig) => {
      for (const reject of this.rejects.values()) reject(new Error(`bridge exited early (code=${code}, signal=${sig})`));
      this.rejects.clear();
    });
  }
  drain() {
    for (;;) {
      const end = this.buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const m = /Content-Length: *(\d+)/i.exec(this.buf.slice(0, end).toString("ascii"));
      assert.ok(m, "LSP header without Content-Length");
      const len = Number(m[1]);
      if (this.buf.length < end + 4 + len) return;
      const msg = JSON.parse(this.buf.slice(end + 4, end + 4 + len).toString("utf8"));
      this.buf = this.buf.slice(end + 4 + len);
      this.messages.push(msg);
      if (msg.id !== undefined && !msg.method && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      } else if (msg.id !== undefined && msg.method) {
        // Server -> client request (e.g. workspace/configuration): answer with null.
        this.send({ jsonrpc: "2.0", id: msg.id, result: null });
      }
    }
  }
  send(msg) {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }
  request(method, params, ms = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), ms);
      this.pending.set(id, (r) => { clearTimeout(timer); this.rejects.delete(id); resolve(r); });
      this.rejects.set(id, (e) => { clearTimeout(timer); reject(e); });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
}

test("bridge installs tool4d and completes an LSP handshake", { timeout: 8 * 60 * 1000 }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "4d e2e "));

  // A minimal 4D project to open.
  const project = path.join(work, "proj");
  fs.mkdirSync(path.join(project, "Project", "Sources", "Methods"), { recursive: true });
  fs.writeFileSync(path.join(project, "Project", "e2e.4DProject"), JSON.stringify({ $schema: "", version: 1 }));
  const method = path.join(project, "Project", "Sources", "Methods", "hello.4dm");
  fs.writeFileSync(method, fs.readFileSync(path.join(ROOT, "test", "sample.4dm")));

  const args = [BRIDGE, "--download-dir", path.join(work, "tool4d")];
  if (process.env.TOOL4D_PATH) args.push("--tool4d", process.env.TOOL4D_PATH);
  // Same as the extension: Linux gets the bundled compatibility libraries.
  if (process.platform === "linux") args.push("--compat-dir", path.join(work, "compat-copy"));
  if (process.platform === "linux") fs.cpSync(path.join(ROOT, "compat"), path.join(work, "compat-copy"), { recursive: true });

  const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; process.stderr.write(d); });
  const exited = new Promise((resolve) => child.on("exit", (code, sig) => resolve({ code, sig })));
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    // Windows may hold DLLs of a just-stopped tool4d for a moment; never fail the test over cleanup.
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (_) {}
  });

  const client = new Client(child);
  try {
    const init = await client.request(
      "initialize",
      {
        processId: process.pid,
        rootUri: pathToFileURL(project).href,
        capabilities: {},
        workspaceFolders: [{ uri: pathToFileURL(project).href, name: "proj" }],
        initializationOptions: { dependencies: { enable: true } },
      },
      7 * 60 * 1000, // includes the tool4d download
    );
    assert.ok(init.result && init.result.capabilities, "initialize returned no capabilities: " + JSON.stringify(init));
    client.notify("initialized", {});

    client.notify("textDocument/didOpen", {
      textDocument: { uri: pathToFileURL(method).href, languageId: "4D", version: 1, text: fs.readFileSync(method, "utf8") },
    });
    // The server must stay responsive after opening a document.
    const symbols = await client.request("textDocument/documentSymbol", { textDocument: { uri: pathToFileURL(method).href } });
    assert.equal(symbols.error, undefined, "documentSymbol error: " + JSON.stringify(symbols.error));

    const down = await client.request("shutdown", null);
    assert.equal(down.error, undefined);
    client.notify("exit", null);
    child.stdin.end();
  } catch (e) {
    e.message += `\n--- bridge stderr ---\n${stderr}`;
    throw e;
  }

  const { code } = await Promise.race([
    exited,
    new Promise((_, rej) => setTimeout(() => rej(new Error("bridge did not exit after shutdown")), 20000)),
  ]);
  assert.ok(code === 0 || code === 1, `unexpected bridge exit code ${code}`);
});
