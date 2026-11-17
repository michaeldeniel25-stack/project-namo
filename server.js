'use strict';

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET;

if (IS_PRODUCTION && (!SESSION_SECRET || SESSION_SECRET.length < 32)) {
  throw new Error('Set SESSION_SECRET to a random value of at least 32 characters in production.');
}
fs.mkdirSync(DATA_DIR, { recursive: true });

const EMPTY_DB = { users: [], requests: [] };
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(EMPTY_DB, null, 2));

function readDB() {
  let db;
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { throw new Error('The local database file could not be read.'); }
  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.requests)) db.requests = [];

  // Backward-compatible field migration from earlier prototypes.
  for (const user of db.users) {
    if (!user.lrn && user.studentNo) user.lrn = String(user.studentNo);
    delete user.studentNo;
  }
  for (const request of db.requests) {
    if (!request.lrn && request.studentNo) request.lrn = String(request.studentNo);
    delete request.studentNo;
    if (!Array.isArray(request.history)) {
      request.history = [{ status: request.status || 'Pending', note: 'Request recorded.', at: request.createdAt || new Date().toISOString() }];
    }
  }
  return db;
}
function writeDB(db) {
  const temp = DB_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(db, null, 2));
  fs.renameSync(temp, DB_FILE);
}
function publicUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}
function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function validLRN(value) { return /^\d{12}$/.test(String(value || '').trim()); }

// Create a registrar only when the owner supplies credentials through environment variables.
function ensureRegistrar() {
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!email && !password) return;
  if (!email || password.length < 12) {
    throw new Error('Set both ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters) to create the registrar account.');
  }
  const db = readDB();
  const existing = db.users.find(u => u.role === 'registrar');
  if (existing) return;
  db.users.push({
    id: 'reg-' + crypto.randomUUID(),
    name: 'School Registrar',
    email,
    passwordHash: bcrypt.hashSync(password, 12),
    role: 'registrar',
    createdAt: new Date().toISOString()
  });
  writeDB(db);
  console.log('Initial registrar account created for ' + email);
}
ensureRegistrar();

app.disable('x-powered-by');
// Trust Render's HTTPS reverse proxy so secure session cookies work in production.
if (IS_PRODUCTION) app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(session({
  name: 'schooldocs.sid',
  secret: SESSION_SECRET || 'local-development-only-change-this-secret-please',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
    maxAge: 8 * 60 * 60 * 1000
  }
}));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

function requireAuth(req, res, next) {
  const db = readDB();
  const user = db.users.find(item => item.id === req.session.userId);
  if (!user) return res.status(401).json({ error: 'Please log in to continue.' });
  req.user = user;
  next();
}
function requireRegistrar(req, res, next) {
  if (req.user.role !== 'registrar') return res.status(403).json({ error: 'Registrar access only.' });
  next();
}

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'SchoolDocs', version: '3.0.0' }));

app.post('/api/register', (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const lrn = String(body.lrn || '').trim();
  const grade = String(body.grade || '').trim();
  const section = String(body.section || '').trim();

  if (![name, email, password, lrn, grade, section].every(Boolean)) {
    return res.status(400).json({ error: 'Please complete all required fields.' });
  }
  if (name.length > 100 || email.length > 160 || grade.length > 40 || section.length > 60) {
    return res.status(400).json({ error: 'One or more fields are too long.' });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!validLRN(lrn)) return res.status(400).json({ error: 'Enter a valid 12-digit Learner Reference Number (LRN).' });

  const db = readDB();
  if (db.users.some(u => u.email.toLowerCase() === email || (u.lrn && u.lrn === lrn))) {
    return res.status(409).json({ error: 'That email address or LRN is already registered.' });
  }
  const user = {
    id: 'stu-' + crypto.randomUUID(), name, email,
    passwordHash: bcrypt.hashSync(password, 12), role: 'student',
    lrn, grade, section, createdAt: new Date().toISOString()
  };
  db.users.push(user);
  writeDB(db);
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Could not start your session. Please log in.' });
    req.session.userId = user.id;
    res.status(201).json({ user: publicUser(user) });
  });
});

app.post('/api/login', (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  const password = String((req.body && req.body.password) || '');
  const db = readDB();
  const user = db.users.find(item => item.email.toLowerCase() === email);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Could not start your session. Please try again.' });
    req.session.userId = user.id;
    res.json({ user: publicUser(user) });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Could not log out. Please try again.' });
    res.clearCookie('schooldocs.sid', { httpOnly: true, sameSite: 'lax', secure: IS_PRODUCTION });
    res.json({ ok: true });
  });
});
app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.get('/api/requests', requireAuth, (req, res) => {
  const db = readDB();
  const requests = req.user.role === 'registrar'
    ? db.requests
    : db.requests.filter(item => item.studentId === req.user.id);
  requests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ requests });
});

app.post('/api/requests', requireAuth, (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Only student accounts can submit requests.' });
  const body = req.body || {};
  const documents = [
    'Certificate of Enrollment', 'Certificate of Grades', 'Good Moral Certificate',
    'Form 137 / Permanent Record', 'Certificate of Graduation', 'Other'
  ];
  const purposes = ['School requirement', 'Job application', 'Scholarship application', 'Personal use', 'Other'];
  const copies = Number(body.copies);
  if (!documents.includes(body.documentType) || !purposes.includes(body.purpose) || ![1, 2, 3].includes(copies)) {
    return res.status(400).json({ error: 'Please check the document type, purpose, and number of copies.' });
  }
  const db = readDB();
  const now = new Date().toISOString();
  const request = {
    id: 'SD-' + crypto.randomUUID().slice(0, 8).toUpperCase(),
    studentId: req.user.id,
    studentName: req.user.name,
    lrn: req.user.lrn,
    grade: req.user.grade,
    section: req.user.section,
    documentType: body.documentType,
    purpose: body.purpose,
    copies,
    notes: String(body.notes || '').trim().slice(0, 500),
    status: 'Pending',
    registrarNote: '',
    createdAt: now,
    updatedAt: now,
    pickedUpAt: null,
    history: [{ status: 'Pending', note: 'Request submitted by student.', at: now }]
  };
  db.requests.push(request);
  writeDB(db);
  res.status(201).json({ request });
});

app.patch('/api/requests/:id', requireAuth, requireRegistrar, (req, res) => {
  const statuses = ['Pending', 'Processing', 'Rejected', 'Ready for Pickup', 'Completed'];
  const status = String((req.body && req.body.status) || '');
  const note = String((req.body && req.body.registrarNote) || '').trim().slice(0, 500);
  if (!statuses.includes(status)) return res.status(400).json({ error: 'Choose a valid request status.' });
  const db = readDB();
  const request = db.requests.find(item => item.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  const changed = request.status !== status || (request.registrarNote || '') !== note;
  request.status = status;
  request.registrarNote = note;
  request.updatedAt = new Date().toISOString();
  if (status === 'Completed' && !request.pickedUpAt) request.pickedUpAt = request.updatedAt;
  if (changed) request.history.push({
    status,
    note: note || (status === 'Ready for Pickup' ? 'Document is ready for physical pickup.' : 'Request status updated by registrar.'),
    at: request.updatedAt
  });
  writeDB(db);
  res.json({ request });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.listen(PORT, '0.0.0.0', () => console.log(`SchoolDocs is running on port ${PORT}`));
