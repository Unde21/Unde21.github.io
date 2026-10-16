#!/usr/bin/env python3
"""make_seed.py INIT_TS OUT_TS: a copy of frontend/init.ts for the public demo.

- every email becomes <username>@kwizo.demo
- the two accounts of real people are renamed (and keep everything they own)
- the API URL comes from SEED_API
"""
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
RENAME = {'aleguel': ('quizmaster', 'Master', 'Quiz'), 'izo276': ('trivia_fan', 'Fan', 'Trivia')}
def user_line(m):
    line = m.group(0)
    u = re.search(r'username: "([^"]+)"', line).group(1)
    if u in RENAME:
        nu, ln, fn = RENAME[u]
        line = re.sub(r'username: "[^"]+"', f'username: "{nu}"', line)
        line = re.sub(r'lastName: "[^"]*"', f'lastName: "{ln}"', line)
        line = re.sub(r'firstName: "[^"]*"', f'firstName: "{fn}"', line)
        u = nu
    return re.sub(r'email: "[^"]*"', f'email: "{u.lower()}@kwizo.demo"', line)
src = re.sub(r'^\s*\{ email: "[^\n]*$', user_line, src, flags=re.M)
for old, (new, _, _) in RENAME.items():
    src = src.replace(f'username: "{old}"', f'username: "{new}"').replace(f'user: "{old}"', f'user: "{new}"')
# The bulk endpoints run every bcrypt hash in one 5 s transaction: too slow on a
# small build machine. Same users, one register/login call each.
REG = 'const result = await api.post("/auth/register-many", { users: listUser });'
LOG = 'const result = await api.post("/auth/login-many", { credentials });'
assert REG in src and LOG in src
src = src.replace(REG, 'for (const u of listUser) await api.post("/auth/register", u);')
src = src.replace(LOG, 'const result = { data: [] as any[] };\n        for (const u of listUser) { const r = await api.post("/auth/login", { email: u.email, password: u.password }); result.data.push({ email: u.email, username: u.username, accessToken: r.data.accessToken }); }')
src = src.replace("import * as dotenv from 'dotenv';\ndotenv.config();", '')
src = src.replace('baseURL: `http://localhost:8080/api`', 'baseURL: process.env.SEED_API || `http://localhost:8080/api`')
assert '@gmail' not in src and 'aleguel' not in src and 'izo276' not in src, 'anonymisation incomplete'
open(sys.argv[2], 'w', encoding='utf-8').write(src)
print('seed written')
