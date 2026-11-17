#!/usr/bin/env node
// Bridge between Zed (LSP over stdio) and tool4d (LSP over TCP).
//
// tool4d is not a stdio language server: it is launched with `--lsp=<port>` and
// connects *back* to a server socket the client has opened. This script
//   1. locates (or downloads) tool4d,
//   2. listens on an ephemeral loopback port,
//   3. spawns `tool4d --lsp=<port>`,
//   4. pipes our stdin/stdout to the socket tool4d opens.
//
// Usage: node bridge.js [--tool4d <path>] [--version <spec>] [--channel <stable|beta>]
//                       [--download-dir <dir>] [--compat-dir <dir>] [--no-download]
"use strict";

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const https = require("https");
const { spawn, spawnSync } = require("child_process");

const log = (...a) => console.error("[4d-bridge]", ...a);

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
  const o = { version: "latest", channel: "stable", download: true, dir: path.join(process.cwd(), "tool4d") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tool4d") o.tool4d = argv[++i];
    else if (a === "--version") o.version = argv[++i] || "latest";
    else if (a === "--channel") o.channel = argv[++i] || "stable";
    else if (a === "--download-dir") o.dir = argv[++i];
    else if (a === "--no-download") o.download = false;
    else if (a === "--compat-dir") o.compat = argv[++i];
  }
  return o;
}

// ------------------------------------------------------------ tool4d lookup
function exeNames() {
  return process.platform === "win32" ? ["tool4d.exe"] : ["tool4d"];
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

/** Resolve a user supplied path: an executable, a tool4d.app bundle or a directory. */
function resolveExplicit(p) {
  if (!p) return null;
  if (isFile(p)) return p;
  const mac = path.join(p, "Contents", "MacOS", "tool4d");
  if (isFile(mac)) return mac;
  for (const n of exeNames()) {
    const c = path.join(p, n);
    if (isFile(c)) return c;
  }
  return findBinary(p, 4);
}

/** Depth-limited search for the tool4d executable below `dir`. */
function findBinary(dir, depth) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
  for (const e of entries) {
    if (e.isFile() && exeNames().includes(e.name)) return path.join(dir, e.name);
  }
  if (depth <= 0) return null;
  for (const e of entries) {
    if (e.isDirectory()) {
      const r = findBinary(path.join(dir, e.name), depth - 1);
      if (r) return r;
    }
  }
  return null;
}

function onPath() {
  const sep = process.platform === "win32" ? ";" : ":";
  for (const d of (process.env.PATH || "").split(sep)) {
    for (const n of exeNames()) {
      const c = path.join(d, n);
      if (d && isFile(c)) return c;
    }
  }
  return null;
}

function wellKnownLocations() {
  const home = os.homedir();
  const l = [];
  if (process.platform === "linux") l.push("/opt/tool4d/tool4d");
  if (process.platform === "darwin") {
    l.push("/Applications/tool4d.app/Contents/MacOS/tool4d", path.join(home, "Applications/tool4d.app/Contents/MacOS/tool4d"));
  }
  // Reuse a copy the official VS Code 4D-Analyzer extension already downloaded.
  const vscodeStores = [];
  if (process.platform === "linux") vscodeStores.push(path.join(home, ".config/Code/User/globalStorage"));
  if (process.platform === "darwin") vscodeStores.push(path.join(home, "Library/Application Support/Code/User/globalStorage"));
  if (process.platform === "win32" && process.env.APPDATA) vscodeStores.push(path.join(process.env.APPDATA, "Code/User/globalStorage"));
  for (const s of vscodeStores) {
    const r = findBinary(path.join(s, "4d.4d-analyzer"), 5);
    if (r) l.push(r);
  }
  return l.filter(isFile);
}

// --------------------------------------------------------------- downloading
const BASE = "https://resources-download.4d.com/release/";

function platformSuffix() {
  switch (process.platform) {
    case "linux": return "linux/tool4d.deb";
    case "darwin": return (os.arch() === "arm64" ? "mac/tool4d_arm64" : "mac/tool4d_x86_64") + ".tar.xz";
    case "win32": return "win/tool4d_win.tar.xz";
    default: throw new Error("unsupported platform " + process.platform);
  }
}

/** Map a version setting ("latest", "20", "20R", "21R3") to a release folder. */
function releaseFolder(spec) {
  let m;
  if ((m = /^(\d+)$/.exec(spec))) return `${m[1]}.x/latest`;
  if ((m = /^(\d+)R$/.exec(spec))) return `${m[1]} Rx/latest`;
  if ((m = /^(\d+)R(\d+)$/.exec(spec))) return `${m[1]} Rx/${m[1]} R${m[2]}`;
  throw new Error(`invalid tool4d version '${spec}' (use latest, 21, 21R or 21R3)`);
}

function urlFor(folder, channel) {
  let u = BASE + folder.split("/").map(encodeURIComponent).join("/") + "/latest/" + platformSuffix();
  if (channel === "beta") u += "?channel=beta";
  return u;
}

/** HEAD without following redirects; resolves to {status, location}. */
function head(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "HEAD", timeout: 15000 }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function exists(url) {
  const r = await head(url);
  return r.status === 200 || r.status === 302;
}

async function resolveLatest(channel) {
  // Highest major that exists; prefer its R-release stream when published.
  let major = 20;
  while (await exists(urlFor(`${major + 1}.x/latest`, channel)) || await exists(urlFor(`${major + 1} Rx/latest`, channel))) major++;
  const r = urlFor(`${major} Rx/latest`, channel);
  return (await exists(r)) ? `${major} Rx/latest` : `${major}.x/latest`;
}

function downloadTo(url, file, redirects = 6) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(downloadTo(new URL(res.headers.location, url).toString(), file, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const out = fs.createWriteStream(file);
      res.pipe(out);
      out.on("finish", () => out.close(resolve));
      out.on("error", reject);
      res.on("error", reject);
    }).on("error", reject);
  });
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  if (r.error || r.status !== 0) {
    throw new Error(`'${cmd} ${args.join(" ")}' failed: ${r.error ? r.error.message : r.stderr}`);
  }
}

/**
 * The `tar` to use for .tar.xz archives. It must understand xz, which only bsdtar
 * (macOS, Windows 10+) and GNU tar with xz installed do. On Windows a bare `tar` may
 * resolve to GNU tar from Git for Windows, so use the OS-provided bsdtar by absolute path.
 */
function systemTar() {
  if (process.platform === "win32") {
    const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    const bsdtar = path.join(root, "System32", "tar.exe");
    if (isFile(bsdtar)) return bsdtar;
  } else if (process.platform === "darwin" && isFile("/usr/bin/tar")) {
    return "/usr/bin/tar";
  }
  return "tar";
}

/** Extract `archive` into `dest` with the system tar. */
function tarExtract(archive, dest, flag) {
  try {
    // Run inside the archive's folder with a relative name: GNU tar treats "C:\\..." as host:path.
    run(systemTar(), [flag, path.basename(archive), "-C", dest], path.dirname(archive));
  } catch (e) {
    throw new Error(`${e.message}\nCould not unpack tool4d. Install tool4d manually and set lsp.4d-analyzer.binary.path.`);
  }
}

/** rename() that retries: Windows antivirus/indexers briefly lock freshly written trees. */
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (i >= 8 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * (i + 1));
    }
  }
}

// ---- minimal `ar` + `tar` readers so Linux needs no external tools ----------
function readAr(buf) {
  if (buf.slice(0, 8).toString() !== "!<arch>\n") throw new Error("not an ar archive");
  const files = {};
  let off = 8;
  while (off + 60 <= buf.length) {
    const name = buf.slice(off, off + 16).toString().trim().replace(/\/$/, "");
    const size = parseInt(buf.slice(off + 48, off + 58).toString().trim(), 10);
    off += 60;
    files[name] = buf.slice(off, off + size);
    off += size + (size % 2);
  }
  return files;
}

function cstr(b) {
  const i = b.indexOf(0);
  return b.slice(0, i < 0 ? b.length : i).toString("utf8");
}

function untar(buf, dest) {
  const root = path.resolve(dest);
  let off = 0, longName = null, paxPath = null;
  const target = (name) => {
    const t = path.resolve(root, name);
    if (t !== root && !t.startsWith(root + path.sep)) throw new Error("unsafe path in archive: " + name);
    return t;
  };
  while (off + 512 <= buf.length) {
    const h = buf.slice(off, off + 512);
    if (h.every((x) => x === 0)) break;
    let name = cstr(h.slice(0, 100));
    const mode = parseInt(cstr(h.slice(100, 108)).trim() || "0", 8) || 0o644;
    const size = parseInt(cstr(h.slice(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const link = cstr(h.slice(157, 257));
    if (cstr(h.slice(257, 262)) === "ustar") {
      const prefix = cstr(h.slice(345, 500));
      if (prefix) name = prefix + "/" + name;
    }
    off += 512;
    const data = buf.slice(off, off + size);
    off += Math.ceil(size / 512) * 512;

    if (type === "L") { longName = cstr(data); continue; }
    if (type === "x") {
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      if (m) paxPath = m[1];
      continue;
    }
    if (type === "g") continue;
    if (longName) { name = longName; longName = null; }
    if (paxPath) { name = paxPath; paxPath = null; }
    name = name.replace(/^\.\//, "");
    if (!name) continue;
    const t = target(name);
    if (type === "5") {
      fs.mkdirSync(t, { recursive: true });
    } else if (type === "0" || type === "\0") {
      fs.mkdirSync(path.dirname(t), { recursive: true });
      fs.writeFileSync(t, data, { mode: mode & 0o777 });
    } else if (type === "2") {
      fs.mkdirSync(path.dirname(t), { recursive: true });
      fs.rmSync(t, { force: true });
      fs.symlinkSync(link, t);
    } else if (type === "1") {
      const src = target(link.replace(/^\.\//, ""));
      fs.mkdirSync(path.dirname(t), { recursive: true });
      fs.copyFileSync(src, t);
    }
  }
}

function extract(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (archive.endsWith(".deb")) {
    // A .deb is an `ar` archive holding data.tar.{zst,gz,xz}.
    const files = readAr(fs.readFileSync(archive));
    const entry = Object.keys(files).find((f) => f.startsWith("data.tar"));
    if (!entry) throw new Error("no data.tar.* inside the .deb");
    const zlib = require("zlib");
    let tar;
    if (entry.endsWith(".zst") && zlib.zstdDecompressSync) tar = zlib.zstdDecompressSync(files[entry]);
    else if (entry.endsWith(".gz")) tar = zlib.gunzipSync(files[entry]);
    else if (entry.endsWith(".tar")) tar = files[entry];
    else {
      // .xz (or zstd on an old Node): hand over to the system tar.
      const f = path.join(dest, entry);
      fs.writeFileSync(f, files[entry]);
      tarExtract(f, dest, "-xf");
      fs.rmSync(f, { force: true });
      return;
    }
    untar(tar, dest);
  } else {
    // macOS and Windows ship bsdtar, which reads .tar.xz natively.
    tarExtract(archive, dest, "-xJf");
  }
}

async function ensureTool4d(opts) {
  const cacheRoot = opts.dir;
  const cached = () => {
    // newest cached install, used when offline
    try {
      const dirs = fs.readdirSync(cacheRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("."));
      dirs.sort((a, b) => fs.statSync(path.join(cacheRoot, b.name)).mtimeMs - fs.statSync(path.join(cacheRoot, a.name)).mtimeMs);
      for (const d of dirs) {
        const b = findBinary(path.join(cacheRoot, d.name), 6);
        if (b) return b;
      }
    } catch (_) {}
    return null;
  };

  let folder, url, res;
  try {
    folder = opts.version === "latest" ? await resolveLatest(opts.channel) : releaseFolder(opts.version);
    url = urlFor(folder, opts.channel);
    res = await head(url);
  } catch (e) {
    const c = cached();
    if (c) { log("offline, using cached tool4d:", c); return c; }
    throw e;
  }
  if (res.status !== 302 || !res.location) throw new Error(`cannot resolve tool4d download (HTTP ${res.status}) for ${url}`);

  // e.g. 4D_installer_tool_linux_intl_release_21R4_100224.deb -> "21R4_100224"
  const fileName = decodeURIComponent(new URL(res.location).pathname.split("/").pop()).replace(/\.[^.]+(\.[^.]+)?$/, "");
  const key = fileName.replace(/[^A-Za-z0-9._-]/g, "_") + (opts.channel === "beta" ? "_beta" : "");
  const installDir = path.join(cacheRoot, key);
  const have = findBinary(installDir, 6);
  if (have) return have;

  log(`downloading tool4d (${folder}) ...`);
  fs.mkdirSync(cacheRoot, { recursive: true });
  const tmp = path.join(cacheRoot, ".dl-" + process.pid);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const archive = path.join(tmp, process.platform === "linux" ? "tool4d.deb" : "tool4d.tar.xz");
  await downloadTo(url, archive);
  log("extracting ...");
  const stage = path.join(tmp, "x");
  extract(archive, stage);
  fs.rmSync(archive, { force: true });
  fs.rmSync(installDir, { recursive: true, force: true });
  renameRetry(stage, installDir);
  fs.rmSync(tmp, { recursive: true, force: true });
  const bin = findBinary(installDir, 6);
  if (!bin) throw new Error("tool4d executable not found after extraction");
  if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
  log("installed", bin);
  return bin;
}

async function locateTool4d(opts) {
  const explicit = resolveExplicit(opts.tool4d || process.env.TOOL4D_PATH);
  if (explicit) return explicit;
  if (opts.tool4d) throw new Error(`configured tool4d path not found: ${opts.tool4d}`);
  const found = onPath() || wellKnownLocations()[0];
  if (found) return found;
  if (!opts.download) throw new Error("tool4d not found; set lsp.4d-analyzer.binary.path");
  return ensureTool4d(opts);
}

// ------------------------------------------------- Linux shared-library shims
// tool4d links libc++, libc++abi, libunwind.so.1 and libfreeimage.so.3, which many
// distributions (Fedora, Arch, ...) do not ship under those names. The extension
// bundles compatible copies; we expose only the ones the system lacks, so a real
// system library is never shadowed.
const COMPAT_LIBS = ["libc++.so.1", "libc++abi.so.1", "libunwind.so.1", "libfreeimage.so.3"];

function systemHas(lib) {
  if (process.env.FOURD_FORCE_COMPAT) return false; // testing aid
  const dirs = ["/lib64", "/usr/lib64", "/lib", "/usr/lib", "/usr/local/lib", "/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu"];
  for (const d of (process.env.LD_LIBRARY_PATH || "").split(":")) if (d) dirs.unshift(d);
  try {
    const conf = fs.readFileSync("/etc/ld.so.conf", "utf8");
    for (const l of conf.split("\n")) if (l.startsWith("/")) dirs.push(l.trim());
  } catch (_) {}
  try {
    for (const f of fs.readdirSync("/etc/ld.so.conf.d")) {
      for (const l of fs.readFileSync(path.join("/etc/ld.so.conf.d", f), "utf8").split("\n")) if (l.startsWith("/")) dirs.push(l.trim());
    }
  } catch (_) {}
  return dirs.some((d) => fs.existsSync(path.join(d, lib)));
}

function childEnv(opts, tool4d) {
  const env = { ...process.env };
  if (process.platform !== "linux" || !opts.compat) return env;
  const active = path.join(opts.compat, "active");
  fs.rmSync(active, { recursive: true, force: true });
  fs.mkdirSync(active, { recursive: true });
  let used = 0;
  for (const lib of COMPAT_LIBS) {
    const src = path.join(opts.compat, "linux-x64", lib);
    // A copy bundled next to tool4d itself (rpath $ORIGIN/lib) also counts.
    if (fs.existsSync(src) && !systemHas(lib) && !fs.existsSync(path.join(path.dirname(tool4d), "lib", lib))) {
      fs.copyFileSync(src, path.join(active, lib));
      used++;
    }
  }
  if (used) {
    env.LD_LIBRARY_PATH = active + (env.LD_LIBRARY_PATH ? ":" + env.LD_LIBRARY_PATH : "");
    log(`providing ${used} bundled compatibility librar${used === 1 ? "y" : "ies"}`);
  }
  return env;
}

// ------------------------------------------------------------------ bridging
let child = null;
let finished = false;
let server = null;

function shutdown(code) {
  if (finished) return;
  finished = true;
  try { server && server.close(); } catch (_) {}
  if (child && child.exitCode === null) { try { child.kill(); } catch (_) {} }
  setTimeout(() => process.exit(code), 50);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  process.stdin.on("end", () => shutdown(0));
  process.stdin.on("close", () => shutdown(0));
  process.stdout.on("error", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));

  const tool4d = await locateTool4d(opts);
  log("using", tool4d);

  server = net.createServer((sock) => {
    sock.setNoDelay(true);
    process.stdin.pipe(sock);
    sock.pipe(process.stdout);
    sock.on("close", () => shutdown(0));
    sock.on("error", () => shutdown(1));
  });
  server.on("error", (e) => { log("listen error:", e.message); shutdown(1); });

  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    // tool4d's own diagnostics go to stderr (shown in Zed's LSP log); stdout is the protocol channel.
    child = spawn(tool4d, ["--lsp=" + port], { stdio: ["ignore", "ignore", "pipe"], env: childEnv(opts, tool4d) });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("error", (e) => { log("failed to start tool4d:", e.message); shutdown(1); });
    child.on("exit", (code, sig) => {
      log(`tool4d exited (code=${code}, signal=${sig})`);
      shutdown(code === 0 ? 0 : 1);
    });
  });
}

if (require.main === module) {
  main().catch((e) => {
    log("fatal:", e.message);
    shutdown(1);
  });
} else {
  module.exports = {
    parseArgs, releaseFolder, urlFor, platformSuffix, resolveExplicit,
    findBinary, readAr, untar, extract, systemTar,
  };
}
