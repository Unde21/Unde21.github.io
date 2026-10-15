#!/usr/bin/env python3
"""pack.py OUT_BASE ROOT path_or_dir... -> OUT_BASE.json + OUT_BASE.pak (gzip)

Bundles a program's data files (maps, textures) so the browser fetches two
files. Paths are stored relative to ROOT (the program's working directory).
.xpm files are converted to MLXB, a compact indexed-colour format that
mlx_web.c reads in place of XPM text (same path, same pixels).
"""
import gzip
import json
import os
import re
import struct
import sys

import numpy as np

NAMED = {}
_rgb = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mlx_rgb.c')
for m in re.finditer(r'\{\s*"([^"]+)"\s*,\s*(-?0x[0-9a-fA-F]+|-?\d+)\s*\}', open(_rgb).read()):
    NAMED[m.group(1)] = int(m.group(2), 0)


def parse_color(spec):
    spec = spec.strip()
    if spec.startswith('#'):
        h = spec[1:]
        if len(h) == 6:
            return int(h, 16)
        if len(h) == 3:
            return int(''.join(c * 2 for c in h), 16)
        if len(h) == 12:
            return int(h[0:2] + h[4:6] + h[8:10], 16)
        return 0
    v = NAMED.get(spec.lower(), 0)
    return -1 if v == -1 else v


def xpm_to_mlxb(data):
    strings = [m.group(1) for m in re.finditer(rb'/\*.*?\*/|"([^"]*)"', data, re.S) if m.group(1) is not None]
    w, h, nc, cpp = (int(x) for x in strings[0].split()[:4])
    keys, cols = [], []
    for line in strings[1:1 + nc]:
        key, rest = line[:cpp], line[cpp:].decode('latin-1')
        m = re.search(r'(?:^|\s)c\s+(.+?)(?=\s+(?:m|s|g4|g)\s|$)', rest)
        col = parse_color(m.group(1)) if m else 0
        keys.append(key)
        cols.append(col)
    rows = b''.join(s[:w * cpp].ljust(w * cpp, b' ') for s in strings[1 + nc:1 + nc + h])
    raw = np.frombuffer(rows, dtype=np.uint8).reshape(h * w, cpp).astype(np.int64)
    code = np.zeros(h * w, dtype=np.int64)
    for i in range(cpp):
        code = code * 256 + raw[:, i]
    kcodes = np.array([int.from_bytes(k.ljust(cpp, b' '), 'big') for k in keys], dtype=np.int64)
    order = np.argsort(kcodes)
    pos = np.searchsorted(kcodes[order], code)
    pos = np.clip(pos, 0, nc - 1)
    idx = order[pos]
    idx[kcodes[idx] != code] = 0
    has_none = any(c == -1 for c in cols)
    pal = np.array([0xFFFFFFFF if c == -1 else c & 0xFFFFFF for c in cols], dtype='<u4')
    dtype = np.uint8 if nc <= 256 else '<u2'
    head = b'MLXB' + struct.pack('<IIII', w, h, nc, 1 if has_none else 0)
    return head + pal.tobytes() + idx.astype(dtype).tobytes()


def main():
    out, root, *items = sys.argv[1:]
    index, blobs, off = {}, [], 0
    for item in items:
        full = os.path.join(root, item)
        paths = []
        if os.path.isdir(full):
            for d, _, fs in os.walk(full):
                paths += [os.path.join(d, f) for f in sorted(fs)]
        else:
            paths.append(full)
        for p in sorted(paths):
            rel = os.path.relpath(p, root).replace(os.sep, '/')
            data = open(p, 'rb').read()
            if p.endswith('.xpm'):
                try:
                    data = xpm_to_mlxb(data)
                except Exception as e:  # keep the original text if unusual
                    print('  keep xpm text for', rel, '-', e)
            index[rel] = [off, len(data)]
            blobs.append(data)
            off += len(data)
    raw = b''.join(blobs)
    packed = gzip.compress(raw, 6)
    meta = {'gzip': True, 'size': len(raw), 'packed': len(packed), 'files': index}
    chunk = 20 * 1000 * 1000
    if len(packed) > chunk:  # keep every file small enough for any host
        meta['parts'] = []
        for n, i in enumerate(range(0, len(packed), chunk)):
            name = f'.pak.{n}'
            with open(out + name, 'wb') as f:
                f.write(packed[i:i + chunk])
            meta['parts'].append(name)
    else:
        with open(out + '.pak', 'wb') as f:
            f.write(packed)
    with open(out + '.json', 'w') as f:
        json.dump(meta, f)
    print(f'{len(index)} files, {len(raw)/1e6:.1f} MB raw, {len(packed)/1e6:.1f} MB gz -> {out}.pak')


if __name__ == '__main__':
    main()
