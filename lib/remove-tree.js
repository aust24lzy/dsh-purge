/**
 * 只删目录项本身，绝不进入 symlink / Windows junction 的内部。
 *
 * 为什么必须有这个：Node 的 `fs.rmSync(dir, { recursive: true })` 在 Windows 上会
 * 跟随 junction 删掉**目标目录的内容**。0.2.1 桌面端的 `app/runtime` 就是一条指向
 * 外层 `runtime` 的 junction；用递归 rm 清理 app 目录，等于把运行时本体一起删掉，
 * 下次启动直接起不来（社区 issue #67 的原型）。
 *
 * 约束：
 *   · lstat 必须先于任何 isDirectory 判断，也不能对删除目标做 realpath；
 *   · 目录用**非递归** rmdirSync 收尾，不保留任何原生 recursive 回退；
 *   · ENOENT 视为已达成（幂等）；其余错误向上抛，由调用方决定是否重试。
 *
 * 本函数保持自包含：bootstrap / detached uninstall 会整段内联它的实现，
 * 因为它们必须在插件包被删掉之后仍然能跑。
 */
import fs from 'node:fs';
import path from 'node:path';

const RETRYABLE = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);

function assertNotRoot(root) {
  if (root === path.parse(root).root) throw new Error('Refusing to remove a filesystem root');
}

export function removeTreeNoFollowSync(target, options = {}) {
  const io = options.fs || fs;
  const root = path.resolve(target);
  assertNotRoot(root);
  const maxRetries = options.maxRetries ?? 0;
  const retryDelay = options.retryDelay ?? 100;
  const walk = (file) => {
    let st;
    try { st = io.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    // lstat 在 isDirectory 之前：删除目标绝不能 stat / realpath。
    try {
      if (st.isSymbolicLink()) { io.unlinkSync(file); return; }
      if (st.isDirectory()) {
        for (const name of io.readdirSync(file)) walk(path.join(file, name));
        io.rmdirSync(file); // 非递归，不留原生 recursive 回退
      } else {
        io.unlinkSync(file);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  };
  for (let attempt = 0; ; attempt += 1) {
    try { walk(root); return; } catch (e) {
      if (e.code === 'ENOENT') return;
      if (attempt >= maxRetries || !RETRYABLE.has(e.code)) throw e;
      // 每次重试都重新 lstat 剩下的每一项，包括根。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelay * (attempt + 1));
    }
  }
}

export async function removeTreeNoFollow(target, options = {}) {
  const io = (options.fs || fs).promises;
  const root = path.resolve(target);
  assertNotRoot(root);
  const maxRetries = options.maxRetries ?? 0;
  const retryDelay = options.retryDelay ?? 100;
  const walk = async (file) => {
    let st;
    try { st = await io.lstat(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    try {
      if (st.isSymbolicLink()) { await io.unlink(file); return; }
      if (st.isDirectory()) {
        for (const name of await io.readdir(file)) await walk(path.join(file, name));
        await io.rmdir(file);
      } else {
        await io.unlink(file);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  };
  for (let attempt = 0; ; attempt += 1) {
    try { await walk(root); return; } catch (e) {
      if (e.code === 'ENOENT') return;
      if (attempt >= maxRetries || !RETRYABLE.has(e.code)) throw e;
      await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
    }
  }
}
