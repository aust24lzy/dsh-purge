/**
 * U —— 保险柜（host-backups）的 home 隔离回归。
 *
 * 踩过的坑：vaultBakPath 内部默认 findDshHome()，读的是 process.env.DSH_HOME。
 * 当调用方在操作**另一份**宿主（测试副本 / 多 profile / DSH_BASE 指定）时，
 * 那份宿主的快照会被写进当前用户的保险柜，污染生产备份。
 * 实测：测试 0.2.1 副本的 14 份 .bak 写进了生产 home（62 → 76）。
 *
 * 修复：readOfficialSnapshot / writeOfficialSnapshot / ensureOfficialSnapshot
 * 全部接受显式 home；backupAll / revertAll 从 options.dshHome 传入。
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
const read = (rel) => fs.readFileSync(path.join(libDir, rel), "utf8");

test("U1 快照三函数都接受显式 home 参数", () => {
  const src = read("core.js");
  assert.match(src, /function readOfficialSnapshot\(fp, home\)/, "readOfficialSnapshot 要有 home");
  assert.match(src, /function writeOfficialSnapshot\(fp, buf, home\)/, "writeOfficialSnapshot 要有 home");
  assert.match(src, /function ensureOfficialSnapshot\(fp, home\)/, "ensureOfficialSnapshot 要有 home");
});

test("U2 backupAll 从 options.dshHome 取保险柜 home，而非 process.env", () => {
  const src = read("core.js");
  assert.match(src, /const vaultHome = options\.dshHome \|\| findDshHome\(\)/, "backupAll 要算 vaultHome");
  const i = src.indexOf("export async function backupAll");
  const seg = src.slice(i, i + 3200);
  assert.match(seg, /readOfficialSnapshot\(fp, vaultHome\)/, "读要传 vaultHome");
  assert.match(seg, /writeOfficialSnapshot\(fp, [^)]*vaultHome\)/, "写要传 vaultHome");
});

test("U3 快照函数体里不再出现裸 findDshHome() 作为唯一来源", () => {
  const src = read("core.js");
  for (const fn of ["readOfficialSnapshot", "writeOfficialSnapshot"]) {
    const i = src.indexOf("function " + fn);
    const seg = src.slice(i, i + 900);
    // 允许 `home ? home : findDshHome()` 这种兜底，但不允许直接用 findDshHome() 当唯一来源
    assert.ok(!/vaultBakPath\(fp\)/.test(seg), fn + " 不应再调用 vaultBakPath(fp) 而不传 home");
  }
});

test("U4 隔离 home 下 backupAll 不写生产保险柜", async () => {
  const core = await load("core.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-iso-"));
  const host = path.join(tmp, "host", "node_modules", "@deepseek-ai");
  const isoHome = path.join(tmp, "isolated-home");
  try {
    // 造一个最小宿主，含一个会被备份的文件
    const pkg = path.join(host, "dsh-agent-instructions", "lib");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "index.js"), "// official content, no marker");
    fs.writeFileSync(path.join(host, "dsh-agent-instructions", "package.json"), "{}");

    const prodVault = path.join(process.env.USERPROFILE || os.homedir(), ".dsh", "dsh-purge", "host-backups");
    const before = fs.existsSync(prodVault)
      ? fs.readdirSync(prodVault).filter((n) => n.endsWith(".bak")).length
      : -1;

    const r = await core.backupAll(host, { noLock: true, dshHome: isoHome });
    assert.ok(r.errors.length === 0, "不应有错误: " + JSON.stringify(r.errors));

    // 隔离 home 里应该有 vault
    const isoVault = path.join(isoHome, "dsh-purge", "host-backups");
    assert.ok(fs.existsSync(isoVault), "隔离 home 应生成 host-backups");
    assert.ok(fs.readdirSync(isoVault).some((n) => n.endsWith(".bak")), "隔离 home 里应有 .bak");

    // 生产保险柜数量不变
    const after = fs.existsSync(prodVault)
      ? fs.readdirSync(prodVault).filter((n) => n.endsWith(".bak")).length
      : -1;
    assert.equal(after, before, "生产保险柜不应被写入");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
