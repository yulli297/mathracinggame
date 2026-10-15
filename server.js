'use strict';
/**
 * 소수의 나눗셈 스피드 레이서 - 서버
 *  - 학생용 정적 파일(public/) 서빙
 *  - 리더보드 / 기록 저장 / 오답 집계 API
 *  - 교사용 대시보드 (/teacher, 비밀번호 필요)
 *
 * 환경변수
 *  PORT              Render가 자동으로 지정
 *  TEACHER_PASSWORD  교사용 페이지 비밀번호 (꼭 설정하세요)
 *  MAX_STUDENTS      학급 인원 (기본 24)
 *  DATA_FILE         기록 저장 파일 경로 (기본 ./data/records.json)
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MAX_STUDENTS = parseInt(process.env.MAX_STUDENTS || '24', 10);
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || 'teacher';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'records.json');
const QUESTION_COUNT = 10;
const MIN_TIME_MS = 20 * 1000;      // 이보다 빠른 기록은 비정상으로 간주
const MAX_TIME_MS = 30 * 60 * 1000;
const MAX_RECORDS = 5000;

if (!process.env.TEACHER_PASSWORD) {
  console.warn('[경고] TEACHER_PASSWORD 환경변수가 없어 기본 비밀번호(teacher)를 사용합니다. Render 환경변수에 꼭 설정하세요.');
}

/* ---------- 기록 저장소 (메모리 + 파일) ---------- */
let records = [];
try {
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (Array.isArray(parsed)) records = parsed;
} catch (e) { /* 첫 실행이면 파일이 없는 것이 정상 */ }

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(records));
    } catch (e) {
      console.error('기록 저장 실패:', e.message);
    }
  }, 1500);
}

function bestByStudent() {
  const best = new Map();
  for (const r of records) {
    const cur = best.get(r.student);
    if (!cur || r.time < cur.time) best.set(r.student, r);
  }
  return [...best.values()].sort((a, b) => a.time - b.time);
}

/* ---------- 앱 ---------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const decoded = Buffer.from(h.slice(6), 'base64').toString();
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    const a = Buffer.from(pass);
    const b = Buffer.from(TEACHER_PASSWORD);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Teacher"');
  res.status(401).send('교사용 페이지입니다. 비밀번호를 입력해 주세요.');
}

app.get('/ping', (req, res) => res.type('text').send('pong'));

app.get('/api/config', (req, res) => {
  res.json({ maxStudents: MAX_STUDENTS, questionCount: QUESTION_COUNT });
});

app.get('/api/leaderboard', (req, res) => {
  const top = bestByStudent().slice(0, 10).map(r => ({ student: r.student, time: r.time, wrong: r.wrong }));
  res.json(top);
});

app.post('/api/result', (req, res) => {
  const b = req.body || {};
  const student = Number.isInteger(b.student) ? b.student : NaN;
  const time = Math.round(Number(b.time));
  if (!(student >= 1 && student <= MAX_STUDENTS)) return res.status(400).json({ error: '번호가 올바르지 않아요.' });
  if (!(time >= MIN_TIME_MS && time <= MAX_TIME_MS)) return res.status(400).json({ error: '기록이 올바르지 않아요.' });
  if (!Array.isArray(b.answers) || b.answers.length !== QUESTION_COUNT) return res.status(400).json({ error: '답안 수가 올바르지 않아요.' });

  const answers = [];
  for (const a of b.answers) {
    if (!a || ![1, 2, 3].includes(a.lv)) return res.status(400).json({ error: '답안 형식 오류' });
    answers.push({
      lv: a.lv,
      type: String(a.type || '').slice(0, 20),
      q: String(a.q || '').slice(0, 120),
      ans: String(a.ans || '').slice(0, 12),
      given: String(a.given || '').slice(0, 12),
      ok: !!a.ok,
      ms: Math.max(0, Math.min(600000, Math.round(Number(a.ms) || 0)))
    });
  }
  const wrong = answers.filter(a => !a.ok).length;
  records.push({ student, time, wrong, answers, at: Date.now() });
  if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS);
  scheduleSave();

  const ranking = bestByStudent();
  const rank = ranking.findIndex(r => r.student === student) + 1;
  const best = ranking.find(r => r.student === student);
  res.json({ ok: true, rank, total: ranking.length, best: best ? best.time : time, isBest: best ? best.time === time : true });
});

/* ---------- 교사용 ---------- */
function buildStats() {
  const lv = { 1: { n: 0, ok: 0, ms: 0 }, 2: { n: 0, ok: 0, ms: 0 }, 3: { n: 0, ok: 0, ms: 0 } };
  const types = {};
  const students = new Map();
  const recentWrong = [];
  for (const r of records) {
    const s = students.get(r.student) || { student: r.student, games: 0, best: Infinity, ok: 0, n: 0 };
    s.games++; s.best = Math.min(s.best, r.time);
    for (const a of r.answers) {
      lv[a.lv].n++; lv[a.lv].ms += a.ms; if (a.ok) lv[a.lv].ok++;
      const t = types[a.type] || (types[a.type] = { n: 0, ok: 0 });
      t.n++; if (a.ok) t.ok++;
      s.n++; if (a.ok) s.ok++;
      if (!a.ok) recentWrong.push({ student: r.student, q: a.q, given: a.given, ans: a.ans, lv: a.lv, at: r.at });
    }
    students.set(r.student, s);
  }
  recentWrong.sort((a, b) => b.at - a.at);
  return {
    total: records.length,
    levels: lv,
    types,
    students: [...students.values()].sort((a, b) => a.student - b.student),
    ranking: bestByStudent().map(r => ({ student: r.student, time: r.time, wrong: r.wrong })),
    recentWrong: recentWrong.slice(0, 30)
  };
}

app.get('/teacher', auth, (req, res) => res.sendFile(path.join(__dirname, 'teacher.html')));
app.get('/teacher/stats', auth, (req, res) => res.json(buildStats()));
app.post('/teacher/reset', auth, (req, res) => {
  if (!req.body || req.body.confirm !== true) return res.status(400).json({ error: 'confirm 필요' });
  records = [];
  scheduleSave();
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`스피드 레이서 서버 실행 중: ${PORT}`));
