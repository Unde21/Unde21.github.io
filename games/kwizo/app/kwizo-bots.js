/*
 * bots.js — players for the demo, so a game is not played alone. Same flow as
 * backend/project/scripts/realtime-quiz-client.ts: log in as a seeded user,
 * POST /quiz-session/lobby/join, open the /api/session socket, enter the
 * session room, then answer every round after a human-like delay.
 * Loaded into the app page (it shares its backend and request bridge).
 */
(function () {
  'use strict';
  var API = 'https://kwizo.demo';
  var HERE = (document.currentScript && document.currentScript.src) || location.href;
  var NAMES = ['lmartin88', 'em_ber', 'tom_dub', 'learo92', 'jpetit_dev', 'chlo_mo', 'h_laurent', 'alice_le', 'nat_girard',
    'manon_rx', 'enzof', 'smorel_77', 'mathis_a', 'j_mercier', 'leoblanc_01', 'ines_gue', 'p_boyer', 'clara_g'];
  var bots = [];
  var listeners = [];
  function emitChange() { listeners.forEach(function (f) { try { f(bots.map(function (b) { return { name: b.name, state: b.state, score: b.score }; })); } catch (e) { /* ignore */ } }); }

  async function http(method, path, token, body) {
    var res = await window.__kwizoSend(method, API + path, Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}), body === undefined ? null : JSON.stringify(body));
    var text = new TextDecoder().decode(res.body);
    if (res.status >= 400) throw new Error(method + ' ' + path + ' -> ' + res.status + ' ' + text.slice(0, 200));
    return text ? JSON.parse(text) : null;
  }
  function ack(socket, event, payload) {
    return new Promise(function (resolve, reject) {
      var cb = function (err, res) { if (err) reject(err); else resolve(res); };
      if (payload === undefined) socket.timeout(8000).emit(event, cb); else socket.timeout(8000).emit(event, payload, cb);
    });
  }
  function loadIo() {
    if (window.io) return Promise.resolve(window.io);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = new URL('socket.io.min.js', HERE).href;
      s.onload = function () { resolve(window.io); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function pickAnswers(question) {
    var a = question.answers || [];
    if (!a.length) return [];
    var first = a[Math.floor(Math.random() * a.length)];
    if (question.type === 'MULTIPLE' && a.length > 2 && Math.random() < 0.5) {
      var second = a.filter(function (x) { return x.id !== first.id; })[Math.floor(Math.random() * (a.length - 1))];
      return [first.id, second.id];
    }
    return [first.id];
  }

  async function addBot(joinCode) {
    var used = bots.map(function (b) { return b.name; });
    var free = NAMES.filter(function (n) { return used.indexOf(n) < 0; });
    if (!free.length) throw new Error('no more bots');
    var name = free[Math.floor(Math.random() * free.length)];
    var bot = { name: name, state: 'joining', score: 0 };
    bots.push(bot); emitChange();
    try {
      var tokens = await http('POST', '/api/auth/login', null, { email: name + '@kwizo.demo', password: 'Password!0' });
      bot.token = tokens.accessToken;
      var session = await http('POST', '/api/quiz-session/lobby/join', bot.token, { joinCode: joinCode });
      var io = await loadIo();
      var socket = io(API + '/api/session', { path: '/socket.io', auth: { accessToken: bot.token }, transports: ['polling'], upgrade: false, reconnection: false });
      bot.socket = socket;
      await new Promise(function (resolve, reject) { socket.once('connect', resolve); socket.once('connect_error', reject); });
      socket.on('roundStarted', function (p) {
        if (bot.round === p.roundNumber) return;
        bot.round = p.roundNumber;
        var limit = Math.max(2, (p.endsAt - Date.now()) / 1000);
        var delay = (1.5 + Math.random() * Math.min(9, limit * 0.6)) * 1000;
        setTimeout(function () { ack(socket, 'userAnswered', { answersIds: pickAnswers(p.question) }).catch(function () {}); }, delay);
      });
      socket.on('roundCompleted', function (p) {
        var me = (p.participants || []).find(function (x) { return x.username === name; });
        if (me) { bot.score = me.score; emitChange(); }
      });
      socket.on('sessionTerminated', function () { bot.state = 'done'; emitChange(); setTimeout(function () { removeBot(bot); }, 4000); });
      socket.on('removedFromSession', function () { removeBot(bot); });
      socket.on('sessionDestroyed', function () { removeBot(bot); });
      await ack(socket, 'enterSessionRoom', { sessionId: session && session.id ? session.id : session.sessionId });
      bot.state = 'ready'; emitChange();
    } catch (e) {
      console.warn('[kwizo bots]', name, e);
      removeBot(bot);
      throw e;
    }
    return bot;
  }
  function removeBot(bot) {
    var i = bots.indexOf(bot);
    if (i < 0) return;
    bots.splice(i, 1);
    try { bot.socket && bot.socket.disconnect(); } catch (e) { /* ignore */ }
    emitChange();
  }
  window.__kwizoBots = {
    add: addBot,
    clear: function () { bots.slice().forEach(removeBot); },
    list: function () { return bots.slice(); },
    onChange: function (f) { listeners.push(f); },
  };
})();
