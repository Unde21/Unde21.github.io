// node:crypto for the browser: crypto-browserify plus what jsonwebtoken 9 and
// friends expect from modern Node (KeyObject, secret keys, timingSafeEqual).
const cb = require('crypto-browserify');
const { Buffer } = require('buffer');

class KeyObject {
  constructor(type, data) { this.type = type; this._data = data; }
  get symmetricKeySize() { return this.type === 'secret' ? this._data.length : undefined; }
  export() { return Buffer.from(this._data); }
  equals(o) { return o instanceof KeyObject && Buffer.compare(this._data, o._data) === 0; }
}
const toBuf = (k, enc) => (k instanceof KeyObject ? k._data : Buffer.isBuffer(k) ? k : typeof k === 'string' ? Buffer.from(k, enc) : Buffer.from(k));
function createSecretKey(key, enc) { return new KeyObject('secret', toBuf(key, enc)); }
function noAsymmetric() { throw new Error('asymmetric keys are not available in the demo'); }
function timingSafeEqual(a, b) {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
  let r = 0; for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i]; return r === 0;
}
module.exports = {
  ...cb,
  KeyObject, createSecretKey, createPrivateKey: noAsymmetric, createPublicKey: noAsymmetric,
  createHmac: (alg, key) => cb.createHmac(alg, toBuf(key)),
  timingSafeEqual,
  randomUUID: () => globalThis.crypto.randomUUID(),
  webcrypto: globalThis.crypto, subtle: globalThis.crypto && globalThis.crypto.subtle,
  getRandomValues: (a) => globalThis.crypto.getRandomValues(a),
  constants: cb.constants || {},
};
