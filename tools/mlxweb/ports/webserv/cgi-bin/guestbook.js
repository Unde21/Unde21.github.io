#!/usr/bin/node
// CGI demo: reads the POST body from stdin (webserv writes it to a temp
// file and dup2()s it on stdin), and answers with what it received.
const method = process.env.REQUEST_METHOD || (process.env.CONTENT_LENGTH ? 'POST' : 'GET');
const body = method === 'POST' ? await process.stdin.read() : '';
const form = new URLSearchParams(body);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
process.stdout.write('Content-Type: text/html\r\n\r\n');
process.stdout.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Guestbook</title>
<style>body{background:#1a1a1a;color:#eee;font:16px/1.5 system-ui,sans-serif;margin:2rem;max-width:40rem}
h1{color:#16d705;margin:0 0 1rem}input,textarea{display:block;width:100%;margin:.3rem 0 1rem;padding:.5rem;
background:#111;color:#eee;border:1px solid #444;border-radius:6px;font:inherit}
button{background:#16d705;border:0;padding:.6rem 1.2rem;border-radius:6px;font-weight:700;cursor:pointer}
pre{background:#111;padding:1rem;border-radius:6px;white-space:pre-wrap}</style></head><body>
<h1>CGI guestbook</h1>
${body ? `<p>webserv passed ${process.env.CONTENT_LENGTH} bytes on stdin:</p><pre>${esc(body)}</pre>
<p><b>${esc(form.get('name') || 'Someone')}</b> says: ${esc(form.get('message') || '…')}</p>` : ''}
<form method="POST" action="/cgi-bin/guestbook.js">
<label>Name<input name="name" value="${esc(form.get('name') || '')}"></label>
<label>Message<textarea name="message" rows="3"></textarea></label>
<button>Send with POST</button></form></body></html>`);
