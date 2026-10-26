/**
 * 只读诊断作用域缓存。
 *
 * 问题：`patchStatus` / `gatherState` 一次要问几十个补丁、几百个文件，每次都
 * `statSync` + 向上探 12 层找 app.asar。实测未缓存时 status 要 11 秒，
 * 其中绝大部分是重复探测同一批路径。
 *
 * 但**不能**用进程级缓存：
 *   · 宿主可能刚被解开（app.asar 变成 app/），缓存会说"还在归档里"；
 *   · 用户可能刚删了某个文件，status 还显示 applied；
 *   · 权限失败被缓存成"不存在"，会掩盖真正的问题。
 * 社区 #81/#82/#83 的结论就是：缓存只能在**一次只读诊断之内**共享，
 * 下一次请求必须重新核对文件证据。
 *
 * 实现：AsyncLocalStorage。作用域跟着异步调用链走（patchStatus 里有 await），
 * 出作用域立刻丢弃；`clearDesktopReadScope()` 让**进行中的**作用域也失效
 * （用于宿主刚被改写、必须立刻重读的场景）。
 */
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

/** 全局代数。清理时 +1，进行中的作用域下一次查缓存就发现失效。 */
let generation = 0;

/** 让所有活动作用域的缓存立刻作废（宿主刚被解包/挪走时调用）。 */
export function clearDesktopReadScope() {
  generation += 1;
}

/** 当前是否处在只读诊断作用域内。 */
export function inDesktopReadScope() {
  return Boolean(storage.getStore()?.active);
}

/**
 * 在一个只读诊断作用域里执行 `read`。
 * 可重入：已经在作用域内时直接执行，不新建。
 * 同步/异步都支持；异步时作用域持续到 Promise settle。
 */
export function withDesktopReadScope(read) {
  if (storage.getStore()?.active) return read();
  const scope = { active: true, generation, values: new Map() };
  return storage.run(scope, () => {
    const close = () => {
      scope.active = false;
      scope.values.clear();
    };
    try {
      const result = read();
      if (result && typeof result.then === "function") {
        return Promise.resolve(result).finally(close);
      }
      close();
      return result;
    } catch (error) {
      close();
      throw error;
    }
  });
}

/**
 * 作用域内记忆一次读取结果。
 *
 * 不在作用域内 → 直接执行，不缓存（保证作用域外的调用永远拿到最新证据）。
 * `cacheable` 默认只缓存"确定的真值"：false / null / 抛错一律不缓存，
 * 否则一次权限抖动会让整轮诊断都读不到那个文件。
 *
 * @param {string} namespace 逻辑分区（"asar" / "stat" / "identity"…）
 * @param {string} key       该分区内的键
 * @param {function} read    真正读取的函数
 * @param {function} [cacheable] 判定返回值是否可缓存
 */
export function memoDesktopRead(namespace, key, read, cacheable = Boolean) {
  const scope = storage.getStore();
  if (!scope?.active) return read();
  if (scope.generation !== generation) {
    scope.values.clear();
    scope.generation = generation;
  }
  let values = scope.values.get(namespace);
  if (!values) {
    values = new Map();
    scope.values.set(namespace, values);
  }
  if (values.has(key)) return values.get(key);
  const value = read(); // 失败和"未知"永远不进缓存
  if (cacheable(value) && values.size < 8192) values.set(key, value);
  return value;
}

/** 异步版本的记忆化（`read` 返回 Promise）。 */
export async function memoDesktopReadAsync(namespace, key, read, cacheable = Boolean) {
  const scope = storage.getStore();
  if (!scope?.active) return read();
  if (scope.generation !== generation) {
    scope.values.clear();
    scope.generation = generation;
  }
  let values = scope.values.get(namespace);
  if (!values) {
    values = new Map();
    scope.values.set(namespace, values);
  }
  if (values.has(key)) return values.get(key);
  const value = await read();
  if (cacheable(value) && values.size < 8192) values.set(key, value);
  return value;
}
