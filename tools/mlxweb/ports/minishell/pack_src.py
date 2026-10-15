#!/usr/bin/env python3
"""pack_src.py REPO OUT.json -> the Minishell sources as {path: text}.

The web terminal puts them in ~/minishell_src so visitors can cat, grep and
wc the real code from inside the shell."""
import json, os, sys

repo, out = sys.argv[1], sys.argv[2]
files = {}
for top in ('Makefile', 'includes', 'srcs'):
    path = os.path.join(repo, top)
    walk = [(repo, [], [top])] if os.path.isfile(path) else os.walk(path)
    for root, _, names in walk:
        for n in sorted(names):
            if n.endswith(('.c', '.h')) or n == 'Makefile':
                full = os.path.join(root, n)
                with open(full, encoding='utf-8', errors='replace') as f:
                    files[os.path.relpath(full, repo)] = f.read()
with open(out, 'w') as f:
    json.dump(files, f, separators=(',', ':'), sort_keys=True)
print(f'{len(files)} files -> {out}')
