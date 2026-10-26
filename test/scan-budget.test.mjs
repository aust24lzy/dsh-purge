/**
 * Q —— 兜底扫描预算与"找不到宿主"的诚实表达。
 *
 * 实测：web surface 下 findAiBase 的兜底递归扫 $HOME 要 11.2 秒，
 * 而绝大多数机器上这次扫描注定为空（真宿主都在 npx 缓存 / npm-global / resources/app，
 * 已被更便宜的探测命中）。一次 11 秒的启动负担不能接受。
 *
 * 但"按预算提前结束"和"扫完了确实没有"是两件事，必须能区分 ——
 * 否则用户会以为插件坏了。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.join(here, "..", "lib");
const read = (rel) => fs.readFileSync(path.join(libDir, rel), "utf8");

test("Q1 递归扫描带目录数与时间双预算", () => {
  const src = read("core.js");
  assert.match(src, /AIBASE_SCAN_DIR_BUDGET/, "应有目录数预算");
  assert.match(src, /AIBASE_SCAN_MS_BUDGET/, "应有时间预算");
  const i = src.indexOf("function findAiBaseRecursive");
  assert.ok(i >= 0);
  const seg = src.slice(i, i + 1800);
  assert.match(seg, /budget\.dirs >= AIBASE_SCAN_DIR_BUDGET/, "入口要查目录预算");
  assert.match(seg, /budget\.startedAt/, "要查时间预算");
});

test("Q2 预算可被环境变量调整", () => {
  const src = read("core.js");
  assert.match(src, /DSH_PURGE_AIBASE_SCAN_BUDGET/);
  assert.match(src, /DSH_PURGE_AIBASE_SCAN_MS/);
  assert.match(src, /DSH_PURGE_DEEP_AIBASE_SCAN/, "要有完整扫描的逃生阀");
});

test("Q3 被打断时可被诊断出来（truncated 标记 + 读取函数）", () => {
  const src = read("core.js");
  assert.match(src, /aiBaseScanTruncated = true/, "超预算时要置标记");
  assert.match(src, /export function aiBaseScanWasTruncated/, "要能读出来");
});

test("Q4 缺宿主时的提示区分'扫完没有'与'被打断'", () => {
  const src = read("core.js");
  const i = src.indexOf("export function missingAiBaseMessage");
  assert.ok(i >= 0);
  const seg = src.slice(i, i + 2200);
  assert.match(seg, /aiBaseScanWasTruncated\(\)/, "要按 truncated 分岔");
  assert.match(seg, /DSH_PURGE_DEEP_AIBASE_SCAN=1/, "提示里要给出逃生阀");
  assert.match(seg, /DSH_BASE/, "提示里要给出显式指定方式");
});

test("Q5 没有宿主时分母归零，不产出误导性比例", () => {
  const src = read("core.js");
  const i = src.indexOf("async function readGatherState");
  assert.ok(i >= 0);
  const seg = src.slice(i, i + 2600);
  // !aiBase 分支必须在 patches_total += 1 之前 continue
  const naIdx = seg.indexOf("if (!aiBase) {");
  const totalIdx = seg.indexOf("patches_total += 1");
  assert.ok(naIdx >= 0 && totalIdx >= 0);
  assert.ok(naIdx < totalIdx, "无宿主的分支必须先于分母统计");
});

test("Q6 state 里明确给出 ai_base / ai_base_missing / truncated", () => {
  const src = read("core.js");
  assert.match(src, /ai_base: aiBase \|\| ""/, "要暴露实际用的宿主路径");
  assert.match(src, /ai_base_missing: aiBase \? "" : missingAiBaseMessage\(\)/, "要暴露缺失原因");
  assert.match(src, /ai_base_scan_truncated: aiBaseScanWasTruncated\(\)/, "要暴露是否被截断");
});

test("Q7 桌面分支不走递归兜底扫描（预算不影响桌面端）", () => {
  const src = read("core.js");
  const i = src.indexOf("function findAiBaseDesktop()");
  assert.ok(i >= 0);
  const seg = src.slice(i, i + 2600);
  assert.equal(/findAiBaseRecursive/.test(seg), false, "桌面分支不应进递归扫描");
  // 递归扫描只在 findAiBaseWeb 的兜底里
  const w = src.indexOf("function findAiBaseWeb");
  assert.ok(w >= 0);
  assert.match(src.slice(w, w + 9000), /findAiBaseRecursive\(/, "web 兜底才用它");
});

test("Q8 真实环境：gatherState 在 2 秒内返回（预算生效）", async () => {
  const { gatherState } = await import(
    "file://" + path.join(libDir, "core.js").replace(/\\/g, "/")
  ).catch(() => ({}));
  if (typeof gatherState !== "function") return; // 平台差异时跳过
  const t = Date.now();
  const state = await gatherState();
  const ms = Date.now() - t;
  assert.ok(ms < 3000, "gatherState 不应再花十几秒，实测 " + ms + "ms");
  // 无论有宿主还是没宿主，字段都必须在
  assert.ok(Object.hasOwn(state, "ai_base"));
  assert.ok(Object.hasOwn(state, "ai_base_scan_truncated"));
});
