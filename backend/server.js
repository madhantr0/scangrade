require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const FORCE_HTTPS = process.env.FORCE_HTTPS === 'true';
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'madhanadmin@gmail.com').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Demo@test';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const AI_PROVIDER = (process.env.AI_PROVIDER || (GEMINI_API_KEY ? 'gemini' : 'anthropic')).toLowerCase();

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
seedAdmin();

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

async function gradeWithGemini(fileList, promptText) {
  const parts = fileList.map(f => ({
    inlineData: { mimeType: f.mimetype || 'image/jpeg', data: f.buffer.toString('base64') }
  }));
  parts.push({ text: promptText });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const apiRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: 'application/json' }
    })
  });
  const data = await apiRes.json();
  if (!apiRes.ok) throw new Error(data.error?.message || 'Gemini returned an error.');
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text) throw new Error('No response from Gemini.');
  return text;
}

async function gradeWithAnthropic(fileList, promptText) {
  const content = fileList.map(f => {
    const isPdf = f.mimetype === 'application/pdf';
    const base64 = f.buffer.toString('base64');
    return isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image', source: { type: 'base64', media_type: f.mimetype || 'image/jpeg', data: base64 } };
  });
  content.push({ type: 'text', text: promptText });

  const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 2000, messages: [{ role: 'user', content }] })
  });
  const data = await apiRes.json();
  if (!apiRes.ok) throw new Error(data.error?.message || 'Claude returned an error.');
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('No response from Claude.');
  return textBlock.text;
}

app.post('/api/grade', auth, requireRole('teacher'),
  upload.fields([{ name: 'qb', maxCount: 1 }, { name: 'key', maxCount: 1 }, { name: 'sheet', maxCount: 1 }]),
  async (req, res) => {
    if (AI_PROVIDER === 'gemini' && !GEMINI_API_KEY) return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY. Set it in your environment variables.' });
    if (AI_PROVIDER === 'anthropic' && !ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY. Set it in your environment variables.' });

    const files = req.files || {};
    if (!files.sheet || !files.sheet[0]) return res.status(400).json({ error: 'Answer sheet is required.' });

    const { instructions, subject, rollNo } = req.body || {};
    const fileList = [];
    if (files.qb && files.qb[0]) fileList.push(files.qb[0]);
    if (files.key && files.key[0]) fileList.push(files.key[0]);
    fileList.push(files.sheet[0]);
    const promptText = buildGradingPrompt(instructions, subject);

    try {
      const rawText = AI_PROVIDER === 'gemini'
        ? await gradeWithGemini(fileList, promptText)
        : await gradeWithAnthropic(fileList, promptText);

      const clean = rawText.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);

      if (rollNo) {
        db.addResult(rollNo, { ...parsed, subject: subject || 'Exam', gradedAt: Date.now(), gradedBy: req.user.email });
      }
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

app.listen(PORT, () => console.log(`ScanGrade API running on port ${PORT} (provider: ${AI_PROVIDER})`));
