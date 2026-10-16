// '#wasm-compiler-loader' of Prisma's edge client: the query compiler is
// shipped as base64 inside the bundle, compiled once here.
const { wasm } = require('PRISMA_WASM_B64');
const bytes = Uint8Array.from(atob(wasm), (c) => c.charCodeAt(0));
module.exports = { __esModule: true, default: WebAssembly.compile(bytes).then((m) => ({ default: m })) };
