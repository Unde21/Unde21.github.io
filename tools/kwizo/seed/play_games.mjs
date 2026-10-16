// play_games.mjs API_BASE: plays a few real sessions between seeded users, so
// the demo starts with stats and leaderboards. Same protocol as the team's
// backend/project/scripts/realtime-quiz-client.ts (REST + Socket.io). Players
// get a skill level: the chance that they pick a correct answer.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { io } = require(process.env.SOCKET_IO_CLIENT);
const BASE = process.argv[2] || 'http://localhost:8080';
const PASSWORD = 'Password!0';

async function http(method, path, token, body) {
  const r = await fetch(BASE + '/api' + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const login = async (username) => (await http('POST', '/auth/login', null, { email: `${username}@kwizo.demo`, password: PASSWORD })).accessToken;
const ack = (socket, event, payload) => new Promise((resolve, reject) => {
  const cb = (err, res) => (err ? reject(err) : resolve(res));
  if (payload === undefined) socket.timeout(10000).emit(event, cb); else socket.timeout(10000).emit(event, payload, cb);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = (token) => new Promise((resolve, reject) => {
  const s = io(BASE + '/api/session', { path: '/socket.io', auth: { accessToken: token }, transports: ['websocket'], reconnection: false });
  s.once('connect', () => resolve(s)); s.once('connect_error', reject);
});

async function playSession({ host, quizName, players }) {
  const hostToken = await login(host);
  const quizzes = await http('GET', '/quiz/me', hostToken);
  const quiz = quizzes.find((q) => q.name === quizName) || quizzes[0];
  const full = await http('GET', `/quiz/me/${quiz.id}`, hostToken);
  const correct = new Map();
  for (const q of full.questions || []) {
    const question = q.question || q;
    correct.set(question.id, (question.answers || []).filter((a) => a.isCorrect).map((a) => a.id));
  }
  if (quiz.status !== 'PUBLISHED') await http('POST', `/quiz/me/${quiz.id}/publish`, hostToken).catch(() => {});
  const session = await http('POST', '/quiz-session/lobby/create', hostToken, { quizId: quiz.id });
  const hostSocket = await connect(hostToken);
  await ack(hostSocket, 'enterSessionRoom', { sessionId: session.id });
  const sockets = [];
  for (const p of players) {
    const token = await login(p.name);
    await http('POST', '/quiz-session/lobby/join', token, { joinCode: session.joinCode });
    const s = await connect(token);
    s.on('roundStarted', (payload) => {
      const q = payload.question;
      const good = correct.get(q.id) || [];
      const all = (q.answers || []).map((a) => a.id);
      const pick = Math.random() < p.skill && good.length ? good : [all[Math.floor(Math.random() * all.length)]];
      setTimeout(() => ack(s, 'userAnswered', { answersIds: pick }).catch(() => {}), 300 + Math.random() * 1500 * (1.4 - p.skill));
    });
    await ack(s, 'enterSessionRoom', { sessionId: session.id });
    sockets.push(s);
  }
  const done = new Promise((resolve) => hostSocket.on('sessionTerminated', resolve));
  await http('PATCH', `/game/start/${session.id}`, hostToken);
  const result = await Promise.race([done, sleep(15 * 60 * 1000)]);
  for (const s of [hostSocket, ...sockets]) s.disconnect();
  const ranking = (result && result.participants || []).sort((a, b) => a.rank - b.rank).map((x) => `${x.username} ${x.score}`).join(', ');
  console.log(`✔ ${quiz.name} (host ${host}): ${ranking}`);
}

const skilled = (name, skill) => ({ name, skill });
const games = [
  { host: 'quizmaster', quizName: 'Quiz Mathematiques', players: [skilled('lmartin88', 0.85), skilled('em_ber', 0.7), skilled('tom_dub', 0.5), skilled('learo92', 0.35)] },
  { host: 'quizmaster', quizName: 'English Proficiency', players: [skilled('em_ber', 0.75), skilled('chlo_mo', 0.6), skilled('h_laurent', 0.45), skilled('alice_le', 0.9)] },
  { host: 'quizmaster', quizName: 'Quiz Science Generale', players: [skilled('lmartin88', 0.8), skilled('nat_girard', 0.55), skilled('manon_rx', 0.65)] },
  { host: 'quizmaster', quizName: 'Langage C Expert', players: [skilled('jpetit_dev', 0.9), skilled('enzof', 0.6), skilled('tom_dub', 0.4), skilled('smorel_77', 0.5), skilled('mathis_a', 0.7)] },
  { host: 'quizmaster', quizName: 'Exploration du Monde', players: [skilled('alice_le', 0.8), skilled('learo92', 0.5), skilled('j_mercier', 0.6)] },
  { host: 'quizmaster', quizName: 'Quiz 1 sur le dev', players: [skilled('jpetit_dev', 0.85), skilled('leoblanc_01', 0.55), skilled('ines_gue', 0.65), skilled('p_boyer', 0.45)] },
  { host: 'quizmaster', quizName: 'Quiz Mathematiques', players: [skilled('clara_g', 0.75), skilled('lmartin88', 0.9), skilled('chlo_mo', 0.5)] },
];
for (const g of games) {
  try { await playSession(g); } catch (e) { console.error('✘', g.quizName, e.message); }
}
console.log('done');
process.exit(0);
