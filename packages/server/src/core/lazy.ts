/**
 * Late-bound service reference. Several subsystems depend on each other cyclically
 * (orchestrator → subagent runtime → primitives → orchestrator). `lazy<T>()` returns a proxy that
 * forwards every property access to the instance set later via `set()`, and throws a clear error if
 * touched before wiring completes.
 */
export interface Lazy<T extends object> {
  proxy: T;
  set(instance: T): void;
  get(): T;
}

export function lazy<T extends object>(name: string): Lazy<T> {
  let instance: T | null = null;
  const proxy = new Proxy({} as T, {
    get(_t, prop) {
      if (!instance) throw new Error(`service '${name}' accessed before it was wired`);
      const v = (instance as any)[prop];
      return typeof v === 'function' ? v.bind(instance) : v;
    },
    has(_t, prop) {
      return instance ? prop in instance : false;
    },
  });
  return {
    proxy,
    set(i) {
      instance = i;
    },
    get() {
      if (!instance) throw new Error(`service '${name}' not wired`);
      return instance;
    },
  };
}
