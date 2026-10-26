/**
 * 0.2.1 架构级风险点的回归测试（A/B/C/D）。
 *
 * 只碰 mkdtemp 出来的临时目录，不读也不写任何真实宿主目录。
 *   A: asar 探针缓存必须在四个搬目录的函数里自己失效，不能靠调用方；
 *   B: assemble 守卫要有形状/签名/链深保护，坏形状一律原样透传；
 *   C: targetFiles 按真实布局（flat / nested）排候选，不靠 firstExisting 兜底；
 *   D: 技能可用性判定同时认 插件进程 home 与 宿主 home，官方技能两边都列。
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
/** Windows 下 import() 必须给 file:// URL，不能直接给 C:\... 路径。 */
const load = (rel) => import(pathToFileURL(path.join(libDir, rel)).href);

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-arch-"));
}

/** 取一个函数体（大括号配对），用来断言"这个函数自己做了某事"。 */
function bodyOf(src, name) {
  const i = src.indexOf("export function " + name);
  assert.ok(i >= 0, name + " 应存在");
  let depth = 0;
  const start = src.indexOf("{", i);
  let j = start;
  for (; j < src.length; j += 1) {
    if (src[j] === "{") depth += 1;
    else if (src[j] === "}") {
      depth -= 1;
      if (depth === 0) { j += 1; break; }
    }
  }
  return src.slice(start, j);
}

/* ============================ A. asar 探针失效 ============================ */

test("A1 归档挪走后，未失效的缓存会给出陈旧判定（证明缓存真的存在）", async () => {
  const asar = await load("extract-asar.js");
  const tmp = tmpdir();
  try {
    const resources = path.join(tmp, "resources");
    fs.mkdirSync(path.join(resources, "app", "dsh"), { recursive: true });
    fs.writeFileSync(path.join(resources, "app.asar"), "fake");
    const target = path.join(resources, "app", "dsh", "x.js");

    assert.equal(asar.asarShadowsPath(target), true, "归档在时 app/ 下路径应被判定为影子覆盖");

    fs.renameSync(path.join(resources, "app.asar"), path.join(resources, "app.asar.bak"));
    assert.equal(asar.asarShadowsPath(target), true, "未失效时应仍是旧值");

    asar.invalidateAsarProbes();
    assert.equal(asar.asarShadowsPath(target), false, "失效后必须重新探到归档已不在");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("A2 四个搬目录的函数必须自己 invalidate，不能靠调用方", () => {
  const src = read("extract-asar.js");
  for (const fn of ["overlayAsarUnpacked", "commitExtractedDir", "restoreExtractedDir", "extractAsarToSide"]) {
    assert.match(bodyOf(src, fn), /invalidateAsarProbes\(\)/, fn + " 必须显式 invalidateAsarProbes()");
  }
});

test("A3 三个函数走的是 diskFs()，hostFs 的写操作失效覆盖不到（说明为什么必须显式清）", () => {
  const src = read("extract-asar.js");
  for (const fn of ["overlayAsarUnpacked", "commitExtractedDir", "restoreExtractedDir"]) {
    assert.match(bodyOf(src, fn), /diskFs\(\)/, fn + " 应继续用 diskFs()");
  }
  // hostFs 只对经过它的写操作失效；这条断言把这个前提钉住，改动时会被提醒。
  assert.match(src, /const HOST_WRITE = new Set\(/, "hostFs 的写方法白名单应存在");
});

/* ============================ B. assemble 守卫 ============================ */

test("B1 正常形状 -> rewrite 生效", async () => {
  const identity = await load("identity.js");
  const prompt = {
    assemble: async function assemble(assembly, context) {
      return { sections: [{ name: "a", text: "x" }], contexts: [], tools: [] };
    },
  };
  identity.installAssembleGuard(prompt, (assembled) => ({
    ...assembled,
    sections: [...assembled.sections, { name: "dsh-purge", text: "INJECT" }],
  }));
  const out = await prompt.assemble({ sections: [] }, {});
  assert.ok(out.sections.some((s) => s.name === "dsh-purge"), "正常形状应被 rewrite");
});

test("B2 宿主返回非 {sections:[]} 形状 -> 原样透传，不吞成空 sections", async () => {
  const identity = await load("identity.js");
  const weird = { ok: true, payload: [1, 2, 3] };
  const prompt = {
    assemble: async function assemble(assembly, context) { return weird; },
  };
  identity.installAssembleGuard(prompt, () => ({ sections: [{ name: "dsh-purge", text: "SHOULD-NOT-WIN" }] }));
  assert.equal(await prompt.assemble({}, {}), weird, "坏形状必须原样交回宿主");
});

test("B3 rewrite 返回坏形状 -> 退回宿主原值", async () => {
  const identity = await load("identity.js");
  const hostValue = { sections: [{ name: "a", text: "keep" }], contexts: [], tools: [] };
  const prompt = {
    assemble: async function assemble(assembly, context) { return hostValue; },
  };
  identity.installAssembleGuard(prompt, () => null);
  assert.deepEqual(await prompt.assemble({}, {}), hostValue);
});

test("B4 assemble 签名漂移要告警（不拦调用）", async () => {
  const identity = await load("identity.js");
  let warned = false;
  const original = console.warn;
  console.warn = (...args) => {
    if (String(args[0]).includes("signature drifted")) warned = true;
  };
  try {
    const prompt = {
      assemble: async function assemble(assembly, context) {
        return { sections: [], contexts: [], tools: [] };
      },
    };
    identity.installAssembleGuard(prompt, (a) => a);
    const out = await prompt.assemble({}, {}, "extra-arg");
    assert.ok(out && Array.isArray(out.sections), "漂移时调用仍要走通");
    assert.equal(warned, true, "参数个数变化应告警");
  } finally {
    console.warn = original;
  }
});

test("B5 重复 install 幂等：同一层包装，链深不增长", async () => {
  const identity = await load("identity.js");
  const prompt = {
    assemble: async function assemble(assembly, context) {
      return { sections: [], contexts: [], tools: [] };
    },
  };
  const before = prompt.assemble;
  identity.installAssembleGuard(prompt, (a) => a);
  const once = prompt.assemble;
  identity.installAssembleGuard(prompt, (a) => a);
  identity.installAssembleGuard(prompt, (a) => a);
  assert.equal(prompt.assemble, once, "重复 install 必须返回同一层包装");
  assert.notEqual(once, before, "第一次 install 应替换原方法");
  assert.equal(Number(once._dshPurgeChain), 1, "链深应保持 1");
});

test("B6 代理链到顶后不再包（防 createShadowMethod 语义变化导致无限叠层）", async () => {
  const identity = await load("identity.js");
  const deep = Object.assign(
    async function assemble(assembly, context) { return { sections: [], contexts: [], tools: [] }; },
    { _dshPurgeChain: 8 },
  );
  const prompt = { assemble: deep };
  identity.installAssembleGuard(prompt, (a) => a);
  assert.equal(prompt.assemble, deep, "链深到顶时不应再包");
});

test("B7 原生 assemble 抛错时仍返回可用的空装配（不弄死 waterfall）", async () => {
  const identity = await load("identity.js");
  const prompt = {
    assemble: async function assemble() { throw new Error("boom"); },
  };
  identity.installAssembleGuard(prompt, (a) => a);
  const original = console.warn;
  console.warn = () => {};
  try {
    const out = await prompt.assemble({}, {});
    assert.deepEqual(out, { sections: [], contexts: [], tools: [] });
  } finally {
    console.warn = original;
  }
});

/* ============================ C. 布局判定 ============================ */

/** 造一套最小的 @deepseek-ai 树：只放 targetFiles 会用到的两个包。 */
function seedPackages(root, marker) {
  for (const pkg of ["dsh-web-app", "dsh-system-prompt", "dsh-agent-instructions"]) {
    fs.mkdirSync(path.join(root, pkg, "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, pkg, "lib", "index.js"), "// " + marker + " " + pkg);
    fs.writeFileSync(path.join(root, pkg, "package.json"), JSON.stringify({ name: "@deepseek-ai/" + pkg, version: "0.2.1-rc.3" }));
  }
}

test("C1 flat 布局（桌面解包）命中 flat 路径", async () => {
  const core = await load("core.js");
  const tmp = tmpdir();
  try {
    const aiBase = path.join(tmp, "node_modules", "@deepseek-ai");
    seedPackages(aiBase, "flat");
    const files = core.targetFiles(aiBase, tmp);
    assert.equal(
      files["web-app-lib"],
      path.join(aiBase, "dsh-web-app", "lib", "index.js"),
      "flat 布局应命中 flat 路径",
    );
    assert.equal(
      files["system-prompt"],
      path.join(aiBase, "dsh-system-prompt", "lib", "index.js"),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("C2 nested 布局（npm 自复制）命中嵌套路径", async () => {
  const core = await load("core.js");
  const tmp = tmpdir();
  try {
    const aiBase = path.join(tmp, "node_modules", "@deepseek-ai");
    const nestedRoot = path.join(aiBase, "dsh", "node_modules", "@deepseek-ai");
    seedPackages(nestedRoot, "nested");
    const files = core.targetFiles(aiBase, tmp);
    assert.equal(
      files["web-app-lib"],
      path.join(nestedRoot, "dsh-web-app", "lib", "index.js"),
      "nested 布局应命中嵌套路径",
    );
    assert.equal(
      files["system-prompt"],
      path.join(nestedRoot, "dsh-system-prompt", "lib", "index.js"),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("C3 两层同时存在时，nested 布局优先取嵌套那一份（不串层）", async () => {
  const core = await load("core.js");
  const tmp = tmpdir();
  try {
    const aiBase = path.join(tmp, "node_modules", "@deepseek-ai");
    const nestedRoot = path.join(aiBase, "dsh", "node_modules", "@deepseek-ai");
    seedPackages(nestedRoot, "nested");
    seedPackages(aiBase, "flat-copy");
    const files = core.targetFiles(aiBase, tmp);
    assert.equal(
      files["web-app-lib"],
      path.join(nestedRoot, "dsh-web-app", "lib", "index.js"),
      "检测到 nested 布局时应优先嵌套路径",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("C4 布局判定结果是记忆的，resetPathMemo 后会重新探测", async () => {
  const core = await load("core.js");
  const tmp = tmpdir();
  try {
    const aiBase = path.join(tmp, "node_modules", "@deepseek-ai");
    seedPackages(aiBase, "flat");
    // 先以 flat 建缓存
    assert.equal(core.targetFiles(aiBase, tmp)["web-app-lib"], path.join(aiBase, "dsh-web-app", "lib", "index.js"));
    // 现造一个 nested 层，且把 flat 那份删掉
    const nestedRoot = path.join(aiBase, "dsh", "node_modules", "@deepseek-ai");
    seedPackages(nestedRoot, "nested");
    for (const pkg of ["dsh-web-app", "dsh-system-prompt", "dsh-agent-instructions"]) {
      fs.rmSync(path.join(aiBase, pkg), { recursive: true, force: true });
    }
    core.resetPathMemo();
    assert.equal(
      core.targetFiles(aiBase, tmp)["web-app-lib"],
      path.join(nestedRoot, "dsh-web-app", "lib", "index.js"),
      "reset 后应重新判定为 nested",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("C5 两条关键目标都不再写死首个候选，而是走布局感知的候选生成", () => {
  const src = read("core.js");
  assert.match(src, /function hostLayoutKind\(/, "应存在布局判定");
  assert.match(src, /function pkgPathCandidates\(/, "应存在候选生成");
  // web-app-lib / system-prompt 必须经由 pkgPathCandidates，而不是手写两条 path.join
  const webAppBlock = /"web-app-lib":\s*firstExisting\(\[([\s\S]{0,600}?)\]\)/.exec(src);
  assert.ok(webAppBlock, "web-app-lib 定义应存在");
  assert.match(webAppBlock[1], /pkgPathCandidates\(aiBase, "dsh-web-app"/, "web-app-lib 必须走 pkgPathCandidates");
  const spBlock = /"system-prompt":\s*firstExisting\(\[([\s\S]{0,600}?)\]\)/.exec(src);
  assert.ok(spBlock, "system-prompt 定义应存在");
  assert.match(spBlock[1], /pkgPathCandidates\(aiBase, "dsh-system-prompt"/, "system-prompt 必须走 pkgPathCandidates");
});

/* ============================ D. 双 home ============================ */

test("D1 hostHome 排在候选第一位，env home 仍在列表里", async () => {
  const sa = await load("redteam/skill-availability.js");
  const tmp = tmpdir();
  try {
    const homeA = path.join(tmp, "homeA");
    const homeB = path.join(tmp, "homeB");
    fs.mkdirSync(homeB, { recursive: true });
    const cands = sa.dshHomeCandidates({ DSH_HOME: homeA }, homeB);
    assert.equal(cands[0], homeB, "hostHome 必须排第一");
    assert.ok(cands.includes(homeA), "env home 仍要在候选里");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("D2 路径只在 hostHome 下存在时，判为存在（不再整片报 path-missing）", async () => {
  const sa = await load("redteam/skill-availability.js");
  const tmp = tmpdir();
  try {
    const homeA = path.join(tmp, "homeA");
    const homeB = path.join(tmp, "homeB");
    fs.mkdirSync(homeA, { recursive: true });
    fs.mkdirSync(path.join(homeB, "redteam", "toolkit"), { recursive: true });
    fs.writeFileSync(path.join(homeB, "redteam", "toolkit", "fscan.exe"), "x");

    assert.equal(
      sa.existsUnderAnyHome("$DSH_HOME/redteam/toolkit/fscan.exe", { DSH_HOME: homeA }, homeB),
      true,
      "只在 hostHome 下存在也应判为存在",
    );

    const verdict = sa.checkSkill(
      {
        name: "t",
        content: "用 $DSH_HOME/redteam/toolkit/fscan.exe 扫描",
        path: path.join(homeB, "t.md"),
        root: homeB,
      },
      { env: { DSH_HOME: homeA }, hostHome: homeB },
    );
    assert.equal(verdict.status, "available");
    assert.equal(verdict.checked.missing_paths.length, 0, "hostHome 命中后不应报 path-missing");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("D3 官方技能：env home 与 hostHome 的技能都要列出来", async () => {
  const sa = await load("redteam/skill-availability.js");
  const tmp = tmpdir();
  try {
    const homeA = path.join(tmp, "homeA");
    const homeB = path.join(tmp, "homeB");
    fs.mkdirSync(path.join(homeA, "skills", "onlyA"), { recursive: true });
    fs.writeFileSync(path.join(homeA, "skills", "onlyA", "SKILL.md"), "# A skill");
    fs.mkdirSync(path.join(homeB, "skills", "onlyB"), { recursive: true });
    fs.writeFileSync(path.join(homeB, "skills", "onlyB", "SKILL.md"), "# B skill");

    const names = sa.officialSkillSummaries(homeB, { DSH_HOME: homeA }).map((s) => s.name);
    assert.ok(names.includes("onlyA"), "env home 的技能也要列出");
    assert.ok(names.includes("onlyB"), "hostHome 的技能要列出");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("D4 同名官方技能按候选顺序去重（hostHome 优先）", async () => {
  const sa = await load("redteam/skill-availability.js");
  const tmp = tmpdir();
  try {
    const homeA = path.join(tmp, "homeA");
    const homeB = path.join(tmp, "homeB");
    for (const [home, title] of [[homeA, "# from A"], [homeB, "# from B"]]) {
      fs.mkdirSync(path.join(home, "skills", "dup"), { recursive: true });
      fs.writeFileSync(path.join(home, "skills", "dup", "SKILL.md"), title);
    }
    const list = sa.officialSkillSummaries(homeB, { DSH_HOME: homeA });
    const dups = list.filter((s) => s.name === "dup");
    assert.equal(dups.length, 1, "同名技能只应出现一次");
    assert.match(dups[0].content, /from B/, "hostHome 那份应胜出");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("D5 hostHomeHint 只返回真实存在的目录，拿不到就返回空串", async () => {
  const sa = await load("redteam/skill-availability.js");
  const hint = sa.hostHomeHint({ DSH_HOME: path.join(os.tmpdir(), "definitely-not-here-" + Date.now()) });
  assert.equal(typeof hint, "string", "必须返回字符串");
  if (hint !== "") assert.ok(fs.existsSync(hint), "非空时必须指向真实目录");
});
