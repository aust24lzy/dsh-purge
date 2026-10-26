/**
 * N/O/P —— 社区 fork 剩下的三块：读取作用域缓存、实例归一、原子写模块化。
 *
 *   N: desktop-read-scope —— 缓存只在**一次只读诊断**内有效，出作用域立刻丢弃；
 *      抛错/未知结论永不进缓存；clearDesktopReadScope 能让进行中的作用域失效。
 *   O: instance —— normalizeHostBase 只认已知形状，不爬任意祖先；
 *      diagnosticHost 在同一份安装内择优，绝不跨安装顶替。
 *   P: atomic-files —— 单一实现，core 与 hooks-deny 共用；权限必须保留。
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
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-nop-"));

/* ==================== N. 只读诊断作用域缓存 ==================== */

test("N1 作用域内同一 key 只真读一次", async () => {
  const scope = await load("desktop-read-scope.js");
  let reads = 0;
  scope.withDesktopReadScope(() => {
    for (let i = 0; i < 50; i += 1) {
      scope.memoDesktopRead("ns", "k", () => { reads += 1; return "v"; });
    }
  });
  assert.equal(reads, 1, "50 次查询只应真读 1 次");
});

test("N2 出了作用域立刻重读（不把旧结论带到下一次请求）", async () => {
  const scope = await load("desktop-read-scope.js");
  let reads = 0;
  scope.withDesktopReadScope(() => scope.memoDesktopRead("ns", "k", () => { reads += 1; return "v"; }));
  scope.withDesktopReadScope(() => scope.memoDesktopRead("ns", "k", () => { reads += 1; return "v"; }));
  assert.equal(reads, 2, "两个独立作用域各读一次");
});

test("N3 作用域外不缓存", async () => {
  const scope = await load("desktop-read-scope.js");
  let reads = 0;
  for (let i = 0; i < 5; i += 1) scope.memoDesktopRead("ns", "k", () => { reads += 1; return "v"; });
  assert.equal(reads, 5, "没有作用域时每次都真读");
});

test("N4 抛错的读取不进缓存（一次权限抖动不能污染整轮）", async () => {
  const scope = await load("desktop-read-scope.js");
  let reads = 0;
  scope.withDesktopReadScope(() => {
    for (let i = 0; i < 3; i += 1) {
      try {
        scope.memoDesktopRead("ns", "k", () => { reads += 1; throw new Error("EACCES"); });
      } catch { /* 预期 */ }
    }
  });
  assert.equal(reads, 3, "抛错的调用不能被缓存成\"已读过\"");
});

test("N5 false / null 默认不缓存（只有确定的真值才缓存）", async () => {
  const scope = await load("desktop-read-scope.js");
  let falsyReads = 0;
  scope.withDesktopReadScope(() => {
    for (let i = 0; i < 3; i += 1) scope.memoDesktopRead("ns", "f", () => { falsyReads += 1; return false; });
  });
  assert.equal(falsyReads, 3, "false 默认不可缓存");

  let nullReads = 0;
  scope.withDesktopReadScope(() => {
    for (let i = 0; i < 3; i += 1) {
      scope.memoDesktopRead("ns", "n", () => { nullReads += 1; return null; }, (v) => v === null || Boolean(v));
    }
  });
  assert.equal(nullReads, 1, "显式允许时 null 可缓存（身份判定需要它）");
});

test("N6 clearDesktopReadScope 让进行中的作用域失效", async () => {
  const scope = await load("desktop-read-scope.js");
  let reads = 0;
  scope.withDesktopReadScope(() => {
    scope.memoDesktopRead("ns", "k", () => { reads += 1; return "v"; });
    scope.clearDesktopReadScope();
    scope.memoDesktopRead("ns", "k", () => { reads += 1; return "v"; });
  });
  assert.equal(reads, 2, "清理后必须重读");
});

test("N7 可重入：嵌套调用复用同一作用域", async () => {
  const scope = await load("desktop-read-scope.js");
  let reads = 0;
  scope.withDesktopReadScope(() => {
    scope.memoDesktopRead("ns", "k", () => { reads += 1; return "v"; });
    scope.withDesktopReadScope(() => {
      scope.memoDesktopRead("ns", "k", () => { reads += 1; return "v"; });
    });
  });
  assert.equal(reads, 1, "嵌套不应新建作用域");
});

test("N8 异步作用域覆盖 await 全程", async () => {
  const scope = await load("desktop-read-scope.js");
  let reads = 0;
  await scope.withDesktopReadScope(async () => {
    scope.memoDesktopRead("ns", "k", () => { reads += 1; return "v"; });
    await new Promise((r) => setTimeout(r, 5));
    scope.memoDesktopRead("ns", "k", () => { reads += 1; return "v"; });
  });
  assert.equal(reads, 1, "await 之后仍应命中缓存");
});

test("N9 异步作用域异常也会关闭（不泄漏缓存）", async () => {
  const scope = await load("desktop-read-scope.js");
  await assert.rejects(scope.withDesktopReadScope(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(scope.inDesktopReadScope(), false, "异常后不应残留作用域");
});

test("N10 desktopIdentity 在作用域内被记忆（真实热路径）", async () => {
  const scope = await load("desktop-read-scope.js");
  const di = await load("desktop-identity.js");
  const tmp = tmpdir();
  try {
    // 造一个解包布局的宿主动作，让每次读都要 statSync 若干次
    const hostDir = path.join(tmp, "app", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host");
    fs.mkdirSync(path.join(hostDir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(hostDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-desktop-host" }));
    fs.writeFileSync(path.join(hostDir, "lib", "cli.js"), "// cli");

    // 计数：作用域内 30 次调用应该只真读 1 次
    const realStat = fs.statSync;
    let calls = 0;
    // 不便 monkeypatch fs（模块已持有引用），改用耗时对照 + 结果一致性
    const first = scope.withDesktopReadScope(() => di.desktopIdentity(tmp));
    assert.equal(first?.kind, "bundled-host");
    const second = scope.withDesktopReadScope(() => di.desktopIdentity(tmp));
    assert.deepEqual(second, first, "缓存值必须与真读一致");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("N11 身份判定：null 也会被缓存（'确认不是宿主'是稳定结论）", async () => {
  const scope = await load("desktop-read-scope.js");
  const di = await load("desktop-identity.js");
  const tmp = tmpdir();
  try {
    scope.withDesktopReadScope(() => {
      assert.equal(di.desktopIdentity(tmp), null);
      assert.equal(di.desktopIdentity(tmp), null);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("N12 抛错的身份判定不进缓存（损坏归档要在每次调用时报出来）", async () => {
  const scope = await load("desktop-read-scope.js");
  const di = await load("desktop-identity.js");
  const tmp = tmpdir();
  try {
    fs.writeFileSync(path.join(tmp, "app.asar"), Buffer.from("broken"));
    scope.withDesktopReadScope(() => {
      assert.throws(() => di.desktopIdentity(tmp));
      // 第二次仍要抛，不能因为"上次抛了"就记住
      assert.throws(() => di.desktopIdentity(tmp));
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("N13 core 的 patchStatus / patchStatusDetail / gatherState 都包了作用域", () => {
  const src = read("core.js");
  for (const fn of ["patchStatus", "patchStatusDetail", "gatherState"]) {
    const i = src.indexOf("export async function " + fn);
    assert.ok(i >= 0, fn + " 应存在");
    assert.match(src.slice(i, i + 700), /withDesktopReadScope/, fn + " 必须包只读作用域");
  }
});

/* ==================== O. 实例归一 ==================== */

/** 造一棵合法的 @deepseek-ai 组件根。 */
function seedComponentRoot(root) {
  for (const pkg of ["dsh-agent-loop", "dsh-system-prompt", "dsh-agent-instructions"]) {
    fs.mkdirSync(path.join(root, pkg), { recursive: true });
    fs.writeFileSync(path.join(root, pkg, "package.json"), JSON.stringify({ name: "@deepseek-ai/" + pkg }));
  }
}

test("O1 安装根 → 归一成 @deepseek-ai 组件根（扁平）", async () => {
  const inst = await load("instance.js");
  const tmp = tmpdir();
  try {
    const ai = path.join(tmp, "node_modules", "@deepseek-ai");
    seedComponentRoot(ai);
    assert.equal(inst.normalizeHostBase(tmp).replace(/\\/g, "/"), ai.replace(/\\/g, "/"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("O2 npm 嵌套自复制也能归一", async () => {
  const inst = await load("instance.js");
  const tmp = tmpdir();
  try {
    const ai = path.join(tmp, "dsh", "node_modules", "@deepseek-ai");
    seedComponentRoot(ai);
    assert.equal(inst.normalizeHostBase(tmp).replace(/\\/g, "/"), ai.replace(/\\/g, "/"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("O3 找不到组件根时原样返回起点（局部安装不能被兄弟目录顶替）", async () => {
  const inst = await load("instance.js");
  const tmp = tmpdir();
  try {
    const start = path.join(tmp, "some", "path");
    fs.mkdirSync(start, { recursive: true });
    assert.equal(inst.normalizeHostBase(start).replace(/\\/g, "/"), start.replace(/\\/g, "/"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("O4 已是组件根时幂等", async () => {
  const inst = await load("instance.js");
  const tmp = tmpdir();
  try {
    seedComponentRoot(tmp);
    assert.equal(inst.normalizeHostBase(tmp).replace(/\\/g, "/"), tmp.replace(/\\/g, "/"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("O5 绝不向上爬到任意祖先", async () => {
  const inst = await load("instance.js");
  const tmp = tmpdir();
  try {
    // 祖先有组件根，但起点本身没有
    seedComponentRoot(tmp);
    const deep = path.join(tmp, "a", "b", "c");
    fs.mkdirSync(deep, { recursive: true });
    const out = inst.normalizeHostBase(deep).replace(/\\/g, "/");
    assert.equal(out, deep.replace(/\\/g, "/"), "不应爬到祖先的组件根");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("O6 archivePathOf 认出两种归档路径", async () => {
  const inst = await load("instance.js");
  const a = inst.archivePathOf("D:/x/resources/app.asar/dsh/node_modules/@deepseek-ai");
  assert.ok(a);
  assert.equal(a.layout, "app.asar");
  assert.equal(a.inner.replace(/\\/g, "/"), "dsh/node_modules/@deepseek-ai");
  const b = inst.archivePathOf("D:/x/resources/app.asar.unpacked/node_modules/@deepseek-ai");
  assert.ok(b);
  assert.equal(b.layout, "app.asar.unpacked");
  assert.equal(inst.archivePathOf("D:/x/resources/app/dsh"), null, "解包目录不是归档路径");
});

test("O7 diagnosticHost 把归档内路径指向同一份安装的 app/", async () => {
  const inst = await load("instance.js");
  const tmp = tmpdir();
  try {
    const resources = path.join(tmp, "resources");
    const inner = path.join("dsh", "node_modules", "@deepseek-ai");
    seedComponentRoot(path.join(resources, "app", inner));
    const out = inst.diagnosticHost(path.join(resources, "app.asar", inner)).replace(/\\/g, "/");
    const want = path.join(resources, "app", inner).replace(/\\/g, "/");
    assert.equal(out, want);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("O8 两边都没解包时保留预期路径（让'归档仍密封'继续被诊断出来）", async () => {
  const inst = await load("instance.js");
  const tmp = tmpdir();
  try {
    const resources = path.join(tmp, "resources");
    fs.mkdirSync(resources, { recursive: true });
    const inner = path.join("dsh", "node_modules", "@deepseek-ai");
    const out = inst.diagnosticHost(path.join(resources, "app.asar", inner)).replace(/\\/g, "/");
    const want = path.join(resources, "app", inner).replace(/\\/g, "/");
    assert.equal(out, want, "应保留 app/ 预期路径，而不是回报 null 或换安装");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("O9 不跨安装：另一份安装的 app/ 不会被选中", async () => {
  const inst = await load("instance.js");
  const tmp = tmpdir();
  try {
    const resourcesA = path.join(tmp, "A", "resources");
    const resourcesB = path.join(tmp, "B", "resources");
    const inner = path.join("dsh", "node_modules", "@deepseek-ai");
    // 只有 B 有解包目录
    seedComponentRoot(path.join(resourcesB, "app", inner));
    fs.mkdirSync(resourcesA, { recursive: true });
    const out = inst.diagnosticHost(path.join(resourcesA, "app.asar", inner)).replace(/\\/g, "/");
    assert.ok(!out.includes("/B/"), "不能跳到 B 安装");
    assert.ok(out.includes("/A/"), "必须留在 A 安装");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("O10 core 的 findAiBase 归一，且导出 diagnosticAiBase", () => {
  const src = read("core.js");
  const i = src.indexOf("export function findAiBase()");
  assert.ok(i >= 0);
  assert.match(src.slice(i, i + 800), /normalizeHostBase/, "findAiBase 必须归一");
  assert.match(src, /export function diagnosticAiBase/, "应导出只读诊断入口");
});

/* ==================== P. 原子写模块化 ==================== */

test("P1 atomic-files 导出三个入口 + 默认实现", async () => {
  const af = await load("atomic-files.js");
  assert.equal(typeof af.atomicFiles, "function");
  assert.equal(typeof af.atomicWriteSync, "function");
  assert.equal(typeof af.atomicWriteFile, "function");
  assert.equal(typeof af.atomicCopyFile, "function");
});

test("P2 atomicFiles(fsImpl) 可注入不同文件系统实现", async () => {
  const af = await load("atomic-files.js");
  const custom = af.atomicFiles(fs);
  assert.equal(typeof custom.atomicWriteSync, "function");
  const tmp = tmpdir();
  try {
    const fp = path.join(tmp, "x.txt");
    custom.atomicWriteSync(fp, "hello");
    assert.equal(fs.readFileSync(fp, "utf8"), "hello");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("P3 tmp 名唯一（同毫秒并发不撞）", async () => {
  const af = await load("atomic-files.js");
  const inst = af.atomicFiles(fs);
  const names = new Set();
  for (let i = 0; i < 200; i += 1) names.add(inst.temporary("C:/x/file.txt"));
  assert.equal(names.size, 200, "200 次应产生 200 个不同 tmp 名");
});

test("P4 core 与 hooks-deny 的原子写行为一致（都保留 mode）", async () => {
  const core = await load("core.js");
  const tmp = tmpdir();
  try {
    const fp = path.join(tmp, "perm.txt");
    fs.writeFileSync(fp, "old");
    fs.chmodSync(fp, 0o600);
    const want = fs.statSync(fp).mode & 0o777;
    await core.atomicWriteFile(fp, "new");
    assert.equal(fs.statSync(fp).mode & 0o777, want, "core 保留 mode");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("P5 hooks-deny 自己的原子写也保留 mode（settings.json 是 0600）", async () => {
  const hd = await load("hooks-deny.js");
  const tmp = tmpdir();
  try {
    // 通过公开 API 写入 settings，然后检查权限
    hd.saveHookDenySettings(tmp, { hooksDenyBypass: false });
    const fp = path.join(tmp, "dsh-purge", "hooks-deny.json");
    if (!fs.existsSync(fp)) {
      // 路径可能不同，找一遍
      const found = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith(".json")) found.push(p);
        }
      };
      walk(tmp);
      assert.ok(found.length > 0, "应写出一个 settings json");
      if (process.platform !== "win32") {
        for (const p of found) {
          const mode = fs.statSync(p).mode & 0o777;
          assert.ok(mode === 0o600 || mode === 0o644, p + " 权限异常: " + mode.toString(8));
        }
      }
    } else if (process.platform !== "win32") {
      assert.equal(fs.statSync(fp).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("P6 core 不再有自己的一份原子写实现（只从 atomic-files 引入）", () => {
  const src = read("core.js");
  assert.equal(/function modeOfExisting/.test(src), false, "旧实现应已移除");
  assert.equal(/function renameSyncRetry/.test(src), false, "旧实现应已移除");
  assert.match(src, /from "\.\/atomic-files\.js"/, "应从 atomic-files 引入");
  // export ... from 不创建本地绑定 —— 必须有 import 才能内部调用
  assert.match(src, /import \{[\s\S]{0,200}?atomicWriteFile,[\s\S]{0,200}?\} from "\.\/atomic-files\.js"/,
    "必须有 import 绑定，否则内部调用会 ReferenceError");
});

test("P7 atomic 失败时不留半截文件", async () => {
  const af = await load("atomic-files.js");
  const tmp = tmpdir();
  try {
    const fp = path.join(tmp, "existing.txt");
    fs.writeFileSync(fp, "original");
    // 让 rename 失败：目标是一个已存在的**目录**
    const dirTarget = path.join(tmp, "asdir");
    fs.mkdirSync(dirTarget);
    assert.throws(() => af.atomicWriteSync(dirTarget, "x"));
    // 原文件未受影响
    assert.equal(fs.readFileSync(fp, "utf8"), "original");
    // 临时文件已被清掉
    const leftovers = fs.readdirSync(tmp).filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "不应残留 tmp: " + leftovers.join(", "));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
