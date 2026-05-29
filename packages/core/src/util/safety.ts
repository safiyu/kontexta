/**
 * Shared safety helpers: path containment validation, SQL LIKE escaping,
 * per-key async mutex.
 */
import { resolve, sep, isAbsolute } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Throws if `name` resolves outside `base`. Rejects absolute paths, ".."
 * traversal, and null bytes. Returns the resolved absolute path on success.
 */
export function assertPathInside(base: string, name: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Invalid path: empty");
  }
  if (name.includes("\0")) {
    throw new Error("Invalid path: null byte");
  }
  if (isAbsolute(name)) {
    throw new Error("Invalid path: absolute paths are not allowed");
  }
  const baseResolved = resolve(base);
  const target = resolve(baseResolved, name);
  if (target !== baseResolved && !target.startsWith(baseResolved + sep)) {
    throw new Error("Invalid path: escapes base directory");
  }
  return target;
}

/** Escape SQL LIKE metacharacters (%, _, \). Use with `ESCAPE '\'`. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => "\\" + ch);
}

/**
 * Per-key serial async mutex. All callers with the same key run one at a time.
 */
const _locks = new Map<string, Promise<unknown>>();
const _heldKeys = new AsyncLocalStorage<Set<string>>();
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // Re-entering the same key would queue behind its own tail → deadlock.
  const held = _heldKeys.getStore();
  if (held?.has(key)) {
    return Promise.reject(new Error(`withLock: re-entrant acquisition of "${key}" would deadlock`));
  }
  const prev = _locks.get(key) ?? Promise.resolve();
  const childHeld = new Set(held ?? []);
  childHeld.add(key);
  const wrapped = () => _heldKeys.run(childHeld, fn);
  // (wrapped, wrapped): proceed regardless of prev's outcome — ordering, not propagation.
  const next = prev.then(wrapped, wrapped);
  // tail swallows rejection only on the chain stored in _locks; callers still see `next`.
  const tail = next.catch(() => {});
  _locks.set(key, tail);
  tail.finally(() => {
    if (_locks.get(key) === tail) _locks.delete(key);
  });
  return next;
}
