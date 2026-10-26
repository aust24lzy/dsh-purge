/**
 * R —— 0.2.1 宿主的锚点/目标兼容性回归。
 *
 * 这批断言来自对真实 0.2.1-rc.2 源码的实测（npm 装到隔离目录后逐文件比对）：
 *
 *   R1  #32/#53 的文案在 0.2.1 搬到 dsh-harness-dev-context 的 WEB_SURFACE_PROMPT，
 *       targetFiles 必须有这个键，否则补丁因缺目标整条 skipped。
 *   R2  #40 在 0.2.1 多了一行 requiredContexts，且 contexts 带 filter —— 需要新锚点。
 *   R3  #77 在 0.2.1 的 clear 前多了 size > 0 判断 —— 需要新锚点。
 *   R4  #80 的 skipped 是正确行为（两个 preset 从未被追加过 tool-fs/tool-web）。
 *
 * 本文件不依赖真实宿主路径；需要真机断言时设 DSH_021_HOST 指向 @deepseek-ai 目录。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.join(here, "..", "lib");
const load = (rel) => import(pathToFileURL(path.join(libDir, rel)).href);

const patchOf = async (id) => {
  const core = await load("core.js");
  return core.ALL_PATCHES.find((p) => String(p.id) === String(id));
};
const patsOf = (p) => (p.replacements || []).map((r) => String(r.pattern || ""));

test("R1 harness-dev-context 是注册过的目标键（#32/#53 依赖它）", () => {
  const src = fs.readFileSync(path.join(libDir, "core.js"), "utf8");
  assert.ok(src.includes(String.raw`"harness-dev-context": allExisting([`)
    || /"harness-dev-context":\s*allExisting\(\[/.test(src),
    "targetFiles 必须注册 harness-dev-context，否则 0.2.1 上新补丁无目标");
  assert.match(src, /pkgPathCandidates\(aiBase, "dsh-harness-dev-context"/,
    "应走布局感知候选，而不是写死一条路径");
});

test("R1b #32 把 harness-dev-context 列进 file，并带 0.2.1 的模板字符串锚点", async () => {
  const p = await patchOf(32);
  assert.ok(p, "#32 应存在");
  const files = Array.isArray(p.file) ? p.file : [p.file];
  assert.ok(files.includes("harness-dev-context"), "#32 的 file 必须含 harness-dev-context");
  assert.ok(files.includes("web-app-lib"), "#32 仍要覆盖老宿主的 web-app");
  const pats = patsOf(p);
  assert.ok(
    pats.some((x) => x.includes("const WEB_SURFACE_PROMPT = " + String.fromCharCode(96) + "You are interacting with the user through the DeepSeek Harness Web GUI")),
    "#32 需要 0.2.1 的 WEB_SURFACE_PROMPT 锚点",
  );
});

test("R1c #53 把 harness-dev-context 列进 file，并带 0.2.1 的禁止句锚点", async () => {
  const p = await patchOf(53);
  assert.ok(p, "#53 应存在");
  const files = Array.isArray(p.file) ? p.file : [p.file];
  assert.ok(files.includes("harness-dev-context"), "#53 的 file 必须含 harness-dev-context");
  const pats = patsOf(p);
  assert.ok(
    pats.some((x) => x.includes("Starting another server does not update this GUI")),
    "#53 需要 0.2.1 的定位句锚点（新宿主）",
  );
  assert.ok(
    pats.some((x) => x === "Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL."),
    "#53 需要单独摘除禁止句的兜底锚点",
  );
});

test("R2 #40 带 0.2.1 的 requiredContexts 锚点，且排在通用正则之前", async () => {
  const p = await patchOf(40);
  assert.ok(p);
  const reps = p.replacements || [];
  const idx = reps.findIndex((r) => String(r.pattern || "").includes("const requiredContexts = new Set("));
  assert.ok(idx >= 0, "#40 需要 0.2.1 的 requiredContexts 锚点");
  const firstRegExp = reps.findIndex((r) => r.pattern instanceof RegExp);
  if (firstRegExp >= 0) assert.ok(idx < firstRegExp, "精确锚点要排在通用正则前面");
  const pat = String(reps[idx].pattern);
  assert.ok(pat.includes("requiredContexts.has(entry.name)"), "要匹配 0.2.1 带 filter 的 contexts 行");
});

test("R3 #77 带 0.2.1 的 revised.size > 0 锚点，并保留老锚点", async () => {
  const p = await patchOf(77);
  assert.ok(p);
  const pats = patsOf(p);
  assert.ok(pats.some((x) => x.includes("if (this.revised.size > 0) this.revised.clear();")),
    "#77 需要 0.2.1 的 size>0 锚点");
  assert.ok(pats.some((x) => x.includes("this.revised.clear();") && !x.includes("size > 0")),
    "#77 仍要保留 0.1.x 的旧锚点");
});

test("R4 #80 是可选撤销补丁：skipped 是正确行为，不是漂移", async () => {
  const p = await patchOf(80);
  assert.ok(p);
  assert.equal(p.optional, true, "#80 必须是 optional —— 没有追加过就没有要撤的");
  const pats = patsOf(p);
  assert.ok(pats.every((x) => x.includes("[dsh-purge] minimal") || x.includes("- id: persistent-shell")),
    "#80 的锚点都应是撤销自己加过的内容形态");
  const core = await load("core.js");
  assert.equal(core.patchStatusReady("skipped"), false, "skipped 不应算 ready");
});

test("R5 补丁表规模与 id 唯一性", async () => {
  const core = await load("core.js");
  assert.ok(Array.isArray(core.ALL_PATCHES));
  assert.ok(core.ALL_PATCHES.length >= 75, "补丁数应在 77 左右，实测 " + core.ALL_PATCHES.length);
  const ids = core.ALL_PATCHES.map((p) => String(p.id));
  assert.equal(new Set(ids).size, ids.length, "补丁 id 必须唯一");
});

test("R6 真机（可选）：有 DSH_021_HOST 时不应有硬失败", async (t) => {
  const host = process.env.DSH_021_HOST;
  if (!host) return t.skip("未设置 DSH_021_HOST，跳过真机断言");
  const core = await load("core.js");
  const detail = await core.patchStatusDetail(host);
  const bad = Object.entries(detail.status).filter(([id, s]) => {
    const p = core.ALL_PATCHES.find((x) => String(x.id) === String(id));
    if (!p) return false;
    if (s === "na" || s === "applied") return false;
    if (s === "skipped" && p.optional) return false;
    if (s === "missing_file" && p.optional) return false;
    return true;
  });
  const real = bad.filter(([id]) => String(id) !== "71");
  assert.deepEqual(real, [], "不应有硬失败，实测: " + JSON.stringify(real));
});
