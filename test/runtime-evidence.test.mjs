/**
 * K/L/M —— 从社区 fork 1.6.60 移植的三块运行时证据层。
 *
 *   K: maintenance-lock —— 备份/应用/回滚互斥。锁龄不是死亡证据；
 *      只有 ESRCH 或 PID 复用才算死；跨机 / EPERM / 读不到一律不抢。
 *   L: desktop-identity —— 宿主身份证据。文件名与"有 app.asar"都不是证据，
 *      唯一判据是包元数据里的 @deepseek-ai/dsh-desktop-host + lib/cli.js。
 *   M: host-layout —— 磁盘状态 !== 已加载。state 明确区分
 *      archive_entry / unpacked_entry / unknown_runtime / different_instance / unreadable。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.join(here, "..", "lib");
const load = (rel) => import(pathToFileURL(path.join(libDir, rel)).href);
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-ev-"));

/* ============================ K. 维护锁 ============================ */

test("K1 取锁 / 放锁，guard 与 legacy 都会被清掉", async () => {
  const { acquireMaintenanceLock } = await load("maintenance-lock.js");
  const tmp = tmpdir();
  try {
    const g = acquireMaintenanceLock(tmp);
    assert.ok(fs.existsSync(path.join(tmp, "maintenance.guard")), "互斥目录应存在");
    assert.ok(fs.existsSync(path.join(tmp, "maintenance.lock")), "旧版兼容锁应存在");
    g.check();
    g.release();
    assert.equal(fs.existsSync(path.join(tmp, "maintenance.guard")), false);
    assert.equal(fs.existsSync(path.join(tmp, "maintenance.lock")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("K2 同进程二次取锁被拒（活着的持有者不能并发）", async () => {
  const { acquireMaintenanceLock } = await load("maintenance-lock.js");
  const tmp = tmpdir();
  try {
    const g = acquireMaintenanceLock(tmp);
    assert.throws(() => acquireMaintenanceLock(tmp), (e) => e.code === "MAINTENANCE_BUSY");
    g.release();
    // 释放后能重新拿到
    const g2 = acquireMaintenanceLock(tmp);
    g2.release();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("K3 死进程的锁可以回收（PID 不存在 = 确定死亡）", async () => {
  const { acquireMaintenanceLock } = await load("maintenance-lock.js");
  const tmp = tmpdir();
  try {
    const gate = path.join(tmp, "maintenance.guard");
    const stage = path.join(tmp, ".maintenance-dead");
    fs.mkdirSync(stage, { mode: 0o700 });
    fs.writeFileSync(path.join(stage, "a".repeat(32) + ".json"), JSON.stringify({
      schema: 1, host: os.hostname(), pid: 999999, createdAt: Date.now(), token: "x",
    }), { mode: 0o600 });
    fs.renameSync(stage, gate);

    const g = acquireMaintenanceLock(tmp);
    assert.ok(g);
    g.release();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("K4 活着的别人的锁绝不抢（EPERM / 存活都不等于死亡）", async () => {
  const { acquireMaintenanceLock } = await load("maintenance-lock.js");
  const tmp = tmpdir();
  try {
    const gate = path.join(tmp, "maintenance.guard");
    const stage = path.join(tmp, ".maintenance-live");
    fs.mkdirSync(stage, { mode: 0o700 });
    fs.writeFileSync(path.join(stage, "b".repeat(32) + ".json"), JSON.stringify({
      schema: 1, host: os.hostname(), pid: process.ppid, createdAt: Date.now(), token: "y",
    }), { mode: 0o600 });
    fs.renameSync(stage, gate);

    assert.throws(() => acquireMaintenanceLock(tmp), (e) => e.code === "MAINTENANCE_BUSY");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("K5 跨机锁不抢（归属无法确认时宁阻塞）", async () => {
  const { acquireMaintenanceLock } = await load("maintenance-lock.js");
  const tmp = tmpdir();
  try {
    const gate = path.join(tmp, "maintenance.guard");
    const stage = path.join(tmp, ".maintenance-remote");
    fs.mkdirSync(stage, { mode: 0o700 });
    fs.writeFileSync(path.join(stage, "c".repeat(32) + ".json"), JSON.stringify({
      schema: 1, host: "some-other-machine", pid: process.ppid, createdAt: Date.now(), token: "z",
    }), { mode: 0o600 });
    fs.renameSync(stage, gate);

    assert.throws(() => acquireMaintenanceLock(tmp), (e) => e.code === "MAINTENANCE_BUSY");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("K6 锁文件被换成 symlink 时拒绝（防写入被引到别处）", async (t) => {
  const { acquireMaintenanceLock } = await load("maintenance-lock.js");
  const tmp = tmpdir();
  try {
    const outside = path.join(tmp, "outside.txt");
    fs.writeFileSync(outside, "victim");
    const legacy = path.join(tmp, "maintenance.lock");
    try {
      fs.symlinkSync(outside, legacy);
    } catch {
      return t.skip("本机不允许创建 symlink");
    }
    // 走一遍取锁：normal(regular) 会因为 nlink 判定失败或 unlink 指向目标导致后续异常，
    // 关键是不能把 outside.txt 的内容当成锁读进来。
    let thrown = null;
    try { acquireMaintenanceLock(tmp); } catch (e) { thrown = e; }
    assert.ok(thrown, "类型异常的锁必须报错，不能静默接受");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("K7 withMaintenanceLock 在 fn 抛错时也释放锁", async () => {
  const { withMaintenanceLock } = await load("maintenance-lock.js");
  const tmp = tmpdir();
  try {
    await assert.rejects(
      withMaintenanceLock(tmp, async () => { throw new Error("boom"); }),
      /boom/,
    );
    assert.equal(fs.existsSync(path.join(tmp, "maintenance.guard")), false, "异常路径也要释放");
    // 还能重新拿
    await withMaintenanceLock(tmp, async () => {});
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("K8 core 的备份/应用/回滚入口都接了维护锁", () => {
  const src = fs.readFileSync(path.join(libDir, "core.js"), "utf8");
  assert.match(src, /export async function withHostMaintenance/, "应有统一入口");
  for (const fn of ["backupAll", "revertAll", "applyPatches", "applyPatchesAllHosts", "revertAllHosts"]) {
    const i = src.indexOf("export async function " + fn);
    assert.ok(i >= 0, fn + " 应存在");
    // 函数体里必须出现 withHostMaintenance 或 noLock 分支
    const seg = src.slice(i, i + 2400);
    assert.ok(
      /withHostMaintenance|options.noLock === true/.test(seg),
      fn + " 必须走维护锁（或显式 noLock 分支）",
    );
  }
});

/* ============================ L. 桌面身份证据 ============================ */

/** 造一个假的 electron resources 目录，含 bundled host 的元数据。 */
function seedBundledHost(root) {
  const hostDir = path.join(root, "app", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host");
  fs.mkdirSync(path.join(hostDir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(hostDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-desktop-host", version: "0.2.1-rc.3" }));
  fs.writeFileSync(path.join(hostDir, "lib", "cli.js"), "// cli");
}

test("L1 已解开目录 + 正确元数据 → bundled-host", async () => {
  const { desktopIdentity } = await load("desktop-identity.js");
  const tmp = tmpdir();
  try {
    seedBundledHost(tmp);
    const id = desktopIdentity(tmp);
    assert.equal(id?.kind, "bundled-host");
    assert.equal(id.package, "@deepseek-ai/dsh-desktop-host");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("L2 只是名字像 / 有 app.asar 但没有元数据 → null（不是宿主）", async () => {
  const { desktopIdentity } = await load("desktop-identity.js");
  const tmp = tmpdir();
  try {
    fs.mkdirSync(path.join(tmp, "app"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "app", "package.json"), JSON.stringify({ name: "some-electron-app" }));
    assert.equal(desktopIdentity(tmp), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("L3 元数据对但没有 lib/cli.js → null（不完整不算宿主）", async () => {
  const { desktopIdentity } = await load("desktop-identity.js");
  const tmp = tmpdir();
  try {
    const hostDir = path.join(tmp, "app", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host");
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(hostDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-desktop-host" }));
    assert.equal(desktopIdentity(tmp), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("L4 读到损坏的归档时必须抛错，不能退化成 null", async () => {
  const { desktopIdentity } = await load("desktop-identity.js");
  const tmp = tmpdir();
  try {
    fs.mkdirSync(path.join(tmp, "app"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "app.asar"), Buffer.from("not a real asar"));
    assert.throws(() => desktopIdentity(tmp), /Invalid desktop ASAR|asar/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("L5 hasDesktopIdentity 把异常吞成 false（高频探测路径）", async () => {
  const { hasDesktopIdentity } = await load("desktop-identity.js");
  const tmp = tmpdir();
  try {
    fs.writeFileSync(path.join(tmp, "app.asar"), Buffer.from("broken"));
    assert.equal(hasDesktopIdentity(tmp), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("L6 空的 resources 目录 → null（确认不是宿主，不是读失败）", async () => {
  const { desktopIdentity } = await load("desktop-identity.js");
  const tmp = tmpdir();
  try {
    assert.equal(desktopIdentity(tmp), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("L7 desktop.js 的官方宿主判定接了身份证据", () => {
  const src = fs.readFileSync(path.join(libDir, "desktop.js"), "utf8");
  assert.match(src, /import \{ desktopIdentity, hasDesktopIdentity \} from "\.\/desktop-identity\.js"/);
  const i = src.indexOf("export function isOfficialHarnessExecutable");
  assert.ok(i >= 0);
  const seg = src.slice(i, i + 1600);
  assert.match(seg, /desktopIdentity\(resources\)/, "判定要看包元数据，不只是文件名");
});

/* ============================ M. 布局证据 ============================ */

test("M1 没有入口证据 → unknown_runtime（并说明不能证明已加载）", async () => {
  const { hostLayoutEvidence } = await load("host-layout.js");
  const tmp = tmpdir();
  try {
    fs.mkdirSync(path.join(tmp, "app"), { recursive: true });
    const ev = hostLayoutEvidence({ resources: tmp, argv: ["node", "x"], execArgv: [] });
    assert.equal(ev.state, "unknown_runtime");
    assert.equal(ev.disk.unpacked_exists, true);
    assert.equal(ev.disk.archive_exists, false);
    assert.match(ev.note, /不能证明已加载|未取得/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("M2 入口指向 app.asar 且同一点 → archive_entry / matches_target=true", async () => {
  const { hostLayoutEvidence } = await load("host-layout.js");
  const tmp = tmpdir();
  try {
    const resources = path.join(tmp, "resources");
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(resources, "app.asar"), "x");
    const ev = hostLayoutEvidence({
      resources,
      execArgv: [],
      argv: ["electron", "--app-path=" + path.join(resources, "app.asar")],
      platform: "win32",
    });
    assert.equal(ev.state, "archive_entry");
    assert.equal(ev.process.entry_layout, "archive");
    assert.equal(ev.process.source, "app-path");
    assert.equal(ev.process.matches_target, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("M3 入口指向解包目录 → unpacked_entry", async () => {
  const { hostLayoutEvidence } = await load("host-layout.js");
  const tmp = tmpdir();
  try {
    const resources = path.join(tmp, "resources");
    fs.mkdirSync(path.join(resources, "app"), { recursive: true });
    const ev = hostLayoutEvidence({
      resources,
      execArgv: [],
      argv: ["electron", path.join(resources, "app", "main.js")],
      platform: "win32",
    });
    assert.equal(ev.state, "unpacked_entry");
    assert.equal(ev.process.entry_layout, "unpacked");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("M4 入口指向另一份安装 → different_instance（不能用它证明目标已加载）", async () => {
  const { hostLayoutEvidence } = await load("host-layout.js");
  const tmp = tmpdir();
  try {
    const resources = path.join(tmp, "resources");
    fs.mkdirSync(path.join(resources, "app"), { recursive: true });
    const other = path.join(tmp, "OTHER", "resources", "app");
    fs.mkdirSync(other, { recursive: true });
    const ev = hostLayoutEvidence({
      resources,
      execArgv: [],
      argv: ["electron", path.join(other, "main.js")],
      platform: "win32",
    });
    assert.equal(ev.state, "different_instance");
    assert.equal(ev.process.matches_target, false);
    assert.match(ev.note, /不能用此进程证明/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("M5 磁盘探测出错 → unreadable，绝不报成绿", async () => {
  const { hostLayoutEvidence } = await load("host-layout.js");
  const badReader = {
    statSync() {
      const e = new Error("denied");
      e.code = "EACCES";
      throw e;
    },
  };
  const ev = hostLayoutEvidence({ resources: "C:/whatever/resources", reader: badReader, argv: ["node", "x"], execArgv: [] });
  assert.equal(ev.state, "unreadable");
  assert.equal(ev.disk.archive_exists, null);
  assert.ok(ev.errors && ev.errors.length > 0, "错误要保留");
});

test("M6 只采信 --app-path / argv[1]，不扫描整条命令行", async () => {
  const { hostLayoutEvidence } = await load("host-layout.js");
  const tmp = tmpdir();
  try {
    const resources = path.join(tmp, "resources");
    fs.mkdirSync(path.join(resources, "app"), { recursive: true });
    const ev = hostLayoutEvidence({
      resources,
      execArgv: [],
      // 提示词里带一个像入口的路径：不能被当成入口证据
      argv: ["electron", "--some-flag", "user prompt mentioning " + path.join(resources, "app", "main.js")],
      platform: "win32",
    });
    assert.equal(ev.state, "unknown_runtime", "argv[1] 是 flag，不应采信");
    assert.equal(ev.process.source, "unknown");
    assert.equal(JSON.stringify(ev).includes("user prompt"), false, "命令行内容不得带进证据");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("M7 resourcesOfHost 归一安装根 / @deepseek-ai / 归档内路径", async () => {
  const { resourcesOfHost } = await load("host-layout.js");
  assert.equal(
    resourcesOfHost("D:/app/resources/app/dsh/node_modules/@deepseek-ai").replace(/\\/g, "/"),
    "D:/app/resources",
  );
  assert.equal(resourcesOfHost("D:/app/resources/app.asar/dsh").replace(/\\/g, "/"), "D:/app/resources");
  assert.equal(resourcesOfHost("D:/app/resources").replace(/\\/g, "/"), "D:/app/resources");
  assert.equal(resourcesOfHost("D:/nothing/here"), "");
});

test("M8 gatherState 暴露 host_layout", () => {
  const src = fs.readFileSync(path.join(libDir, "core.js"), "utf8");
  assert.match(src, /import \* as hostLayout from "\.\/host-layout\.js"/);
  assert.match(src, /host_layout: aiBase/, "state 里要有 host_layout");
});
