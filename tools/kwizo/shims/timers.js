// node:timers: timers that return Node-like Timeout objects (refresh, unref,
// ref, hasRef), which engine.io and others rely on.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
const realSetInterval = globalThis.setInterval.bind(globalThis);
const realClearInterval = globalThis.clearInterval.bind(globalThis);
class Timeout {
  constructor(fn, ms, args, repeat) { this._fn = fn; this._ms = ms; this._args = args; this._repeat = repeat; this._start(); }
  _start() { this._id = this._repeat ? realSetInterval(this._fn, this._ms, ...this._args) : realSetTimeout(this._fn, this._ms, ...this._args); }
  refresh() { this.close(); this._start(); return this; }
  close() { (this._repeat ? realClearInterval : realClearTimeout)(this._id); return this; }
  ref() { return this; } unref() { return this; } hasRef() { return true; }
  [Symbol.toPrimitive]() { return this._id; }
}
const clear = (t) => { if (t instanceof Timeout) t.close(); else if (t != null) { realClearTimeout(t); realClearInterval(t); } };
const setImmediate = (fn, ...args) => new Timeout(fn, 0, args, false);
module.exports = {
  setTimeout: (fn, ms, ...args) => new Timeout(fn, ms, args, false),
  setInterval: (fn, ms, ...args) => new Timeout(fn, ms, args, true),
  clearTimeout: clear, clearInterval: clear, setImmediate, clearImmediate: clear, Timeout,
  promises: { setTimeout: (ms, v) => new Promise((r) => realSetTimeout(() => r(v), ms)), setImmediate: (v) => Promise.resolve(v) },
};
