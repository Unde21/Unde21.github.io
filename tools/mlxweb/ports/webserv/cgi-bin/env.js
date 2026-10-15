#!/usr/bin/node
// CGI demo: webserv forks, sets these variables, runs this script and
// streams what it prints back to the browser (chunked).
const env = process.env;
const rows = Object.keys(env).sort().map((k) =>
  `<tr><td>${k}</td><td>${String(env[k]).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</td></tr>`).join('');
const q = new URLSearchParams(env.QUERY_STRING || '');
const name = q.get('name') || 'stranger';
process.stdout.write('Content-Type: text/html\r\n\r\n');
process.stdout.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>CGI env</title>
<style>body{background:#1a1a1a;color:#eee;font:15px/1.5 system-ui,sans-serif;margin:2rem}
h1{color:#16d705;margin:0 0 .3rem}table{border-collapse:collapse;margin-top:1rem}
td{border-top:1px solid #333;padding:.3rem .8rem;font-family:ui-monospace,monospace;font-size:13px;vertical-align:top}
td:first-child{color:#16d705}a{color:#16d705}</style></head><body>
<h1>Hello, ${name.replace(/</g, '&lt;')}!</h1>
<p>Printed by <code>${env.SCRIPT_FILENAME}</code>, run by webserv through <code>fork()</code> + <code>execve()</code>, pid ${process.pid}.</p>
<p>Try <a href="?name=42%20Lyon&amp;lang=en">?name=42 Lyon</a>.</p>
<table>${rows}</table></body></html>`);
