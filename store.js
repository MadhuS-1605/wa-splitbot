const fs = require('fs');
const path = require('path');

// On Railway (or any host with ephemeral local disk), set DATA_DIR to a
// mounted persistent Volume path, e.g. DATA_DIR=/data/expenses — otherwise
// every redeploy/restart wipes your ledger. Defaults to a local folder for
// running on your own machine or a droplet with a normal filesystem.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function filePathFor(groupId) {
  // groupId looks like "1203xxxxxxxx@g.us" — sanitize for filesystem
  const safe = groupId.replace(/[^a-zA-Z0-9]/g, '_');
  return path.join(DATA_DIR, `${safe}.json`);
}

// Strips WhatsApp's markdown control chars (*bold* _italic_ ~strike~ `mono`)
// from user-controlled text (expense descriptions, profile display names)
// before it's ever interpolated into a formatted reply. An unbalanced
// char in one field otherwise breaks bold/italic rendering for the rest
// of that message.
function sanitizeText(s) {
  return String(s).replace(/[*_~`]/g, '').trim();
}

function loadGroup(groupId) {
  const fp = filePathFor(groupId);
  if (!fs.existsSync(fp)) {
    return { groupId, members: {}, expenses: [] };
  }
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  if (!data.groupId) data.groupId = groupId; // backfill for files saved before this field existed
  return data;
}

function saveGroup(groupId, data) {
  const fp = filePathFor(groupId);
  // atomic-ish write: write to temp then rename
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, fp);
}

// Reads every group's ledger off disk. Used by the digest scheduler, which
// needs to sweep all groups rather than one at a time.
function listGroups() {
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter((data) => data && data.groupId);
}

function upsertMember(groupId, jid, name) {
  const data = loadGroup(groupId);
  const clean = sanitizeText(name);
  if (clean && data.members[jid] !== clean) {
    data.members[jid] = clean;
    saveGroup(groupId, data);
  }
}

// --- Per-group lock ---
// Two commands (e.g. two !expense messages) can arrive close enough together
// that their async handlers interleave. Without this, both could load the
// same ledger state, apply their change, and save — with the second save
// silently clobbering the first. This serializes all read-modify-write
// operations per group so they always run one at a time, in order.
const locks = new Map();

async function withGroupLock(groupId, fn) {
  const previous = locks.get(groupId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  locks.set(groupId, previous.then(() => current));

  await previous;
  try {
    return await fn();
  } finally {
    release();
    // clean up if nothing else is queued behind us
    if (locks.get(groupId) === current) locks.delete(groupId);
  }
}

module.exports = { loadGroup, saveGroup, upsertMember, withGroupLock, sanitizeText, listGroups };
