/**
 * 宿主的桌面身份证据（只读、有界）。
 *
 * 为什么不能只看"有 app.asar"或"exe 名字像 DSH"：这两条都不是证据。
 * 任何 Electron 应用都有 app.asar；改名后的第三方壳也叫 dsh.exe。
 * 把这种目录当成官方宿主去解包、去补丁，等于**对着别人的安装目录动刀**。
 *
 * 真证据只有一条：包元数据里 `name === "@deepseek-ai/dsh-desktop-host"`，
 * 而且它声明的 `lib/cli.js` 真的在这个应用的资源里。
 *
 * 两条读取路径（归档 / 已解开目录）都必须：
 *   · 先 realpath，再确认结果仍在 root 之内（防 symlink 逃逸）；
 *   · 限制 manifest 大小（64 KiB），防止拿一个巨大 JSON 把内存打满；
 *   · 校验 asar 头部（magic=4、header 大小上限 32 MiB、offset 不越界）；
 *   · 任何异常都**向上抛**，不要在"读不到"时假装"不是宿主"——
 *     读不到和不是宿主是两件事，前者要诊断，后者才是结论。
 */
import path from "node:path";
import { diskFs } from "./extract-asar.js";
import { memoDesktopRead } from "./desktop-read-scope.js";

const HOST = "@deepseek-ai/dsh-desktop-host";
const HOST_ROOTS = ["dsh/node_modules/" + HOST, "node_modules/" + HOST];
const MAX_MANIFEST = 65536;
const MAX_HEADER = 32 * 1024 * 1024;

function inside(root, file) {
  const rel = path.relative(root, file);
  return rel !== "" && !rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel);
}

/** 只接受 POSIX 相对路径：不允许反斜杠、绝对路径、空段、`..`。 */
function safeRelative(rel) {
  return typeof rel === "string" && rel.length > 0
    && !rel.includes("\\") && !path.posix.isAbsolute(rel)
    && !rel.split("/").some((p) => p === ".." || p === "");
}

function directoryReader(root, io) {
  const base = io.realpathSync(root);
  const file = (rel) => {
    if (!safeRelative(rel)) throw new Error("Invalid desktop package path");
    const p = io.realpathSync(path.join(root, rel));
    if (!inside(base, p) || !io.statSync(p).isFile()) {
      throw new Error("Desktop package entry escapes its application");
    }
    return p;
  };
  return {
    has(rel) { try { return Boolean(file(rel)); } catch { return false; } },
    json(rel) {
      const p = file(rel);
      if (io.statSync(p).size > MAX_MANIFEST) throw new Error("Oversized desktop manifest");
      return JSON.parse(io.readFileSync(p, "utf8"));
    },
  };
}

function archiveReader(archive, callback, io) {
  const fd = io.openSync(archive, "r");
  try {
    const total = io.fstatSync(fd).size;
    const pre = Buffer.alloc(16);
    if (io.readSync(fd, pre, 0, 16, 0) !== 16 || pre.readUInt32LE(0) !== 4) {
      throw new Error("Invalid desktop ASAR");
    }
    const dataOffset = 8 + pre.readUInt32LE(4);
    const size = pre.readUInt32LE(12);
    if (size < 1 || size > MAX_HEADER || 16 + size > dataOffset || dataOffset > total) {
      throw new Error("Invalid desktop ASAR header");
    }
    const buf = Buffer.alloc(size);
    if (io.readSync(fd, buf, 0, size, 16) !== size) throw new Error("Truncated desktop ASAR");
    const header = JSON.parse(buf.toString("utf8"));
    const entry = (rel, depth = 0) => {
      if (!safeRelative(rel) || depth > 8) throw new Error("Invalid desktop ASAR path");
      let node = header;
      const parts = rel.split("/");
      for (let i = 0; i < parts.length; i += 1) {
        node = node?.files?.[parts[i]];
        if (!node) throw new Error("Missing desktop ASAR entry");
        // asar 的 link 是软链，必须按目标重新解析（并且仍然不能逃出归档）
        if (node.link) return entry([node.link, ...parts.slice(i + 1)].join("/"), depth + 1);
      }
      if (node.files || !Number.isSafeInteger(node.size) || node.size < 0) {
        throw new Error("Invalid desktop ASAR entry");
      }
      if (node.unpacked) return { node, rel };
      const offset = Number(node.offset);
      if (!Number.isSafeInteger(offset) || offset < 0 || dataOffset + offset + node.size > total) {
        throw new Error("Truncated desktop ASAR entry");
      }
      return { node, rel, offset: dataOffset + offset };
    };
    const unpacked = () => directoryReader(archive + ".unpacked", io);
    return callback({
      has(rel) {
        try {
          const e = entry(rel);
          return e.node.unpacked ? unpacked().has(e.rel) : true;
        } catch { return false; }
      },
      json(rel) {
        const e = entry(rel);
        if (e.node.size > MAX_MANIFEST) throw new Error("Oversized desktop manifest");
        if (e.node.unpacked) return unpacked().json(e.rel);
        const bytes = Buffer.alloc(e.node.size);
        if (io.readSync(fd, bytes, 0, bytes.length, e.offset) !== bytes.length) {
          throw new Error("Truncated desktop manifest");
        }
        return JSON.parse(bytes.toString("utf8"));
      },
    });
  } finally {
    io.closeSync(fd);
  }
}

function identityOf(reader) {
  for (const root of HOST_ROOTS) {
    if (!reader.has(root + "/package.json")) continue;
    const meta = reader.json(root + "/package.json");
    if (meta.name === HOST && reader.has(root + "/lib/cli.js")) {
      return { kind: "bundled-host", package: meta.name };
    }
  }
  // 旧的社区桌面壳与 bundled host 要区分开：它们的补丁目标不同。
  if (reader.has("package.json")) {
    const meta = reader.json("package.json");
    if (["dsh-desktop", "dsh-plugin-desktop"].includes(meta.name)
      && safeRelative(meta.main) && reader.has(meta.main)) {
      return { kind: "community", package: meta.name };
    }
  }
  return null;
}

/**
 * 判定一份 resources 目录属于哪种宿主。
 *
 * @returns `{ kind: "bundled-host"|"community", package }` 或 `null`（确认不是 DSH）。
 * @throws 归档/目录损坏、权限不足等**不确定**情况必须抛，不能吞成 null。
 */
export function desktopIdentity(resources, io = diskFs()) {
  if (!resources) return null;
  const root = path.resolve(resources);
  // 归档路径单次要 13.5ms（解包目录只要 0.49ms）：一次 status 里几十处都在问
  // "这是不是 DSH 宿主"，累计就是十几秒。所以按 resources 路径记忆，
  // 但**只在只读诊断作用域内**记忆 —— 出了作用域立刻重读，不会把旧身份
  // 带到下一次请求（宿主被换掉/解开之后身份可能变）。
  return memoDesktopRead(
    "identity",
    root,
    () => readDesktopIdentity(root, io),
    // 只缓存"确定了"的结论（bundled-host / community / null）。
    // 抛错不缓存：一次权限抖动不能让整轮诊断都拿不到身份。
    (value) => value === null || Boolean(value && value.kind),
  );
}

function readDesktopIdentity(root, io) {
  // 不能"优先归档失败就退到目录"：损坏的归档必须报出来，
  // 否则会用一个这次没读成功的布局给出错误结论。
  const archive = path.join(root, "app.asar");
  let sealed = false;
  try {
    io.lstatSync(archive);
    sealed = true;
  } catch (e) {
    if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
    sealed = false;
  }
  if (sealed) return archiveReader(archive, identityOf, io);
  for (const layout of ["app", "app.asar.unpacked"]) {
    const dir = path.join(root, layout);
    try {
      io.lstatSync(dir);
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") continue;
      throw e;
    }
    return identityOf(directoryReader(dir, io));
  }
  return null;
}

/** 便捷判定：任何异常都按"不是"处理（供 surface 探测这种高频路径用）。 */
export function hasDesktopIdentity(resources, kind, io = diskFs()) {
  try {
    const found = desktopIdentity(resources, io);
    return Boolean(found && (!kind || found.kind === kind));
  } catch {
    return false;
  }
}
