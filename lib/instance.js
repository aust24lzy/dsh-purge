/**
 * 宿主实例定位与布局归一。
 *
 * 两类语义必须分开（社区 PR #33 / #40 的结论）：
 *
 *   currentHost()      —— **安装/启动定位**语义。回答"这次要操作哪一份安装"。
 *                         允许看 DSH_BASE / PURGE_DSH_CLI / 当前 argv 的包位置。
 *
 *   diagnosticHost()   —— **只读诊断**语义。回答"我看到的磁盘文件属于哪一份"。
 *                         只能从 currentHost 的结果往下归一，绝不回退到别处。
 *                         错误的目标宁可报缺失，也不能静默换成另一份安装 ——
 *                         否则"补丁全绿"可能来自另一份安装，等于骗人。
 *
 * normalizeHostBase() 只认**已知形状**（安装根 / @deepseek-ai 根 / 归档内路径），
 * 绝不向上爬到任意祖先目录。
 */
import fs from "node:fs";
import path from "node:path";

/** 判定"这是一个 @deepseek-ai 组件根"的最小证据集。 */
const COMPONENT_PROBES = ["dsh-agent-loop", "dsh-system-prompt", "dsh-agent-instructions"];

function canonical(p, io = fs) {
  const n = path.normalize(String(p));
  try { return io.realpathSync.native ? io.realpathSync.native(n) : io.realpathSync(n); }
  catch { return n; }
}

function isDir(p, io = fs) {
  try { return io.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p, io = fs) {
  try { return io.statSync(p).isFile(); } catch { return false; }
}

/** 某个目录下是否至少有一个已知组件包（有 package.json 即可，不要求完整）。 */
function looksLikeComponentRoot(dir, io = fs) {
  return COMPONENT_PROBES.some((pkg) => isFile(path.join(dir, pkg, "package.json"), io));
}

/**
 * 把任意"宿主路径"归一成 @deepseek-ai 组件根。
 *
 * 只尝试这些形状，不做任何祖先搜索：
 *   <base>                                    已经是组件根
 *   <base>/node_modules/@deepseek-ai          扁平安装
 *   <base>/dsh/node_modules/@deepseek-ai      npm 嵌套自复制
 *   <…/resources>/{app,app.asar,app.asar.unpacked}/[dsh/]node_modules/@deepseek-ai
 *
 * 找不到就**原样返回起点**：局部安装要继续被诊断为"局部"，
 * 而不是被一个更健康的兄弟目录顶替（社区 #33 的"partial 不能被同化"）。
 */
export function normalizeHostBase(base, io = fs) {
  if (!base) return "";
  const start = canonical(base, io);
  const candidates = [
    start,
    path.join(start, "node_modules", "@deepseek-ai"),
    path.join(start, "dsh", "node_modules", "@deepseek-ai"),
  ];
  for (const candidate of candidates) {
    if (looksLikeComponentRoot(candidate, io)) return canonical(candidate, io);
  }
  return start;
}

/**
 * 归档内路径识别：
 *   <…/resources>/app.asar/[dsh/]node_modules/@deepseek-ai
 *   <…/resources>/app.asar.unpacked/[dsh/]node_modules/@deepseek-ai
 * 返回 `{ resources, inner }` 以便在同一份安装里找 app/ 或 app.asar.unpacked/。
 */
export function archivePathOf(p) {
  if (!p) return null;
  const n = path.normalize(String(p)).replace(/\\/g, "/");
  const m = /^(.*\/resources)\/(app\.asar|app\.asar\.unpacked)\/((?:dsh\/)?node_modules\/@deepseek-ai)\/?$/i.exec(n);
  if (!m) return null;
  return { resources: path.normalize(m[1]), layout: m[2], inner: m[3] };
}

/**
 * 只读诊断用的宿主根。
 *
 * 与 currentHost 的唯一区别：从归档内路径出发时，会在**同一份安装**的
 * app/ 与 app.asar.unpacked/ 之间择优，但绝不跨到别的安装。
 * 两边都没有解包目录时保留"应当存在"的那个路径，让缺失继续报出来。
 */
export function diagnosticHost(selected, io = fs) {
  if (!selected) return "";
  const archive = archivePathOf(selected);
  if (!archive) return normalizeHostBase(selected, io);
  const roots = ["app", "app.asar.unpacked"].map((layout) => path.join(archive.resources, layout));
  const candidates = roots.map((root) => path.join(root, archive.inner));
  for (let i = 0; i < candidates.length; i += 1) {
    // 只要**目标路径的父目录**存在就算这份布局在场 —— 即使内部文件缺失，
    // 也不能被另一个布局顶替（否则 missing_file 会被兄弟目录藏起来）。
    try {
      io.statSync(roots[i]);
      return normalizeHostBase(candidates[i], io);
    } catch (e) {
      if (!["ENOENT", "ENOTDIR"].includes(e.code)) return candidates[i];
    }
  }
  // 还没解包：保留同一份安装的预期路径，让"归档仍密封"继续被诊断出来。
  return candidates[0];
}

/** 从宿主 exe 推 resources 目录（mac 大小写敏感盘两种都试）。 */
export function resourcesDirFor(exe) {
  const dir = path.dirname(path.normalize(String(exe || "")));
  if (!dir) return "";
  for (const name of ["resources", "Resources"]) {
    const cand = path.join(dir, name);
    if (isDir(cand)) return cand;
  }
  return path.join(dir, "resources");
}

export { isDir, isFile, looksLikeComponentRoot, canonical };
