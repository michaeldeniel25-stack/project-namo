'use strict';

require('dotenv').config(); // Load local SMTP and admin settings from .env

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
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], requests: [] }, null, 2));

function readDB() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!Array.isArray(db.users)) db.users = [];
    if (!Array.isArray(db.requests)) db.requests = [];
    // Preserve existing records while filling in fields added in this revision.
    for (const r of db.requests) {
      if (!r.lrn && r.studentNo) r.lrn = String(r.studentNo);
      if (!Array.isArray(r.history)) r.history = [{ status: r.status || 'Pending', note: 'Request recorded.', at: r.createdAt || new Date().toISOString() }];
      if (r.grade === undefined) r.grade = '';
      if (r.section === undefined) r.section = '';
      if (r.email === undefined) r.email = '';
      if (r.schoolYear === undefined) r.schoolYear = '';
      if (r.contactNumber === undefined) r.contactNumber = '';
      if (r.completedAt === undefined) r.completedAt = null;
      if (r.emailStatus === undefined) r.emailStatus = 'not_sent';
      if (r.emailSentAt === undefined) r.emailSentAt = null;
      if (r.emailError === undefined) r.emailError = '';
      if (r.referenceNumber === undefined) r.referenceNumber = r.id || 'LEGACY';
    }
    return db;
  } catch {
    throw new Error('The local database file could not be read.');
  }
}
function writeDB(db) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function normalizeEmail(v) { return String(v || '').trim().toLowerCase(); }
function validLRN(v) { return /^\d{12}$/.test(String(v || '').trim()); }
function validEmail(v) { return /^\S+@\S+\.\S+$/.test(String(v || '').trim()); }
function publicUser(u) { const { passwordHash, ...safe } = u; return safe; }

function ensureRegistrar() {
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!email && !password) return;
  if (!email || password.length < 12) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters).');
  const db = readDB();
  if (db.users.some(u => u.role === 'registrar')) return;
  db.users.push({ id: 'reg-' + crypto.randomUUID(), name: 'School Registrar', email,
    passwordHash: bcrypt.hashSync(password, 12), role: 'registrar', createdAt: new Date().toISOString() });
  writeDB(db);
  console.log('Initial registrar account created.');
}
ensureRegistrar();
app.disable('x-powered-by');
if (IS_PRODUCTION) app.set('trust proxy', 1);
app.use(express.json({ limit: '30kb' }));
app.use(session({ name: 'schooldocs.sid', secret: SESSION_SECRET || 'local-development-only-change-this-secret',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: IS_PRODUCTION, maxAge: 8 * 60 * 60 * 1000 } }));
app.use(express.static(path.join(__dirname, 'public')));

let mailTransport = null;function getMailer() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) return null;
  if (!mailTransport) {
    const nodemailer = require('nodemailer');
    mailTransport = nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT || 587),
      secure: Number(SMTP_PORT || 587) === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } });
  }
  return { transport: mailTransport, from: SMTP_FROM };
}
function auth(req, res, next) {
  const db = readDB();
  const user = db.users.find(x => x.id === req.session.userId && x.role === 'registrar');
  if (!user) return res.status(401).json({ error: 'Please log in as registrar to continue.' });
  req.user = user;
  next();
}
function makeReference() { return 'SD-' + new Date().getFullYear() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase(); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
const DOCUMENTS = ['Certificate of Enrollment','Certificate of Grades','Good Moral Certificate','Form 137 / Permanent Record','Certificate of Graduation','Other'];
const PURPOSES = ['School requirement','Job application','Scholarship application','Personal use','Other'];
const STATUSES = ['Processing','Ready for Pickup','Completed'];

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'SchoolDocs', version: '4.0.0' }));
app.post('/api/login', (req, res) => {
  const email = normalizeEmail(req.body?.email), password = String(req.body?.password || '');
  const user = readDB().users.find(u => u.role === 'registrar' && normalizeEmail(u.email) === email);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) return res.status(401).json({ error: 'Incorrect email or password.' });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Unable to start secure session.' });
    req.session.userId = user.id; res.json({ user: publicUser(user) });
  });
});
app.post('/api/logout', (req, res) => req.session.destroy(err => {
  if (err) return res.status(500).json({ error: 'Unable to log out.' });
  res.clearCookie('schooldocs.sid', { httpOnly: true, sameSite: 'lax', secure: IS_PRODUCTION }); res.json({ ok: true });
}));
app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/requests', (req, res) => {
  const b = req.body || {};
  const studentName = String(b.studentName || '').trim(), lrn = String(b.lrn || '').trim();
  const schoolYear = String(b.schoolYear || '').trim(), email = normalizeEmail(b.email);
  const grade = String(b.grade || '').trim(), section = String(b.section || '').trim();
  const contactNumber = String(b.contactNumber || '').trim(), documentType = String(b.documentType || '').trim();
  const purpose = String(b.purpose || '').trim(), copies = Number(b.copies), notes = String(b.notes || '').trim().slice(0, 500);
  if (!studentName || !lrn || !schoolYear || !email || !documentType || !purpose || !copies) return res.status(400).json({ error: 'Please complete all required fields.' });
  if (studentName.length > 100 || schoolYear.length > 30 || email.length > 160 || grade.length > 40 || section.length > 60 || contactNumber.length > 30) return res.status(400).json({ error: 'Some fields are too long.' });
  if (!validLRN(lrn)) return res.status(400).json({ error: 'LRN must contain exactly 12 digits.' });
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!DOCUMENTS.includes(documentType) || !PURPOSES.includes(purpose) || ![1,2,3,4,5].includes(copies)) return res.status(400).json({ error: 'Check document, purpose, and number of copies.' });
  const db = readDB(), now = new Date().toISOString();
  let referenceNumber = makeReference(); while (db.requests.some(r => r.referenceNumber === referenceNumber)) referenceNumber = makeReference();
  const request = { id: 'req-' + crypto.randomUUID(), referenceNumber, studentName, lrn, schoolYear, email, grade, section, contactNumber,
    documentType, purpose, copies, notes, status: 'Ready for Pickup', registrarNote: '', createdAt: now, updatedAt: now, completedAt: null,
    emailStatus: 'not_sent', emailSentAt: null, emailError: '',
    history: [{ status: 'Ready for Pickup', note: 'Request submitted online.', at: now }] };
  db.requests.push(request); writeDB(db);
  res.status(201).json({ referenceNumber, request: { referenceNumber, studentName, documentType, status: 'Ready for Pickup', createdAt: now } });
});
app.get('/api/requests', auth, (_req, res) => { const db = readDB(); db.requests.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)); res.json({ requests: db.requests }); });
app.get('/api/requests/:id', auth, (req, res) => { const r = readDB().requests.find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: 'Request not found.' }); res.json({ request: r }); });

async function sendCompletionEmail(r) {
  const cfg = getMailer();
  if (!cfg) throw new Error('Email is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM.');
  const maskedLRN = r.lrn ? `${r.lrn.slice(0,4)}••••••••` : 'Not provided';
  const submitted = r.createdAt ? new Date(r.createdAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const completed = r.completedAt ? new Date(r.completedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const plain = ['SchoolDocs - Request Completion Receipt','',`Name: ${r.studentName}`,`LRN: ${maskedLRN}`,`Reference: ${r.referenceNumber}`,`Document: ${r.documentType}`,`Purpose: ${r.purpose}`,`Copies: ${r.copies}`,`School Year: ${r.schoolYear}`,`Submitted: ${submitted}`,`Completed: ${completed}`,'Status: Completed','','This email is a receipt only, not the official document. Physical pickup may still be required.'].join('\n');
  await cfg.transport.sendMail({ from: cfg.from, to: r.email, subject: `SchoolDocs completed - ${r.referenceNumber}`, text: plain,
    html: `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#18263d"><div style="background:#17365D;color:#fff;padding:22px;border-radius:12px 12px 0 0"><h2 style="margin:0">SchoolDocs</h2><p style="margin:6px 0 0">Request completion receipt</p></div><div style="padding:22px;border:1px solid #e5eaf3;border-top:0;border-radius:0 0 12px 12px"><p>Hello ${escapeHtml(r.studentName)}, your request is marked completed.</p><p style="background:#edf3f8;padding:12px;border-radius:8px"><b>Reference:</b> ${escapeHtml(r.referenceNumber)}</p><table cellpadding="8" style="width:100%;border-collapse:collapse"><tr><td>Document</td><td><b>${escapeHtml(r.documentType)}</b></td></tr><tr><td>Purpose</td><td>${escapeHtml(r.purpose)}</td></tr><tr><td>Copies</td><td>${r.copies}</td></tr><tr><td>School Year</td><td>${escapeHtml(r.schoolYear)}</td></tr><tr><td>LRN</td><td>${escapeHtml(maskedLRN)}</td></tr><tr><td>Submitted</td><td>${escapeHtml(submitted)}</td></tr><tr><td>Completed</td><td>${escapeHtml(completed)}</td></tr><tr><td>Status</td><td><b>Completed</b></td></tr></table><p style="font-size:13px;color:#526477;margin-top:18px">This email is a receipt only, not the official school document. If physical pickup is required, claim it at the registrar.</p></div></div>` });
}
async function attemptEmail(id) {
  const db = readDB(), r = db.requests.find(x => x.id === id);
  if (!r) throw new Error('Request not found.');
  if (r.status !== 'Completed') throw new Error('Only completed requests can be emailed.');
  if (r.emailSentAt) return { alreadySent: true };
  r.emailStatus = 'sending'; r.emailError = ''; writeDB(db);
  try {
    await sendCompletionEmail(r);
    const fresh = readDB(), item = fresh.requests.find(x => x.id === id);
    item.emailStatus = 'sent'; item.emailSentAt = new Date().toISOString(); item.emailError = ''; writeDB(fresh); return { sent: true };
  } catch (err) {
    const fresh = readDB(), item = fresh.requests.find(x => x.id === id);
    item.emailStatus = 'not_configured'; item.emailError = String(err.message || 'Email failed').slice(0, 300); writeDB(fresh); return { sent: false, error: item.emailError };
  }
}
app.patch('/api/requests/:id', auth, async (req, res) => {
  const status = String(req.body?.status || ''), note = String(req.body?.registrarNote || '').trim().slice(0,500);
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Select a valid status.' });
  const db = readDB(), r = db.requests.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  const previousStatus = r.status, changed = previousStatus !== status || (r.registrarNote || '') !== note, now = new Date().toISOString();
  r.status = status; r.registrarNote = note; r.updatedAt = now;
  if (status === 'Completed') r.completedAt = r.completedAt || now;
  else if (previousStatus !== 'Completed') r.completedAt = null;
  if (changed) r.history.push({ status, note: note || `Status updated to ${status}.`, at: now });
  writeDB(db);
  let emailResult = null;
  if (status === 'Completed' && previousStatus !== 'Completed' && !r.emailSentAt) emailResult = await attemptEmail(r.id);
  res.json({ request: readDB().requests.find(x => x.id === r.id), emailResult });
});
app.post('/api/requests/:id/retry-email', auth, async (req, res) => { const emailResult = await attemptEmail(req.params.id); res.json({ emailResult, request: readDB().requests.find(x => x.id === req.params.id) }); });
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Something went wrong. Please try again.' }); });
app.listen(PORT, '0.0.0.0', () => console.log(`SchoolDocs 4.0 running on port ${PORT}`));
