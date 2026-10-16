// node:fs: an in-memory file system (uploads, avatars) shared by the backend.
const { Volume, createFsFromVolume } = require('memfs');
const vol = globalThis.__kwizoVol || (globalThis.__kwizoVol = new Volume());
const fs = createFsFromVolume(vol);
fs.promises = fs.promises || fs.promises;
module.exports = fs;
