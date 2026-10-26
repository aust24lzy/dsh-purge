/**
 * 从社区 fork（kingcharleslzy-ai/dsh-purge 1.6.60）比对出来的同类病灶回归测试。
 *
 * 这批问题的共同点：**上游和社区都踩过，我们分支原样继承**。
 *   E: hostFs 缺 readSync/closeSync → isTextShim 恒 false → shim 注入整体失效（致命）
 *   F: process.noDeprecation 只读属性裸赋值 → diskFs() 直接抛
 *   G: rmSync(recursive) 跟随 junction → 删掉运行时本体
 *   H: 原子写不保留 mode → 启动器丢执行位、私密配置被放宽
 *   I: skipped 计入 ready / 没有逐文件状态 → 部分命中伪装成全绿
 *   J: 锚点漂移无本地救法
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.join(here, "..", "lib");
const read = (rel) => fs.readFileSync(path.join(libDir, rel), "utf8");
const load = (rel) => import(pathToFileURL(path.join(libDir, rel)).href);

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-fork-"));
}

/* ===================== E. hostFs 必须有 fd 方法 ===================== */

test("E1 hostFs 暴露 readSync / closeSync（缺了 isTextShim 会恒 false）", async () => {
  const { hostFs } = await load("extract-asar.js");
  for (const m of ["readSync", "writeSync", "closeSync", "fsyncSync", "fstatSync"]) {
    assert.equal(typeof hostFs[m], "function", "hostFs." + m + " 应存在");
  }
});

test("E2 hostFs 暴露 rmdirSync（junction 安全删除需要非递归收尾）", async () => {
  const { hostFs } = await load("extract-asar.js");
  assert.equal(typeof hostFs.rmdirSync, "function");
});

test("E3 shim 检测走的是 hostFs，必须能正确识别文本/已注入", async () => {
  const core = await load("core.js");
  const tmp = tmpdir();
  try {
    const cmd = path.join(tmp, "dsh.cmd");
    fs.writeFileSync(cmd, "@echo off\r\nrem official\r\n", "latin1");
    assert.equal(core.shimFileStatus(cmd), "original", "文本 cmd 必须识别成 original，不是 binary");

    fs.writeFileSync(cmd, "@echo off\r\n// dsh-purge shim begin\r\n", "latin1");
    assert.equal(core.shimIsPatched(cmd), true, "已注入的 cmd 必须识别成 patched");

    // 二进制文件仍要被挡掉
    const bin = path.join(tmp, "blob.bin");
    fs.writeFileSync(bin, Buffer.from([0, 1, 2, 3, 0, 5]));
    assert.equal(core.shimFileStatus(bin), "binary", "含 NUL 的文件必须判成 binary");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("E4 patchShim 真的能注入（不再全部 skipped_binary）", async () => {
  const core = await load("core.js");
  const tmp = tmpdir();
  try {
    const dir = path.join(tmp, "bin");
    fs.mkdirSync(dir, { recursive: true });
    for (const n of ["dsh.ps1", "dsh"]) fs.writeFileSync(path.join(dir, n), "#!/bin/sh\n# x\n", "latin1");
    const result = await core.patchShim(dir);
    assert.ok(!String(result["dsh.ps1"] || "").includes("skipped_binary"), "dsh.ps1 不应被判成二进制");
    assert.ok(!String(result["dsh"] || "").includes("skipped_binary"), "dsh 不应被判成二进制");
    const ps1 = fs.readFileSync(path.join(dir, "dsh.ps1"), "utf8");
    assert.ok(ps1.includes("dsh-purge shim"), "dsh.ps1 应真的写入注入");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ===================== F. noDeprecation 只读 ===================== */

test("F1 noDeprecation 赋值包了 try/catch（--no-deprecation 下只读）", () => {
  const src = read("extract-asar.js");
  assert.match(src, /try\s*\{\s*process\.noDeprecation = true;\s*\}\s*catch/, "裸赋值会在只读属性上抛 TypeError");
});

test("F2 把 noDeprecation 设成只读后 diskFs() 仍可调用", async () => {
  const desc = Object.getOwnPropertyDescriptor(process, "noDeprecation");
  Object.defineProperty(process, "noDeprecation", { value: true, writable: false, configurable: true });
  try {
    // 换一个新的模块实例，确保 cachedDiskFs 还没被填
    const url = pathToFileURL(path.join(libDir, "extract-asar.js")).href + "?ro=1";
    const mod = await import(url);
    assert.equal(typeof mod.diskFs(), "object", "只读 noDeprecation 时 diskFs() 不能抛");
  } finally {
    if (desc) Object.defineProperty(process, "noDeprecation", desc);
    else delete process.noDeprecation;
  }
});

/* ===================== G. junction 安全删除 ===================== */

test("G1 remove-tree 模块存在且导出同步/异步两个版本", async () => {
  const m = await load("remove-tree.js");
  assert.equal(typeof m.removeTreeNoFollowSync, "function");
  assert.equal(typeof m.removeTreeNoFollow, "function");
});

test("G2 删除目录树时不会跟进 symlink/junction 删掉目标内容", async (t) => {
  const { removeTreeNoFollowSync } = await load("remove-tree.js");
  const tmp = tmpdir();
  try {
    const victim = path.join(tmp, "tree");
    fs.mkdirSync(path.join(victim, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(victim, "a", "b", "f.txt"), "x");

    const keep = path.join(tmp, "KEEP");
    fs.mkdirSync(keep, { recursive: true });
    fs.writeFileSync(path.join(keep, "important.txt"), "do not delete");

    let linked = true;
    try {
      fs.symlinkSync(keep, path.join(victim, "link"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      linked = false; // 没权限建链接的机器跳过这半边
    }
    if (!linked) return t.skip("本机不允许创建 symlink/junction");

    removeTreeNoFollowSync(victim);
    assert.equal(fs.existsSync(victim), false, "树应被删掉");
    assert.equal(fs.existsSync(path.join(keep, "important.txt")), true, "链接目标的内容绝不能被删");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("G3 拒绝删除文件系统根", async () => {
  const { removeTreeNoFollowSync } = await load("remove-tree.js");
  assert.throws(() => removeTreeNoFollowSync(path.parse(process.cwd()).root), /filesystem root/);
});

/** 去掉注释，避免"注释里提到 rmSync(recursive)"被当成真实调用。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

test("G4 lib 下不再有 rmSync(recursive) 真实调用", () => {
  const hits = [];
  for (const f of fs.readdirSync(libDir)) {
    if (!f.endsWith(".js")) continue;
    const src = stripComments(read(f));
    for (const m of src.matchAll(/rmSync\([^)]*recursive:\s*true/g)) {
      hits.push(f + ":" + src.slice(0, m.index).split("\n").length);
    }
  }
  assert.deepEqual(hits, [], "仍有递归删除: " + hits.join(", "));
});

test("G5 两个 detached helper 的 rmTree 自包含且 junction 安全", () => {
  for (const file of ["restart-desktop.js", "uninstall-restart.js"]) {
    const src = read(file);
    assert.match(src, /function rmTree\(dir\)/, file + " 应有 rmTree");
    assert.doesNotMatch(src, /rmSync\([^)]*recursive:\s*true/, file + " 不应再用递归 rm");
    assert.match(src, /lstatSync/, file + " 必须先 lstat");
    assert.match(src, /rmdirSync/, file + " 应非递归收尾");
  }
});

/* ===================== H. 原子写保留权限 ===================== */

/**
 * Windows 的 chmod 只支持只读位，stat().mode 永远是 0666/0444 这一档，
 * 拿它断言 0755/0600 在 Windows 上必挂。所以分两层验证：
 *   · 跨平台：拦 hostFs.chmodSync，断言"原文件的 mode 被显式写回 tmp"；
 *   · 非 Windows：再断言真正的权限位。
 */
async function withChmodSpy(fn) {
  const { hostFs } = await load("extract-asar.js");
  const original = hostFs.chmodSync;
  const calls = [];
  hostFs.chmodSync = (fp, mode) => {
    calls.push({ fp, mode });
    return original.call(hostFs, fp, mode);
  };
  try {
    await fn(calls);
  } finally {
    hostFs.chmodSync = original;
  }
}

test("H1 atomicWriteSync 把原文件 mode 显式写回（跨平台）", async () => {
  const core = await load("core.js");
  const tmp = tmpdir();
  try {
    const fp = path.join(tmp, "launcher.sh");
    fs.writeFileSync(fp, "old");
    fs.chmodSync(fp, 0o755);
    const want = fs.statSync(fp).mode & 0o777;

    await withChmodSpy(async (calls) => {
      core.atomicWriteSync(fp, "new");
      assert.equal(calls.length, 1, "应在公开前 chmod 一次");
      assert.equal(calls[0].mode, want, "chmod 用的是原文件的 rwx 位");
      assert.match(calls[0].fp, /\.tmp$/, "chmod 作用在 tmp 上，不是目标文件");
    });
    assert.equal(fs.readFileSync(fp, "utf8"), "new");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(fp).mode & 0o777, 0o755, "执行位必须保留");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("H2 atomicWriteFile 保留私密配置的 mode（跨平台）", async () => {
  const core = await load("core.js");
  const tmp = tmpdir();
  try {
    const fp = path.join(tmp, "secret.json");
    fs.writeFileSync(fp, "{}");
    fs.chmodSync(fp, 0o600);
    const want = fs.statSync(fp).mode & 0o777;
    await withChmodSpy(async (calls) => {
      await core.atomicWriteFile(fp, '{"a":1}');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].mode, want);
    });
    assert.equal(fs.readFileSync(fp, "utf8"), '{"a":1}');
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(fp).mode & 0o777, 0o600, "私密配置不能被放宽");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("H3 新文件不硬造 mode（交给默认 umask）", async () => {
  const core = await load("core.js");
  const tmp = tmpdir();
  try {
    const fp = path.join(tmp, "brand-new.txt");
    await withChmodSpy(async (calls) => {
      core.atomicWriteSync(fp, "x");
      assert.equal(calls.length, 0, "新文件不该硬造 mode，交给默认 umask");
    });
    assert.ok(fs.existsSync(fp));
    assert.equal(fs.readFileSync(fp, "utf8"), "x");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ===================== I. 逐文件状态 / ready 口径 ===================== */

test("I1 patchStatus 仍是纯 map（老调用方契约不变）", async () => {
  const core = await load("core.js");
  const tmp = tmpdir();
  try {
    const aiBase = path.join(tmp, "node_modules", "@deepseek-ai");
    for (const pkg of ["dsh-web-app", "dsh-agent-instructions"]) {
      fs.mkdirSync(path.join(aiBase, pkg, "lib"), { recursive: true });
      fs.writeFileSync(path.join(aiBase, pkg, "lib", "index.js"), "// x");
      fs.writeFileSync(path.join(aiBase, pkg, "package.json"), "{}");
    }
    const st = await core.patchStatus(aiBase);
    assert.equal(Array.isArray(st), false);
    assert.equal(typeof st, "object");
    for (const v of Object.values(st)) assert.equal(typeof v, "string", "每个值必须是状态字符串");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("I2 patchStatusDetail 返回 { status, files } 且 files 逐目标", async () => {
  const core = await load("core.js");
  assert.equal(typeof core.patchStatusDetail, "function");
  const tmp = tmpdir();
  try {
    const aiBase = path.join(tmp, "node_modules", "@deepseek-ai");
    fs.mkdirSync(path.join(aiBase, "dsh-agent-instructions", "lib"), { recursive: true });
    fs.writeFileSync(path.join(aiBase, "dsh-agent-instructions", "lib", "index.js"), "// x");
    fs.writeFileSync(path.join(aiBase, "dsh-agent-instructions", "package.json"), "{}");
    const detail = await core.patchStatusDetail(aiBase);
    assert.ok(detail.status && typeof detail.status === "object");
    assert.ok(detail.files && typeof detail.files === "object");
    for (const rows of Object.values(detail.files)) {
      assert.ok(Array.isArray(rows), "files[id] 必须是数组");
      for (const row of rows) {
        assert.ok(typeof row.key === "string", "每行要有 key");
        assert.ok(typeof row.status === "string", "每行要有 status");
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("I3 skipped 不再计入 ready；missing_file 仍算就绪", async () => {
  const core = await load("core.js");
  assert.equal(core.patchStatusReady("skipped"), false, "skipped 是锚点漂移，不是成功");
  assert.equal(core.patchStatusReady("partial"), false, "partial 是没做全");
  assert.equal(core.patchStatusReady("missing_file"), true, "这套布局本来没这个文件");
  assert.equal(core.patchStatusReady("applied"), true);
  assert.equal(core.patchStatusReady("pending"), false);
  assert.equal(core.patchStatusReady("unreadable"), false);
});

test("I4 一组里有 partial，整组不能显示成 applied", async () => {
  const core = await load("core.js");
  assert.equal(core.rollupDisplayStatus(["applied", "partial"]), "partial");
  assert.equal(core.rollupDisplayStatus(["partial"]), "partial");
  assert.equal(core.rollupDisplayStatus(["applied"]), "applied");
});

test("I5 tally 里 skipped 不进 ready，partial 单独计数", async () => {
  const core = await load("core.js");
  const t = core.tallyDisplayPatches([
    { status: "applied" },
    { status: "skipped" },
    { status: "partial" },
    { status: "pending" },
  ]);
  assert.equal(t.applied, 1);
  assert.equal(t.skipped, 1);
  assert.equal(t.partial, 1);
  assert.equal(t.pending, 1);
  assert.equal(t.ready, 1, "只有 applied 算 ready");
});

/* ===================== J. 重锚覆盖 ===================== */

test("J1 anchors 模块可读写覆盖，且路径在 DSH_HOME 下", async () => {
  const anchors = await load("anchors.js");
  const tmp = tmpdir();
  try {
    const all = anchors.writeOverride(tmp, 24, 0, "NEW_PATTERN_HERE", { host: "0.2.1-rc.3" });
    assert.equal(all["24"]["0"].pattern, "NEW_PATTERN_HERE");
    const fp = path.join(tmp, "dsh-purge", "anchor-overrides.json");
    assert.ok(fs.existsSync(fp), "覆盖应落在 <home>/dsh-purge/anchor-overrides.json");
    // 权限 0600（不过度放宽）
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(fp).mode & 0o777, 0o600);
    }

    const read = anchors.readOverrides(tmp);
    assert.equal(read["24"]["0"].pattern, "NEW_PATTERN_HERE");

    anchors.clearOverride(tmp, 24);
    assert.deepEqual(anchors.readOverrides(tmp), {});
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("J2 applyOverrides 只替换指定下标，其余 pattern 不动", async () => {
  const anchors = await load("anchors.js");
  const patch = {
    id: 24,
    replacements: [
      { pattern: "old-0", replace: "r0" },
      { pattern: "old-1", replace: "r1" },
    ],
  };
  const out = anchors.applyOverrides(patch, { 24: { 1: { pattern: "new-1" } } });
  assert.equal(out.replacements[0].pattern, "old-0");
  assert.equal(out.replacements[1].pattern, "new-1");
  assert.equal(out.replacements[1].replace, "r1", "replace 不受影响");
  assert.equal(out.overridden, true);
  assert.equal(patch.replacements[1].pattern, "old-1", "原对象不被改动");
});

test("J3 空 pattern 拒绝写入（防止把锚点清成空字符串）", async () => {
  const anchors = await load("anchors.js");
  const tmp = tmpdir();
  try {
    assert.throws(() => anchors.writeOverride(tmp, 1, 0, ""), /pattern 不能为空/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("J4 core 暴露只读入口，apply/status 都会读覆盖", async () => {
  const core = await load("core.js");
  assert.equal(typeof core.readAnchorOverrides, "function");
  const src = read("core.js");
  assert.match(src, /const overrides = anchors\.readOverrides/, "apply/status 路径要读覆盖");
  assert.match(src, /anchors\.applyOverrides\(/, "应用时要叠加覆盖");
});
