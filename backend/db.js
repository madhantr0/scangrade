// Minimal file-backed database. No native modules, nothing to compile —
// works on any Node host (Render, Railway, Fly, a VPS, your own laptop).
//
// IMPORTANT: on most free hosting tiers the filesystem is EPHEMERAL —
// it can be wiped on redeploy or when the service restarts after being idle.
// This is fine for demos/hackathons. For real production use, swap this
// module for a proper database (Postgres/Supabase) — the function
// signatures below are the only thing the rest of the server touches,
// so that swap does not require touching server.js.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

function emptyDB() {
  return {
    users: {},              // email -> user object
    rosterTeachers: [],      // [email]
    rosterStudents: {},      // teacherEmail -> [studentEmail]
    securityLog: [],         // [{time,event,email,role,status}]
    results: {}               // ROLLNO -> [result]
  };
}

let DB = emptyDB();

function load() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
      DB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } else {
      save();
    }
  } catch (e) {
    console.error('Failed to load database, starting fresh:', e.message);
    DB = emptyDB();
  }
}

let saveTimer = null;
function save() {
  // Debounce writes slightly so rapid consecutive changes don't thrash disk.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(DB, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  }, 50);
}

function saveSync() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(DB, null, 2));
}

// ---- users ----
function getUser(email) {
  return DB.users[email.toLowerCase()] || null;
}
function saveUser(user) {
  DB.users[user.email.toLowerCase()] = user;
  save();
}

// ---- rosters ----
function getTeacherRoster() {
  return DB.rosterTeachers;
}
function addTeacherToRoster(email) {
  if (!DB.rosterTeachers.includes(email)) DB.rosterTeachers.push(email);
  save();
}
function getStudentRoster(teacherEmail) {
  return DB.rosterStudents[teacherEmail] || [];
}
function addStudentToRoster(teacherEmail, studentEmail) {
  if (!DB.rosterStudents[teacherEmail]) DB.rosterStudents[teacherEmail] = [];
  if (!DB.rosterStudents[teacherEmail].includes(studentEmail)) {
    DB.rosterStudents[teacherEmail].push(studentEmail);
  }
  save();
}

// ---- security log ----
function logSecurity(entry) {
  DB.securityLog.unshift({ time: Date.now(), ...entry });
  if (DB.securityLog.length > 500) DB.securityLog.length = 500;
  save();
}
function getSecurityLog() {
  return DB.securityLog;
}

// ---- results ----
function addResult(rollNo, result) {
  const key = rollNo.toUpperCase();
  if (!DB.results[key]) DB.results[key] = [];
  DB.results[key].unshift(result);
  save();
}
function getResults(rollNo) {
  return DB.results[(rollNo || '').toUpperCase()] || [];
}

module.exports = {
  load, save, saveSync,
  getUser, saveUser,
  getTeacherRoster, addTeacherToRoster,
  getStudentRoster, addStudentToRoster,
  logSecurity, getSecurityLog,
  addResult, getResults
};
