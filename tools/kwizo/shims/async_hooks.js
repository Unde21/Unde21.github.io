// node:async_hooks: AsyncLocalStorage without async context tracking
// (enough for libraries that only use it synchronously).
class AsyncLocalStorage {
  constructor() { this._store = undefined; }
  getStore() { return this._store; }
  run(store, fn, ...args) { const prev = this._store; this._store = store; try { return fn(...args); } finally { this._store = prev; } }
  enterWith(store) { this._store = store; }
  exit(fn, ...args) { return this.run(undefined, fn, ...args); }
  disable() { this._store = undefined; }
}
class AsyncResource { constructor() {} runInAsyncScope(fn, thisArg, ...args) { return fn.apply(thisArg, args); } emitDestroy() { return this; } static bind(fn) { return fn; } bind(fn) { return fn; } }
module.exports = { AsyncLocalStorage, AsyncResource, createHook: () => ({ enable() { return this; }, disable() { return this; } }), executionAsyncId: () => 1, triggerAsyncId: () => 0 };
