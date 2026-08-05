require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { createCanvas } = require('@napi-rs/canvas');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const FORCE_HTTPS = process.env.FORCE_HTTPS === 'true';
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'madhanadmin@gmail.com').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Demo@test';

// A permanent teacher account, recreated automatically every time the server boots —
// so it survives Render wiping its disk on redeploy/restart. Only created if both
// TEACHER_EMAIL and TEACHER_PASSWORD are set as env vars (never hardcode a real
// password in code — set it in Render's Environment tab, not here).
const TEACHER_EMAIL = (process.env.TEACHER_EMAIL || '').toLowerCase();
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || '';
const TEACHER_NAME = process.env.TEACHER_NAME || 'Staff';
const TEACHER_SUBJECT = process.env.TEACHER_SUBJECT || 'General';

// A permanent student account under that teacher, same idea — recreated on every boot.
const STUDENT_EMAIL = (process.env.STUDENT_EMAIL || '').toLowerCase();
const STUDENT_PASSWORD = process.env.STUDENT_PASSWORD || '';
const STUDENT_NAME = process.env.STUDENT_NAME || 'Student';
const STUDENT_ROLL = process.env.STUDENT_ROLL || '';
const STUDENT_LEVEL = process.env.STUDENT_LEVEL || '';

// ---- AI providers: configure as many keys AND as many providers as you have.
// On each grade request: for the current provider, every key is tried in order
// (rotates past a dead/rate-limited/invalid key to the next one); if every key for
// that provider fails, it moves to the next provider in PROVIDER_ORDER entirely.
// So a single bad key, a single deprecated model, or a whole provider being down
// all get automatically routed around.
function parseKeyList(multiVar, singleVar) {
  const raw = process.env[multiVar] || process.env[singleVar] || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}
const GEMINI_API_KEYS = parseKeyList('GEMINI_API_KEYS', 'GEMINI_API_KEY');
const OPENAI_API_KEYS = parseKeyList('OPENAI_API_KEYS', 'OPENAI_API_KEY');
const ANTHROPIC_API_KEYS = parseKeyList('ANTHROPIC_API_KEYS', 'ANTHROPIC_API_KEY');

// Comma-separated list, tried in order for Gemini specifically — protects against a
// single model name getting deprecated. Check what your key can use at:
// https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY
const GEMINI_MODELS = (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || 'gemini-2.0-flash')
  .split(',').map(s => s.trim()).filter(Boolean);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const PROVIDER_ORDER = (process.env.PROVIDER_ORDER || 'gemini,openai,anthropic')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Comma-separated list of allowed frontend origins, e.g.
// FRONTEND_URL=https://scangrade.netlify.app,http://localhost:5500
const allowedOrigins = (process.env.FRONTEND_URL || '*')
  .split(',').map(s => s.trim()).filter(Boolean);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors({
  origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  credentials: false
}));
app.use(express.json());

// Only relevant if you deploy somewhere that does NOT already terminate HTTPS for you
// (Render and Netlify both do this automatically — leave FORCE_HTTPS unset there).
if (FORCE_HTTPS) {
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
    res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
  });
}

db.load();

async function seedAdmin() {
  const existing = db.getUser(ADMIN_EMAIL);
  if (!existing) {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    db.saveUser({
      email: ADMIN_EMAIL, role: 'admin', name: 'Admin', passwordHash,
      createdAt: Date.now(), lastLogin: null, loginCount: 0, status: 'active'
    });
    console.log(`Seeded admin account: ${ADMIN_EMAIL}`);
  }
}
async function seedTeacher() {
  if (!TEACHER_EMAIL || !TEACHER_PASSWORD) return;
  const existing = db.getUser(TEACHER_EMAIL);
  if (!existing) {
    const passwordHash = await bcrypt.hash(TEACHER_PASSWORD, 10);
    db.saveUser({
      email: TEACHER_EMAIL, role: 'teacher', name: TEACHER_NAME, subject: TEACHER_SUBJECT,
      passwordHash, createdBy: 'system-seed', createdAt: Date.now(), status: 'active', loginCount: 0
    });
    db.addTeacherToRoster(TEACHER_EMAIL);
    console.log(`Seeded permanent teacher account: ${TEACHER_EMAIL}`);
  }
}
async function seedStudent() {
  if (!STUDENT_EMAIL || !STUDENT_PASSWORD || !TEACHER_EMAIL) return;
  const existing = db.getUser(STUDENT_EMAIL);
  if (!existing) {
    const passwordHash = await bcrypt.hash(STUDENT_PASSWORD, 10);
    db.saveUser({
      email: STUDENT_EMAIL, role: 'student', name: STUDENT_NAME, rollNo: STUDENT_ROLL, studyLevel: STUDENT_LEVEL,
      passwordHash, createdBy: 'system-seed', teacherEmail: TEACHER_EMAIL,
      createdAt: Date.now(), status: 'active', loginCount: 0
    });
    db.addStudentToRoster(TEACHER_EMAIL, STUDENT_EMAIL);
    console.log(`Seeded permanent student account: ${STUDENT_EMAIL}`);
  }
}
seedAdmin();
seedTeacher();
seedStudent();

// ---------- helpers ----------
function validPassword(pwd) { return typeof pwd === 'string' && pwd.length >= 8; }
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || ''); }
function signToken(user) {
  return jwt.sign({ email: user.email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '12h' });
}
function publicUser(u) {
  const { passwordHash, ...rest } = u;
  return rest;
}
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired, please sign in again.' });
  }
}
function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) return res.status(403).json({ error: 'Not allowed for this role.' });
    next();
  };
}

// ---- health check (useful for Render / uptime pings) ----
app.get('/api/health', (req, res) => res.json({ ok: true, provider: AI_PROVIDER }));

// ============ AUTH ============
app.post('/api/auth/login', async (req, res) => {
  const { email, password, role } = req.body || {};
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!cleanEmail || !password || !role) return res.status(400).json({ error: 'Missing email, password or role.' });

  const user = db.getUser(cleanEmail);
  if (!user || user.role !== role) {
    db.logSecurity({ event: `Failed login (${role})`, email: cleanEmail, status: 'fail' });
    return res.status(401).json({ error: 'Invalid credentials or wrong role selected.' });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    db.logSecurity({ event: `Failed login (${role})`, email: cleanEmail, status: 'fail' });
    return res.status(401).json({ error: 'Invalid credentials or wrong role selected.' });
  }
  if (user.status === 'disabled') return res.status(403).json({ error: 'This account has been disabled by an admin.' });

  user.lastLogin = Date.now();
  user.loginCount = (user.loginCount || 0) + 1;
  db.saveUser(user);
  db.logSecurity({ event: 'Login success', email: cleanEmail, role: user.role, status: 'ok' });

  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post('/api/auth/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = db.getUser(req.user.email);
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  const ok = await bcrypt.compare(currentPassword || '', user.passwordHash);
  if (!ok) return res.status(400).json({ error: 'Current password is incorrect.' });
  if (!validPassword(newPassword)) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  user.passwordHash = await bcrypt.hash(newPassword, 10);
  db.saveUser(user);
  db.logSecurity({ event: 'Password changed', email: user.email, status: 'ok' });
  res.json({ ok: true });
});

app.get('/api/auth/me', auth, (req, res) => {
  const user = db.getUser(req.user.email);
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  res.json({ user: publicUser(user) });
});

// ============ ADMIN ============
app.get('/api/admin/overview', auth, requireRole('admin'), (req, res) => {
  const teacherEmails = db.getTeacherRoster();
  let studentCount = 0;
  teacherEmails.forEach(te => { studentCount += db.getStudentRoster(te).length; });
  const log = db.getSecurityLog();
  const failedRecent = log.filter(l => l.status === 'fail' && Date.now() - l.time < 86400000).length;
  res.json({ teacherCount: teacherEmails.length, studentCount, failedRecent, recentLog: log.slice(0, 8) });
});

app.post('/api/admin/teachers', auth, requireRole('admin'), async (req, res) => {
  const { name, email, subject, password } = req.body || {};
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!name || !validEmail(cleanEmail) || !password) return res.status(400).json({ error: 'Fill all fields with a valid email.' });
  if (!validPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (db.getUser(cleanEmail)) return res.status(409).json({ error: 'An account with this email already exists.' });

  const passwordHash = await bcrypt.hash(password, 10);
  db.saveUser({
    email: cleanEmail, role: 'teacher', name, subject: subject || '',
    passwordHash, createdBy: req.user.email, createdAt: Date.now(), status: 'active', loginCount: 0
  });
  db.addTeacherToRoster(cleanEmail);
  db.logSecurity({ event: 'Teacher account created', email: req.user.email, status: 'ok' });
  res.json({ ok: true });
});

app.get('/api/admin/teachers', auth, requireRole('admin'), (req, res) => {
  const teacherEmails = db.getTeacherRoster();
  const teachers = teacherEmails.map(email => {
    const t = db.getUser(email);
    if (!t) return null;
    const students = db.getStudentRoster(email).map(se => db.getUser(se)).filter(Boolean).map(publicUser);
    return { ...publicUser(t), students };
  }).filter(Boolean);
  res.json({ teachers });
});

app.patch('/api/admin/teachers/:email/status', auth, requireRole('admin'), (req, res) => {
  const email = req.params.email.toLowerCase();
  const { status } = req.body || {};
  const user = db.getUser(email);
  if (!user || user.role !== 'teacher') return res.status(404).json({ error: 'Teacher not found.' });
  user.status = status === 'disabled' ? 'disabled' : 'active';
  db.saveUser(user);
  db.logSecurity({ event: `Teacher account ${user.status}`, email: req.user.email, status: 'ok' });
  res.json({ ok: true, status: user.status });
});

// Admin can reset the password of any teacher, or any student under any teacher —
// covers "they forgot their password" without ever storing/showing the real one.
app.patch('/api/admin/users/:email/reset-password', auth, requireRole('admin'), async (req, res) => {
  const email = req.params.email.toLowerCase();
  const { newPassword } = req.body || {};
  const user = db.getUser(email);
  if (!user || (user.role !== 'teacher' && user.role !== 'student')) return res.status(404).json({ error: 'Account not found.' });
  if (!validPassword(newPassword)) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  user.passwordHash = await bcrypt.hash(newPassword, 10);
  db.saveUser(user);
  db.logSecurity({ event: `Password reset for ${user.role} by admin`, email: req.user.email, status: 'ok' });
  res.json({ ok: true });
});

app.delete('/api/admin/teachers/:email', auth, requireRole('admin'), (req, res) => {
  const email = req.params.email.toLowerCase();
  const teacher = db.getUser(email);
  if (!teacher || teacher.role !== 'teacher') return res.status(404).json({ error: 'Teacher not found.' });

  const studentEmails = db.getStudentRoster(email);
  studentEmails.forEach(se => db.deleteUser(se));
  db.removeTeacherFromRoster(email);
  db.deleteUser(email);
  db.logSecurity({ event: `Teacher account deleted (with ${studentEmails.length} student(s))`, email: req.user.email, status: 'ok' });
  res.json({ ok: true });
});

app.get('/api/admin/security-log', auth, requireRole('admin'), (req, res) => {
  res.json({ log: db.getSecurityLog() });
});

// ============ TEACHER ============
app.post('/api/teacher/students', auth, requireRole('teacher'), async (req, res) => {
  const { name, email, rollNo, studyLevel, password } = req.body || {};
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!name || !validEmail(cleanEmail) || !password || !rollNo) return res.status(400).json({ error: 'Fill all fields with a valid email.' });
  if (!validPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (db.getUser(cleanEmail)) return res.status(409).json({ error: 'An account with this email already exists.' });

  const passwordHash = await bcrypt.hash(password, 10);
  db.saveUser({
    email: cleanEmail, role: 'student', name, rollNo, studyLevel: studyLevel || '',
    passwordHash, createdBy: req.user.email, teacherEmail: req.user.email,
    createdAt: Date.now(), status: 'active', loginCount: 0
  });
  db.addStudentToRoster(req.user.email, cleanEmail);
  db.logSecurity({ event: 'Student account created', email: req.user.email, status: 'ok' });
  res.json({ ok: true });
});

app.get('/api/teacher/students', auth, requireRole('teacher'), (req, res) => {
  const students = db.getStudentRoster(req.user.email).map(se => db.getUser(se)).filter(Boolean).map(publicUser);
  res.json({ students });
});

app.delete('/api/teacher/students/:email', auth, requireRole('teacher'), (req, res) => {
  const email = req.params.email.toLowerCase();
  const student = db.getUser(email);
  if (!student || student.role !== 'student' || student.teacherEmail !== req.user.email) {
    return res.status(404).json({ error: 'Student not found.' });
  }
  db.removeStudentFromRoster(req.user.email, email);
  db.deleteUser(email);
  db.logSecurity({ event: 'Student account deleted', email: req.user.email, status: 'ok' });
  res.json({ ok: true });
});

app.patch('/api/teacher/students/:email/reset-password', auth, requireRole('teacher'), async (req, res) => {
  const email = req.params.email.toLowerCase();
  const { newPassword } = req.body || {};
  const student = db.getUser(email);
  if (!student || student.role !== 'student' || student.teacherEmail !== req.user.email) {
    return res.status(404).json({ error: 'Student not found.' });
  }
  if (!validPassword(newPassword)) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  student.passwordHash = await bcrypt.hash(newPassword, 10);
  db.saveUser(student);
  db.logSecurity({ event: 'Password reset for student', email: req.user.email, status: 'ok' });
  res.json({ ok: true });
});

// ---- grading (server holds the API key — never sent to the browser) ----
function buildGradingPrompt(instructions, subject) {
  return `You are grading a student's handwritten (or typed) exam answer sheet. Files are attached in this order where present: question bank, answer key, then the student's answer sheet. The answer sheet may be written in Tamil or English — read and grade either.

Teacher's grading instructions: ${instructions || 'Use standard grading: correct method and correct final answer both count.'}

Subject: ${subject || 'Exam'}

Respond with ONLY valid JSON (no markdown fences, no commentary) in exactly this shape:
{"totalObtained":number,"totalMarks":number,"passed":boolean,"overallFeedback":"short summary string","questions":[{"qNo":"1","obtained":number,"outOf":number,"feedback":"short specific feedback"}]}`;
}

// Tries every model in GEMINI_MODELS in order — protects against one specific model
// name getting deprecated (which is exactly what broke grading before).
async function gradeWithGeminiKey(apiKey, fileList, promptText) {
  const parts = fileList.map(f => ({
    inlineData: { mimeType: f.mimetype || 'image/jpeg', data: f.buffer.toString('base64') }
  }));
  parts.push({ text: promptText });

  const errors = [];
  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const apiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json' } })
      });
      const data = await apiRes.json();
      if (!apiRes.ok) throw new Error(data.error?.message || `model ${model} returned an error.`);
      const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      if (!text) throw new Error(`no response from model ${model}.`);
      return text;
    } catch (e) {
      errors.push(`${model}: ${e.message}`);
    }
  }
  throw new Error(errors.join(' | '));
}
async function gradeWithGemini(fileList, promptText) {
  if (GEMINI_API_KEYS.length === 0) throw new Error('No Gemini API keys configured.');
  const errors = [];
  for (let i = 0; i < GEMINI_API_KEYS.length; i++) {
    try {
      return await gradeWithGeminiKey(GEMINI_API_KEYS[i], fileList, promptText);
    } catch (e) {
      errors.push(`key #${i + 1}: ${e.message}`);
    }
  }
  throw new Error('All Gemini keys failed — ' + errors.join(' || '));
}

// Renders PDF pages to PNG images (max 5 pages) so any provider that only accepts
// images — currently OpenAI's plain chat endpoint — can still read a PDF. Gemini and
// Claude get the original PDF bytes directly; this conversion is only used as a
// fallback path when a PDF needs to reach OpenAI.
const MAX_PDF_PAGES = 5;
async function pdfBufferToImageFiles(buffer, originalName) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buffer);
  const pdf = await pdfjsLib.getDocument({ data, disableFontFace: true }).promise;
  const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
  const images = [];
  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    images.push({ buffer: canvas.toBuffer('image/png'), mimetype: 'image/png', originalname: `${originalName}-p${i}.png` });
  }
  return images;
}

async function gradeWithOpenAIKey(apiKey, imageFiles, promptText) {
  const content = imageFiles.map(f => ({
    type: 'image_url',
    image_url: { url: `data:${f.mimetype || 'image/jpeg'};base64,${f.buffer.toString('base64')}` }
  }));
  content.push({ type: 'text', text: promptText });

  const apiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content }]
    })
  });
  const data = await apiRes.json();
  if (!apiRes.ok) throw new Error(data.error?.message || 'OpenAI returned an error.');
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('No response from OpenAI.');
  return text;
}
async function gradeWithOpenAI(fileList, promptText) {
  if (OPENAI_API_KEYS.length === 0) throw new Error('No OpenAI API keys configured.');

  let imageFiles = [];
  for (const f of fileList) {
    if (f.mimetype === 'application/pdf') {
      const rendered = await pdfBufferToImageFiles(f.buffer, f.originalname || 'document');
      imageFiles.push(...rendered);
    } else {
      imageFiles.push(f);
    }
  }

  const errors = [];
  for (let i = 0; i < OPENAI_API_KEYS.length; i++) {
    try {
      return await gradeWithOpenAIKey(OPENAI_API_KEYS[i], imageFiles, promptText);
    } catch (e) {
      errors.push(`key #${i + 1}: ${e.message}`);
    }
  }
  throw new Error('All OpenAI keys failed — ' + errors.join(' || '));
}

async function gradeWithAnthropicKey(apiKey, content) {
  const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 2000, messages: [{ role: 'user', content }] })
  });
  const data = await apiRes.json();
  if (!apiRes.ok) throw new Error(data.error?.message || 'Claude returned an error.');
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('No response from Claude.');
  return textBlock.text;
}
async function gradeWithAnthropic(fileList, promptText) {
  if (ANTHROPIC_API_KEYS.length === 0) throw new Error('No Anthropic API keys configured.');
  const content = fileList.map(f => {
    const isPdf = f.mimetype === 'application/pdf';
    const base64 = f.buffer.toString('base64');
    return isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image', source: { type: 'base64', media_type: f.mimetype || 'image/jpeg', data: base64 } };
  });
  content.push({ type: 'text', text: promptText });

  const errors = [];
  for (let i = 0; i < ANTHROPIC_API_KEYS.length; i++) {
    try {
      return await gradeWithAnthropicKey(ANTHROPIC_API_KEYS[i], content);
    } catch (e) {
      errors.push(`key #${i + 1}: ${e.message}`);
    }
  }
  throw new Error('All Anthropic keys failed — ' + errors.join(' || '));
}

const PROVIDERS = { gemini: gradeWithGemini, openai: gradeWithOpenAI, anthropic: gradeWithAnthropic };

// Tries each configured provider in PROVIDER_ORDER; on any failure (deprecated model,
// quota, bad key, outage) it moves to the next one instead of failing the whole request.
async function gradeExam(fileList, promptText) {
  const attempts = [];
  for (const name of PROVIDER_ORDER) {
    const fn = PROVIDERS[name];
    if (!fn) continue;
    try {
      const text = await fn(fileList, promptText);
      return { text, provider: name };
    } catch (e) {
      attempts.push(`${name} → ${e.message}`);
    }
  }
  throw new Error('All configured AI providers failed. ' + attempts.join(' | '));
}

app.post('/api/grade', auth, requireRole('teacher'),
  upload.fields([{ name: 'qb', maxCount: 1 }, { name: 'key', maxCount: 1 }, { name: 'sheet', maxCount: 1 }]),
  async (req, res) => {
    if (GEMINI_API_KEYS.length === 0 && OPENAI_API_KEYS.length === 0 && ANTHROPIC_API_KEYS.length === 0) {
      return res.status(500).json({ error: 'No AI provider configured. Set at least one of GEMINI_API_KEYS, OPENAI_API_KEYS, ANTHROPIC_API_KEYS.' });
    }
    const files = req.files || {};
    if (!files.sheet || !files.sheet[0]) return res.status(400).json({ error: 'Answer sheet is required.' });

    const { instructions, subject, rollNo } = req.body || {};
    const fileList = [];
    if (files.qb && files.qb[0]) fileList.push(files.qb[0]);
    if (files.key && files.key[0]) fileList.push(files.key[0]);
    fileList.push(files.sheet[0]);
    const promptText = buildGradingPrompt(instructions, subject);

    try {
      const { text: rawText, provider } = await gradeExam(fileList, promptText);
      const clean = rawText.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);

      if (rollNo) {
        db.addResult(rollNo, { ...parsed, subject: subject || 'Exam', gradedAt: Date.now(), gradedBy: req.user.email });
      }
      console.log(`Graded via ${provider}`);
      res.json({ result: parsed });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Could not grade this sheet. ' + e.message });
    }
  });

// ============ STUDENT ============
app.get('/api/student/results', auth, requireRole('student'), (req, res) => {
  const user = db.getUser(req.user.email);
  res.json({ results: db.getResults(user?.rollNo) });
});

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

app.listen(PORT, () => console.log(`ScanGrade API running on port ${PORT} (providers: ${PROVIDER_ORDER.join(', ')})`));
