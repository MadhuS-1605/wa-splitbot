const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const http = require('http');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { upsertMember, loadGroup, listGroups } = require('./store');
const {
  parseExpenseCommand,
  parseItemizedCommand,
  addExpense,
  recordPayment,
  repeatLastExpense,
  editLastExpense,
  undoLastExpense,
  resetGroup,
  computeBalances,
  simplifyDebts,
  setDigest,
  markDigestSent,
} = require('./expense');

// On Railway (or any ephemeral host), set AUTH_DIR to a mounted persistent
// Volume path, e.g. AUTH_DIR=/data/auth_info — otherwise every redeploy
// wipes your linked-device session and you'll have to re-scan the QR.
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_info');

// --- QR delivery over HTTP ---
// Locally you'll see the QR printed straight to the terminal. On a host
// like Railway there's no interactive terminal, and ASCII QR codes often
// render broken in web log viewers — so we also serve it as a scannable
// image at /qr. Railway assigns PORT automatically; default to 3000 for
// local use.
const PORT = process.env.PORT || 3000;
let lastQrDataUrl = null;

http
  .createServer(async (req, res) => {
    if (req.url === '/qr') {
      if (!lastQrDataUrl) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="font-family:sans-serif;text-align:center;margin-top:4rem"><h2>No QR pending — bot is either already connected, or still starting up. Refresh in a few seconds.</h2></body></html>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<html><body style="font-family:sans-serif;text-align:center;margin-top:2rem">
           <h2>Scan with WhatsApp → Linked Devices → Link a Device</h2>
           <img src="${lastQrDataUrl}" style="width:300px;height:300px" />
         </body></html>`
      );
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('wa-splitbot is running. Visit /qr to link a WhatsApp session.');
    }
  })
  .listen(PORT, () => console.log(`HTTP server listening on port ${PORT} (visit /qr to scan)`));

// --- Outgoing message pacing ---
// WhatsApp can flag numbers that send messages in rapid bursts as automated/
// spammy. Everything we send goes through this single-file queue with a
// small randomized delay between sends, so the bot never fires off a burst
// even if several commands land at once.
//
// IMPORTANT: each send is isolated with its own try/catch inside the chain.
// Without this, a single failed sendMessage() call permanently rejects the
// shared `sendQueue` promise — every future queuedSend() call would then
// silently fail forever (since .then() on an already-rejected promise just
// propagates the rejection), even though nothing looks wrong in the logs.
let sendQueue = Promise.resolve();
function queuedSend(sock, jid, content, opts) {
  const result = sendQueue.then(async () => {
    try {
      await sock.sendMessage(jid, content, opts);
    } catch (err) {
      console.error('Failed to send message:', err.message);
    }
    const delay = 1200 + Math.random() * 800; // 1.2-2.0s between messages
    await new Promise((resolve) => setTimeout(resolve, delay));
  });
  sendQueue = result; // safe to chain further — result never rejects
  return result;
}

// --- Reconnect backoff ---
// Reconnecting instantly (and repeatedly, if the network is flaky) looks
// like automated hammering to WhatsApp. Back off exponentially instead.
let reconnectAttempts = 0;
let digestInterval = null;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('Scan this QR code with WhatsApp -> Linked Devices -> Link a Device:');
      qrcodeTerminal.generate(qr, { small: true });
      try {
        lastQrDataUrl = await QRCode.toDataURL(qr);
        console.log(`Or open http://localhost:${PORT}/qr (or your Railway URL + /qr) in a browser.`);
      } catch (err) {
        console.error('Failed to generate QR image:', err.message);
      }
    }
    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        const delay = Math.min(30000, 1000 * 2 ** reconnectAttempts);
        reconnectAttempts++;
        console.log(`Connection closed, reconnecting in ${delay}ms...`);
        setTimeout(startBot, delay);
      } else {
        console.log(`Logged out - delete ${AUTH_DIR} and re-scan the QR to reconnect.`);
      }
    } else if (connection === 'open') {
      reconnectAttempts = 0;
      lastQrDataUrl = null; // clear stale QR now that we're connected
      console.log('✅ Connected to WhatsApp');
      // Reconnects create a new `sock`; clear any interval still bound to
      // the old (now-dead) socket before starting one against the new one —
      // otherwise digests silently stop working after the first reconnect.
      if (digestInterval) clearInterval(digestInterval);
      digestInterval = setInterval(() => checkDigests(sock).catch((err) => console.error('Digest check failed:', err.message)), 60 * 60 * 1000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    // IMPORTANT: don't just read messages[0]. Messages you send yourself
    // (from the same number the bot is linked to) can arrive bundled
    // together with other sync events in a single batch — your actual
    // command might not be first in the array. Messages from other people
    // normally arrive one at a time, so this bug is easy to miss until you
    // test from the linked account itself.
    for (const msg of messages) {
      await handleIncomingMessage(sock, msg);
    }
  });
}

async function handleIncomingMessage(sock, msg) {
  if (!msg.message) return;

  const groupId = msg.key.remoteJid;
  if (!groupId || !groupId.endsWith('@g.us')) return; // only handle groups

  // For messages you send yourself (fromMe: true), WhatsApp's multi-device
  // sync sometimes omits `participant` on the group message key (it's
  // normally only needed to identify *other* people's messages). Fall back
  // to the bot's own JID in that case rather than accidentally treating
  // the group ID itself as the sender.
  // Normalize: multi-device participant JIDs can carry a ":device" suffix
  // (e.g. "123@s.whatsapp.net" vs "123:15@s.whatsapp.net"). Without
  // normalizing, the same person can fragment into multiple ledger
  // identities depending on which of their devices sent the message,
  // silently corrupting balances.
  const senderJid = jidNormalizedUser(
    msg.key.participant || (msg.key.fromMe ? sock.user.id : msg.key.remoteJid)
  );

  // Remember display names for anyone who posts in the group, not just
  // people issuing bot commands — otherwise a member who's only ever
  // mentioned/split into an expense (never themselves messaging the bot)
  // never gets a name recorded and shows up as a raw number in /balance.
  if (msg.pushName) upsertMember(groupId, senderJid, msg.pushName);

  const text =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    '';
  if (!text.startsWith('/')) return;

  console.log(`Command received: "${text}" | groupId=${groupId} | senderJid=${senderJid} | fromMe=${msg.key.fromMe}`);

  const mentionedJids =
    msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];

  try {
    await handleCommand({ sock, groupId, senderJid, text, mentionedJids, msg });
  } catch (err) {
    await queuedSend(sock, groupId, { text: `⚠️ ${err.message}` }, { quoted: msg });
  }
}

// Resolve @all to the group's actual member JIDs (minus the bot itself).
async function resolveAllJids(sock, groupId) {
  const metadata = await sock.groupMetadata(groupId);
  const botJid = jidNormalizedUser(sock.user.id);
  return metadata.participants
    .map((p) => jidNormalizedUser(p.id))
    .filter((jid) => jid !== botJid);
}

async function isGroupAdmin(sock, groupId, jid) {
  const metadata = await sock.groupMetadata(groupId);
  const participant = metadata.participants.find((p) => jidNormalizedUser(p.id) === jid);
  return participant?.admin === 'admin' || participant?.admin === 'superadmin';
}

// Show the raw phone number as a WhatsApp @mention rather than a name we
// tracked ourselves — WhatsApp resolves an @mention to whatever name each
// recipient has that number saved as on their own device, which is more
// reliable than the bot guessing a name from pushName.
function mention(jid) {
  return `@${jid.split('@')[0]}`;
}

function formatBalanceLines(net) {
  return Object.entries(net)
    .filter(([, v]) => Math.abs(v) > 0.01)
    .sort((a, b) => b[1] - a[1])
    .map(([jid, amt]) =>
      amt > 0
        ? `  • ${mention(jid)} is owed *₹${amt.toFixed(2)}*`
        : `  • ${mention(jid)} owes *₹${Math.abs(amt).toFixed(2)}*`
    );
}

// --- Weekly/monthly balance digest ---
// Checked hourly; each group opts in via /digest weekly|monthly. dateKey
// identifies the current period so a group is never messaged twice for the
// same week/month even though the check runs many times within it.
function digestDateKey(mode, now) {
  if (mode === 'monthly') return `${now.getFullYear()}-${now.getMonth()}`;
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

async function checkDigests(sock) {
  const now = new Date();
  const isMonday9am = now.getDay() === 1 && now.getHours() === 9;
  const isFirstOfMonth9am = now.getDate() === 1 && now.getHours() === 9;
  if (!isMonday9am && !isFirstOfMonth9am) return;

  for (const group of listGroups()) {
    if (group.digest === 'weekly' && !isMonday9am) continue;
    if (group.digest === 'monthly' && !isFirstOfMonth9am) continue;
    if (group.digest !== 'weekly' && group.digest !== 'monthly') continue;

    const dateKey = digestDateKey(group.digest, now);
    if (group.lastDigestSent === dateKey) continue;

    const { net } = computeBalances(group.groupId);
    const lines = formatBalanceLines(net);
    const text = lines.length === 0
      ? `📅 *${group.digest} digest:* Everyone is settled up! 🎉`
      : `📅 *${group.digest} digest — current balances:*\n${lines.join('\n')}`;
    await queuedSend(sock, group.groupId, { text, mentions: Object.keys(net) });
    await markDigestSent(group.groupId, dateKey);
  }
}

// WhatsApp's ``` monospace block keeps every line aligned in a fixed-width
// font, which reads far more clearly as a command reference than plain
// bold/italic text.
const HELP_TEXT =
  `*📋 Splitbot commands*\n` +
  '```\n' +
  `/expense 600 dinner @a @b       split equally (you + tagged)\n` +
  `/expense 600 dinner @all        split across everyone\n` +
  `/expense 600 dinner @a=300 @b=300  custom split\n` +
  `/expense repeat                 re-add last expense\n` +
  `/items <desc>                   itemized bill (multi-line)\n` +
  `/edit 700 [desc]                update last expense\n` +
  `/balance [@person]              who owes / is owed\n` +
  `/settle                         who pays whom\n` +
  `/paid @person [amount]          mark a debt as paid\n` +
  `/settled                        list of paid/settled payments\n` +
  `/nudge                          ping everyone who owes\n` +
  `/digest weekly|monthly|off      scheduled balance posts\n` +
  `/history                        last 10 expenses\n` +
  `/export                         download ledger as JSON\n` +
  `/undo confirm                   remove last expense\n` +
  `/reset confirm                  clear ledger (admins only)\n` +
  '```';

async function handleCommand({ sock, groupId, senderJid, text, mentionedJids, msg }) {
  const command = text.trim().split(/\s+/)[0].toLowerCase();

  if (command === '/expense') {
    const secondToken = text.trim().split(/\s+/)[1]?.toLowerCase();
    if (secondToken === 'repeat') {
      const repeated = await repeatLastExpense(groupId, senderJid);
      if (!repeated) {
        await queuedSend(sock, groupId, { text: 'No previous expense to repeat.' });
        return;
      }
      const lines = repeated.shares.map((s) => `  • ${mention(s.jid)}: *₹${s.amount.toFixed(2)}*`);
      await queuedSend(sock, groupId, {
        text: `✅ Repeated: *${repeated.description}* — *₹${repeated.amount.toFixed(2)}*\nPaid by ${mention(senderJid)}\nSplit:\n${lines.join('\n')}`,
        mentions: [senderJid, ...repeated.shares.map((s) => s.jid)],
      });
      return;
    }

    const usesAll = /@all\b/i.test(text);
    const allGroupJids = usesAll ? await resolveAllJids(sock, groupId) : [];

    const { amount, description, shares } = parseExpenseCommand(
      text,
      mentionedJids,
      senderJid,
      allGroupJids
    );
    await addExpense(groupId, senderJid, amount, description, shares);

    const lines = shares.map(
      (s) => `  • ${mention(s.jid)}: *₹${s.amount.toFixed(2)}*`
    );
    const splitLabel = usesAll ? ' (everyone)' : '';
    await queuedSend(sock, groupId, {
      text: `✅ Added: *${description}* — *₹${amount.toFixed(2)}*\nPaid by ${mention(senderJid)}\nSplit${splitLabel}:\n${lines.join('\n')}`,
      mentions: [senderJid, ...shares.map((s) => s.jid)],
    });
  } else if (command === '/items') {
    const { amount, description, shares } = parseItemizedCommand(text, mentionedJids, senderJid);
    await addExpense(groupId, senderJid, amount, description, shares);

    const lines = shares.map((s) => `  • ${mention(s.jid)}: *₹${s.amount.toFixed(2)}*`);
    await queuedSend(sock, groupId, {
      text: `✅ Added itemized: *${description}* — *₹${amount.toFixed(2)}*\nPaid by ${mention(senderJid)}\nSplit:\n${lines.join('\n')}`,
      mentions: [senderJid, ...shares.map((s) => s.jid)],
    });
  } else if (command === '/nudge') {
    const { net } = computeBalances(groupId);
    const debtors = Object.entries(net).filter(([, v]) => v < -0.01);
    if (debtors.length === 0) {
      await queuedSend(sock, groupId, { text: '✅ No one owes anything right now.' });
      return;
    }
    const lines = debtors.map(([jid, amt]) => `  • ${mention(jid)} owes *₹${Math.abs(amt).toFixed(2)}*`);
    await queuedSend(sock, groupId, {
      text: `🔔 *Reminder — please settle up:*\n${lines.join('\n')}`,
      mentions: debtors.map(([jid]) => jid),
    });
  } else if (command === '/digest') {
    const mode = text.trim().split(/\s+/)[1]?.toLowerCase();
    if (mode !== 'weekly' && mode !== 'monthly' && mode !== 'off') {
      throw new Error('Usage: /digest weekly | /digest monthly | /digest off');
    }
    await setDigest(groupId, mode === 'off' ? null : mode);
    await queuedSend(sock, groupId, {
      text: mode === 'off'
        ? '🔕 Digest turned off.'
        : `🔔 ${mode[0].toUpperCase()}${mode.slice(1)} digest enabled — I'll post balances automatically (Mondays 9am for weekly, the 1st of the month 9am for monthly).`,
    });
  } else if (command === '/balance') {
    const { net } = computeBalances(groupId);
    let entries = Object.entries(net).filter(([, v]) => Math.abs(v) > 0.01);
    if (mentionedJids.length > 0) {
      entries = entries.filter(([jid]) => jid === mentionedJids[0]);
      if (entries.length === 0) {
        await queuedSend(sock, groupId, { text: `📊 ${mention(mentionedJids[0])} is settled up! 🎉`, mentions: [mentionedJids[0]] });
        return;
      }
    } else if (entries.length === 0) {
      await queuedSend(sock, groupId, { text: '📊 Everyone is settled up! 🎉' });
      return;
    }
    const lines = entries
      .sort((a, b) => b[1] - a[1])
      .map(([jid, amt]) =>
        amt > 0
          ? `  • ${mention(jid)} is owed *₹${amt.toFixed(2)}*`
          : `  • ${mention(jid)} owes *₹${Math.abs(amt).toFixed(2)}*`
      );
    await queuedSend(sock, groupId, {
      text: `📊 *Current balances:*\n${lines.join('\n')}`,
      mentions: entries.map(([jid]) => jid),
    });
  } else if (command === '/settle') {
    const { net } = computeBalances(groupId);
    const jids = Object.keys(net);
    if (jids.length === 0) {
      await queuedSend(sock, groupId, { text: 'No expenses logged yet.' });
      return;
    }
    const transactions = simplifyDebts(net);
    const owesByPayer = new Map();
    for (const t of transactions) {
      if (!owesByPayer.has(t.from)) owesByPayer.set(t.from, []);
      owesByPayer.get(t.from).push(t);
    }
    const blocks = jids
      .sort()
      .map((jid) => {
        const debts = owesByPayer.get(jid);
        if (!debts) return `*${mention(jid)}* has nothing to pay.`;
        const lines = debts.map((t, i) => `  ${i + 1}. Pay ${mention(t.to)} — *₹${t.amount.toFixed(2)}*`);
        return `*${mention(jid)}* needs to pay:\n${lines.join('\n')}`;
      });
    await queuedSend(sock, groupId, {
      text: `🧾 *Settle up:*\n\n${blocks.join('\n\n')}\n\nAlready paid? Run /paid @person to mark it settled.`,
      mentions: [...jids, ...transactions.map((t) => t.to)],
    });
  } else if (command === '/paid') {
    if (mentionedJids.length === 0) {
      throw new Error('Usage: /paid @person [amount] — marks that you paid them, defaults to what /settle says you owe them.');
    }
    const toJid = mentionedJids[0];
    const customAmount = parseFloat(text.trim().split(/\s+/)[2]);
    const { net } = computeBalances(groupId);
    const owed = simplifyDebts(net).find((t) => t.from === senderJid && t.to === toJid);
    const amount = customAmount > 0 ? Math.round(customAmount * 100) / 100 : owed?.amount;
    if (!amount) {
      await queuedSend(sock, groupId, {
        text: `${mention(senderJid)} doesn't owe ${mention(toJid)} anything right now.`,
        mentions: [senderJid, toJid],
      });
      return;
    }
    await recordPayment(groupId, senderJid, toJid, amount);
    await queuedSend(sock, groupId, {
      text: `✅ Marked *₹${amount.toFixed(2)}* paid: ${mention(senderJid)} → ${mention(toJid)}`,
      mentions: [senderJid, toJid],
    });
  } else if (command === '/settled') {
    const data = loadGroup(groupId);
    const payments = data.payments || [];
    if (payments.length === 0) {
      await queuedSend(sock, groupId, { text: 'No payments marked as settled yet.' });
      return;
    }
    const lines = payments.map(
      (p) => `  • ${mention(p.from)} → ${mention(p.to)}: *₹${p.amount.toFixed(2)}*`
    );
    await queuedSend(sock, groupId, {
      text: `✅ *Settled payments:*\n${lines.join('\n')}`,
      mentions: [...new Set(payments.flatMap((p) => [p.from, p.to]))],
    });
  } else if (command === '/reset') {
    if (!(await isGroupAdmin(sock, groupId, senderJid))) {
      await queuedSend(sock, groupId, { text: '⛔ Only group admins can reset the ledger.' });
      return;
    }
    if (text.trim().split(/\s+/)[1]?.toLowerCase() !== 'confirm') {
      await queuedSend(sock, groupId, {
        text: '⚠️ This clears the entire ledger for everyone. Send */reset confirm* if you\'re sure.',
      });
      return;
    }
    await resetGroup(groupId);
    await queuedSend(sock, groupId, { text: '🔄 Ledger cleared. Starting fresh!' });
  } else if (command === '/undo') {
    const data = loadGroup(groupId);
    const last = data.expenses[data.expenses.length - 1];
    if (!last) {
      await queuedSend(sock, groupId, { text: 'Nothing to undo.' });
      return;
    }
    if (text.trim().split(/\s+/)[1]?.toLowerCase() !== 'confirm') {
      await queuedSend(sock, groupId, {
        text: `⚠️ This will remove: *${last.description}* — *₹${last.amount.toFixed(2)}*\nSend */undo confirm* if you're sure.`,
      });
      return;
    }
    const removed = await undoLastExpense(groupId);
    await queuedSend(sock, groupId, {
      text: `↩️ Removed: *${removed.description}* — *₹${removed.amount.toFixed(2)}*`,
    });
  } else if (command === '/edit') {
    const parts = text.trim().split(/\s+/);
    const amount = parseFloat(parts[1]);
    if (isNaN(amount) || amount <= 0) {
      throw new Error('Invalid amount. Usage: /edit 700 [new description]');
    }
    const description = parts.slice(2).join(' ') || undefined;
    const updated = await editLastExpense(groupId, amount, description);
    if (!updated) {
      await queuedSend(sock, groupId, { text: 'Nothing to edit.' });
    } else {
      await queuedSend(sock, groupId, {
        text: `✏️ Updated: *${updated.description}* — *₹${updated.amount.toFixed(2)}*`,
      });
    }
  } else if (command === '/export') {
    const data = loadGroup(groupId);
    await queuedSend(sock, groupId, {
      document: Buffer.from(JSON.stringify(data, null, 2)),
      fileName: `splitbot-export-${new Date().toISOString().slice(0, 10)}.json`,
      mimetype: 'application/json',
    });
  } else if (command === '/history') {
    const data = loadGroup(groupId);
    const recent = data.expenses.slice(-10).reverse();
    if (recent.length === 0) {
      await queuedSend(sock, groupId, { text: 'No expenses logged yet.' });
      return;
    }
    const lines = recent.map((e) => {
      const date = new Date(e.timestamp).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      return `  • ${e.description} — *₹${e.amount.toFixed(2)}* (paid by ${mention(e.payer)}, ${date})`;
    });
    await queuedSend(sock, groupId, {
      text: `🧾 *Last ${recent.length} expenses:*\n${lines.join('\n')}`,
      mentions: recent.map((e) => e.payer),
    });
  } else if (command === '/' || command === '/help') {
    // Bare "/" (or /help) shows the full command menu. WhatsApp has no
    // native slash-command autocomplete like Discord/Slack, so this is
    // the bot's own stand-in for "suggest available commands."
    await queuedSend(sock, groupId, { text: HELP_TEXT });
  } else if (command.startsWith('/')) {
    // Unrecognized slash command — nudge toward the menu instead of
    // silently doing nothing.
    await queuedSend(sock, groupId, {
      text: `🤔 Unknown command *${command}*. Send just */* to see everything I understand.`,
    });
  }
}

startBot();