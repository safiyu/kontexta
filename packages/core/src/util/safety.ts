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
 * Lock key for serialising writes to a single KB file path against the
 * watcher's add/change/unlink handlers. resolve() normalises so callers
 * that pass relative-or-absolute, with-or-without trailing slash, all
 * agree on the same key.
 */
export function fileLockKey(filePath: string): string {
  return `file:${resolve(filePath)}`;
}

/**
 * Per-key serial async mutex. All callers with the same key run one at a time.
 */
const _locks = new Map<string, Promise<unknown>>();
const _heldKeys = new AsyncLocalStorage<Set<string>>();

/* ────────────────────────────────────────────────────────────────────────── */
/* In-flight tracking + graceful shutdown.                                    */
/* ────────────────────────────────────────────────────────────────────────── */

let _inFlight = 0;
let _shuttingDown = false;
const _drainWaiters: Array<() => void> = [];

/**
 * Wrap a promise with in-flight bookkeeping. Use for any long-running op
 * that doesn't already go through `withLock`.
 */
export async function track<T>(p: Promise<T>): Promise<T> {
  _inFlight++;
  try {
    return await p;
  } finally {
    _inFlight--;
    if (_inFlight === 0 && _drainWaiters.length > 0) {
      const waiters = _drainWaiters.splice(0);
      for (const w of waiters) w();
    }
  }
}

/** Current count of in-flight tracked operations. */
export function inFlightCount(): number {
  return _inFlight;
}

/** Whether `gracefulShutdown` has been initiated. */
export function isShuttingDown(): boolean {
  return _shuttingDown;
}

/**
 * Mark the process as shutting down. New calls to `withLock` and `track`
 * still execute (they're already in flight when the signal arrives), but
 * external callers can check `isShuttingDown()` to refuse new work.
 */
export function setShuttingDown(value: boolean): void {
  _shuttingDown = value;
}

/**
 * Resolve once `_inFlight === 0` or `timeoutMs` elapses. Returns the count
 * of still-in-flight operations at resolve time (0 = clean drain;
 * positive = timeout reached with work still pending).
 */
export function awaitDrain(timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    if (_inFlight === 0) {
      resolve(0);
      return;
    }
    let settled = false;
    const onDrain = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(0);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = _drainWaiters.indexOf(onDrain);
      if (idx >= 0) _drainWaiters.splice(idx, 1);
      resolve(_inFlight);
    }, timeoutMs);
    timer.unref?.();
    _drainWaiters.push(onDrain);
  });
}

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
  // In-flight bookkeeping: count this as a tracked op.
  _inFlight++;
  next.then(
    () => {
      _inFlight--;
      if (_inFlight === 0 && _drainWaiters.length > 0) {
        const waiters = _drainWaiters.splice(0);
        for (const w of waiters) w();
      }
    },
    () => {
      _inFlight--;
      if (_inFlight === 0 && _drainWaiters.length > 0) {
        const waiters = _drainWaiters.splice(0);
        for (const w of waiters) w();
      }
    },
  );
  return next;
}
