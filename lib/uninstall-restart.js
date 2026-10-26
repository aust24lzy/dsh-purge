import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const encoded = process.env.DSH_PURGE_RESTART;
if (!encoded) process.exit(1);

let info;
try {
  info = JSON.parse(encoded);
} catch {
  process.exit(1);
}

const port = Number(info.port) || 3080;
const host = typeof info.host === "string" && info.host ? info.host : "127.0.0.1";
const cleanup = Array.isArray(info.cleanup) ? info.cleanup : [];

function spawnEnv() {
  const env = { ...process.env };
  delete env.DSH_PERMISSION_MODE;
  delete env.DSH_PURGE_RESTART;
  return env;
}

function portFree() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(true));
  });
}

async function waitFree() {
  for (let i = 0; i < 80; i++) {
    if (await portFree()) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

function rmTree(dir) {
  if (!dir) return;
  // 不用 fs.rmSync({recursive})：cleanup 目标里可能有 junction（app/runtime），
  // 递归删会跟进目标把运行时本体删掉（issue #67）。这里只删目录项本身。
  // 本函数必须自包含：helper 会在插件包被删掉之后继续运行，不能 import 项目模块。
  const walk = (file) => {
    let st;
    try { st = fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return; throw e; }
    try {
      if (st.isSymbolicLink()) { fs.unlinkSync(file); return; }
      if (st.isDirectory()) {
        for (const name of fs.readdirSync(file)) walk(path.join(file, name));
        fs.rmdirSync(file);
      } else {
        fs.unlinkSync(file);
      }
    } catch (e) { if (e.code !== "ENOENT") throw e; }
  };
  for (let i = 0; ; i += 1) {
    try { walk(dir); return; } catch (e) {
      if (e.code === "ENOENT") return;
      if (i >= 8 || !["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"].includes(e.code)) {
        return; // 锁着就留下
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120 * (i + 1));
    }
  }
}

const ok = await waitFree();
if (!ok) process.exit(1);

for (const dir of cleanup) rmTree(dir);
if (info.helper) {
  try {
    fs.unlinkSync(info.helper);
  } catch {
    // ignore
  }
}

const child = spawn(info.execPath, info.argv, {
  detached: true,
  stdio: "ignore",
  cwd: info.cwd || process.cwd(),
  env: spawnEnv(),
  windowsHide: true,
  shell: false,
});
child.on("error", () => process.exit(1));
child.unref();
await new Promise((r) => setTimeout(r, 400));
process.exit(0);
