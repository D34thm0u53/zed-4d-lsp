// Offline unit tests for bridge/bridge.js. Run on Linux, macOS and Windows: `node --test test/bridge/unit.test.js`
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

const bridge = require("../../bridge/bridge.js");

const EXE = process.platform === "win32" ? "tool4d.exe" : "tool4d";

/** A fresh temp dir whose name contains a space (like "Application Support"/"Program Files"). */
function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "4d test "));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// ------------------------------------------------------- minimal tar builder
function tarHeader(name, size, type, mode = 0o644, link = "") {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write(mode.toString(8).padStart(7, "0") + "\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148); // checksum placeholder
  h.write(type, 156);
  h.write(link, 157, 100);
  h.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

function makeTar(entries) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.from(e.data || "");
    parts.push(tarHeader(e.name, e.type === "5" ? 0 : data.length, e.type || "0", e.mode, e.link));
    if (e.type !== "5" && data.length) {
      parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function makeAr(files) {
  const parts = [Buffer.from("!<arch>\n")];
  for (const [name, data] of Object.entries(files)) {
    const hdr = Buffer.alloc(60, " ");
    hdr.write(name + "/", 0);
    hdr.write(String(data.length), 48);
    hdr.write("`\n", 58);
    parts.push(hdr, data);
    if (data.length % 2) parts.push(Buffer.from("\n"));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ settings
test("parseArgs: defaults and overrides", () => {
  const d = bridge.parseArgs([]);
  assert.equal(d.version, "latest");
  assert.equal(d.channel, "stable");
  assert.equal(d.download, true);
  assert.equal(d.tool4d, undefined);

  const o = bridge.parseArgs([
    "--tool4d", "/x/tool4d", "--version", "21R3", "--channel", "beta",
    "--download-dir", "/dl", "--compat-dir", "/c", "--no-download",
  ]);
  assert.deepEqual(
    { ...o },
    { version: "21R3", channel: "beta", download: false, dir: "/dl", tool4d: "/x/tool4d", compat: "/c" },
  );
});

test("releaseFolder maps version settings to release folders", () => {
  assert.equal(bridge.releaseFolder("21"), "21.x/latest");
  assert.equal(bridge.releaseFolder("21R"), "21 Rx/latest");
  assert.equal(bridge.releaseFolder("21R3"), "21 Rx/21 R3");
  assert.throws(() => bridge.releaseFolder("banana"), /invalid tool4d version/);
});

test("urlFor builds the per-platform download URL", () => {
  const suffix = {
    linux: "linux/tool4d.deb",
    win32: "win/tool4d_win.tar.xz",
    darwin: (os.arch() === "arm64" ? "mac/tool4d_arm64" : "mac/tool4d_x86_64") + ".tar.xz",
  }[process.platform];
  assert.ok(suffix, "test must know this platform");
  assert.equal(bridge.platformSuffix(), suffix);
  assert.equal(
    bridge.urlFor("21 Rx/latest", "stable"),
    "https://resources-download.4d.com/release/21%20Rx/latest/latest/" + suffix,
  );
  assert.ok(bridge.urlFor("21.x/latest", "beta").endsWith("?channel=beta"));
});

// ------------------------------------------------------------ tool4d lookup
test("resolveExplicit: file, folder, nested folder, macOS bundle, missing", (t) => {
  const root = tmp(t);
  const touch = (...p) => {
    const f = path.join(root, ...p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "");
    return f;
  };
  const direct = touch("direct", EXE);
  assert.equal(bridge.resolveExplicit(direct), direct);
  assert.equal(bridge.resolveExplicit(path.join(root, "direct")), direct);

  const nested = touch("nested", "a", "b", EXE);
  assert.equal(bridge.resolveExplicit(path.join(root, "nested")), nested);

  const mac = touch("tool4d.app", "Contents", "MacOS", "tool4d");
  assert.equal(bridge.resolveExplicit(path.join(root, "tool4d.app")), mac);

  assert.equal(bridge.resolveExplicit(path.join(root, "nope")), null);
  assert.equal(bridge.resolveExplicit(""), null);
});

test("findBinary respects its depth limit", (t) => {
  const root = tmp(t);
  fs.mkdirSync(path.join(root, "a", "b", "c"), { recursive: true });
  fs.writeFileSync(path.join(root, "a", "b", "c", EXE), "");
  assert.equal(bridge.findBinary(root, 3), path.join(root, "a", "b", "c", EXE));
  assert.equal(bridge.findBinary(root, 1), null);
});

// ---------------------------------------------------------------- archives
test("untar writes files, dirs, modes and symlinks", { skip: process.platform === "win32" && "symlinks need privileges" }, (t) => {
  const dest = tmp(t);
  bridge.untar(
    makeTar([
      { name: "opt/", type: "5" },
      { name: "opt/tool4d", data: "bin", mode: 0o755 },
      { name: "opt/link", type: "2", link: "tool4d" },
    ]),
    dest,
  );
  assert.equal(fs.readFileSync(path.join(dest, "opt", "tool4d"), "utf8"), "bin");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(dest, "opt", "tool4d")).mode & 0o111, 0o111);
  }
  assert.equal(fs.readlinkSync(path.join(dest, "opt", "link")), "tool4d");
});

test("untar writes files on every platform (no symlinks)", (t) => {
  const dest = tmp(t);
  bridge.untar(makeTar([{ name: "./a/b.txt", data: "hi" }]), dest);
  assert.equal(fs.readFileSync(path.join(dest, "a", "b.txt"), "utf8"), "hi");
});

test("untar rejects path traversal", (t) => {
  const dest = tmp(t);
  assert.throws(() => bridge.untar(makeTar([{ name: "../evil.txt", data: "x" }]), dest), /unsafe path/);
  assert.equal(fs.existsSync(path.join(dest, "..", "evil.txt")), false);
});

test("readAr parses ar archives (odd-sized members are padded)", () => {
  const files = bridge.readAr(makeAr({ "debian-binary": Buffer.from("2.0\n"), "data.tar.gz": Buffer.from("abc") }));
  assert.equal(files["debian-binary"].toString(), "2.0\n");
  assert.equal(files["data.tar.gz"].toString(), "abc");
  assert.throws(() => bridge.readAr(Buffer.from("nope")), /not an ar archive/);
});

test("extract: .deb with data.tar.gz", (t) => {
  const dir = tmp(t);
  const tar = makeTar([{ name: "./opt/tool4d/tool4d", data: "bin", mode: 0o755 }]);
  const deb = path.join(dir, "tool4d.deb");
  fs.writeFileSync(deb, makeAr({ "debian-binary": Buffer.from("2.0\n"), "data.tar.gz": zlib.gzipSync(tar) }));
  const out = path.join(dir, "out");
  bridge.extract(deb, out);
  assert.equal(bridge.findBinary(out, 6), path.join(out, "opt", "tool4d", "tool4d"));
});

test("extract: .tar.xz via the system tar, with spaces (and a drive letter on Windows) in the paths", (t) => {
  const dir = tmp(t);
  const stage = path.join(dir, "stage");
  fs.mkdirSync(path.join(stage, "tool4d", "Native Components"), { recursive: true });
  fs.writeFileSync(path.join(stage, "tool4d", EXE), "bin");
  fs.writeFileSync(path.join(stage, "tool4d", "Native Components", "4D Compiler.dll"), "dll");

  // Build the fixture archive with the same tar the bridge will use to read it.
  const archive = path.join(dir, "tool4d.tar.xz");
  const made = spawnSync(bridge.systemTar(), ["-cJf", archive, "tool4d"], { cwd: stage, encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr || String(made.error));

  const out = path.join(dir, "out dir");
  bridge.extract(archive, out);
  assert.equal(bridge.findBinary(out, 6), path.join(out, "tool4d", EXE));
  assert.equal(fs.readFileSync(path.join(out, "tool4d", "Native Components", "4D Compiler.dll"), "utf8"), "dll");
});

test("extract: a corrupt .tar.xz fails with an actionable message", (t) => {
  const dir = tmp(t);
  const archive = path.join(dir, "bad.tar.xz");
  fs.writeFileSync(archive, "not an archive");
  assert.throws(() => bridge.extract(archive, path.join(dir, "out")), /binary\.path/);
});

test("systemTar resolves to an existing program", () => {
  const tar = bridge.systemTar();
  if (path.isAbsolute(tar)) assert.ok(fs.existsSync(tar), tar);
  const r = spawnSync(tar, ["--version"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || String(r.error));
});
