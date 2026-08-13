const { loadGroup, saveGroup, withGroupLock, sanitizeText } = require('./store');

function shortName(data, jid) {
  if (data.members[jid]) return data.members[jid];
  // fallback: show last 4 digits of the number
  const num = jid.split('@')[0];
  return num.slice(-4);
}

/**
 * Parse a command like:
 *   /expense 600 dinner @918123456789 @919000000000
 *   /expense 600 dinner @918123456789=300 @919000000000=300
 *   /expense 600 dinner @all
 *
 * `text` is the raw message text (with @numbers/@all visible).
 * `mentionedJids` is the ordered array Baileys gives us from contextInfo
 *   (empty/ignored when the command uses @all).
 * `senderJid` is who sent the message (always included as payer,
 *   and included as a participant unless explicitly excluded).
 * `allGroupJids` is the full group member list, only needed/used when the
 *   command contains "@all" — pass it in already resolved by the caller.
 */
function parseExpenseCommand(text, mentionedJids, senderJid, allGroupJids = []) {
  const parts = text.trim().split(/\s+/);
  // parts[0] = "/expense"
  const amount = parseFloat(parts[1]);
  if (isNaN(amount) || amount <= 0) {
    throw new Error('Invalid amount. Usage: /expense 600 dinner @person1 @person2');
  }

  // description = everything between amount and the first @mention/@all token
  const mentionStartIdx = parts.findIndex((p, i) => i >= 2 && p.startsWith('@'));
  const descEnd = mentionStartIdx === -1 ? parts.length : mentionStartIdx;
  const description = sanitizeText(parts.slice(2, descEnd).join(' ')) || 'expense';

  const usesAll = parts.slice(descEnd).some((p) => p.toLowerCase().startsWith('@all'));

  if (usesAll) {
    if (allGroupJids.length === 0) {
      throw new Error("Couldn't resolve the group's member list for @all — try again in a moment.");
    }
    const hasCustomWithAll = parts.slice(descEnd).some((p) => p.includes('='));
    if (hasCustomWithAll) {
      throw new Error("Custom amounts aren't supported with @all — tag individuals instead, e.g. @person1=300 @person2=300");
    }
    const participants = [...new Set([senderJid, ...allGroupJids])];
    const per = Math.round((amount / participants.length) * 100) / 100;
    const remainder = Math.round((amount - per * participants.length) * 100) / 100;
    const shares = participants.map((jid) => ({
      jid,
      amount: jid === senderJid ? per + remainder : per,
    }));
    return { amount, description, shares };
  }

  if (mentionedJids.length === 0) {
    throw new Error('Tag at least one person to split with, e.g. /expense 600 dinner @person1 @person2, or use @all');
  }

  // Check for custom amounts like @918123456789=300 in the raw text
  const customAmounts = {};
  let hasCustom = false;
  const mentionTokens = parts.slice(descEnd).filter((p) => p.startsWith('@'));
  mentionTokens.forEach((token, i) => {
    const eqIdx = token.indexOf('=');
    if (eqIdx !== -1) {
      hasCustom = true;
      const amt = parseFloat(token.slice(eqIdx + 1));
      if (mentionedJids[i]) customAmounts[mentionedJids[i]] = amt;
    }
  });

  // Participants = payer + everyone mentioned (dedup)
  const participantSet = new Set([senderJid, ...mentionedJids]);
  const participants = [...participantSet];

  let shares;
  if (hasCustom) {
    const total = Object.values(customAmounts).reduce((a, b) => a + b, 0);
    // if payer wasn't given a custom amount, they get the remainder (could be 0)
    if (customAmounts[senderJid] === undefined) {
      customAmounts[senderJid] = Math.round((amount - total) * 100) / 100;
    }
    const sum = Object.values(customAmounts).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - amount) > 0.01) {
      throw new Error(`Custom splits (${sum}) don't add up to the total (${amount}).`);
    }
    shares = participants.map((jid) => ({ jid, amount: customAmounts[jid] || 0 }));
  } else {
    const per = Math.round((amount / participants.length) * 100) / 100;
    // give any rounding remainder to the payer
    const remainder = Math.round((amount - per * participants.length) * 100) / 100;
    shares = participants.map((jid) => ({
      jid,
      amount: jid === senderJid ? per + remainder : per,
    }));
  }

  return { amount, description, shares };
}

/**
 * Parse a multi-line itemized bill:
 *   /items groceries
 *   pizza 300 @a @b
 *   snacks 150 @a @c
 *
 * First line is "/items <description>". Each following line is
 * "<item name> <amount> @person @person...". The payer is always added to
 * each item's participants automatically (same convention as /expense).
 * mentionedJids is matched positionally against @ tokens in line order,
 * same assumption /expense already relies on for custom splits.
 */
function parseItemizedCommand(text, mentionedJids, senderJid) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const description = sanitizeText(lines[0].split(/\s+/).slice(1).join(' ')) || 'itemized bill';

  const shareTotals = {};
  let total = 0;
  let mentionCursor = 0;

  for (const line of lines.slice(1)) {
    const tokens = line.split(/\s+/);
    const itemAmount = parseFloat(tokens[1]);
    if (!tokens[0] || isNaN(itemAmount) || itemAmount <= 0) {
      throw new Error(`Invalid item line: "${line}". Format: <item> <amount> @person @person`);
    }
    const mentionCount = tokens.slice(2).filter((t) => t.startsWith('@')).length;
    const participants = [...new Set([senderJid, ...mentionedJids.slice(mentionCursor, mentionCursor + mentionCount)])];
    mentionCursor += mentionCount;

    const per = Math.round((itemAmount / participants.length) * 100) / 100;
    const remainder = Math.round((itemAmount - per * participants.length) * 100) / 100;
    participants.forEach((jid, i) => {
      const amt = i === 0 ? per + remainder : per;
      shareTotals[jid] = Math.round(((shareTotals[jid] || 0) + amt) * 100) / 100;
    });
    total = Math.round((total + itemAmount) * 100) / 100;
  }

  if (Object.keys(shareTotals).length === 0) {
    throw new Error('No item lines found. Format:\n/items <description>\n<item> <amount> @person @person');
  }

  const shares = Object.entries(shareTotals).map(([jid, amount]) => ({ jid, amount }));
  return { amount: total, description, shares };
}

function addExpense(groupId, payerJid, amount, description, shares) {
  return withGroupLock(groupId, () => {
    const data = loadGroup(groupId);
    const expense = {
      id: Date.now().toString(36),
      payer: payerJid,
      amount,
      description,
      shares, // [{jid, amount}]
      timestamp: new Date().toISOString(),
    };
    data.expenses.push(expense);
    saveGroup(groupId, data);
    return expense;
  });
}

// Re-adds the most recent expense as a new entry (same description/shares),
// with the person running the command as payer. Simplest way to cover
// recurring costs (rent, subscriptions) without a separate template system.
function repeatLastExpense(groupId, payerJid) {
  return withGroupLock(groupId, () => {
    const data = loadGroup(groupId);
    const last = data.expenses[data.expenses.length - 1];
    if (!last) return null;
    const expense = {
      id: Date.now().toString(36),
      payer: payerJid,
      amount: last.amount,
      description: last.description,
      shares: last.shares,
      timestamp: new Date().toISOString(),
    };
    data.expenses.push(expense);
    saveGroup(groupId, data);
    return expense;
  });
}

// Updates the last expense's amount (and optionally description), rescaling
// each share proportionally so the original split ratio is preserved.
function editLastExpense(groupId, amount, description) {
  return withGroupLock(groupId, () => {
    const data = loadGroup(groupId);
    const last = data.expenses[data.expenses.length - 1];
    if (!last) return null;
    // last.amount is always >0 in practice (every path that creates an
    // expense validates amount > 0), but guard anyway rather than trust it.
    const ratio = last.amount > 0 ? amount / last.amount : 1;
    const shares = last.shares.map((s) => ({ jid: s.jid, amount: Math.round(s.amount * ratio * 100) / 100 }));
    const sum = shares.reduce((a, s) => a + s.amount, 0);
    const remainder = Math.round((amount - sum) * 100) / 100;
    const payerShare = shares.find((s) => s.jid === last.payer);
    if (payerShare) payerShare.amount = Math.round((payerShare.amount + remainder) * 100) / 100;

    last.amount = amount;
    last.shares = shares;
    if (description) last.description = sanitizeText(description);
    saveGroup(groupId, data);
    return last;
  });
}

function undoLastExpense(groupId) {
  return withGroupLock(groupId, () => {
    const data = loadGroup(groupId);
    const removed = data.expenses.pop();
    saveGroup(groupId, data);
    return removed;
  });
}

function resetGroup(groupId) {
  return withGroupLock(groupId, () => {
    const data = loadGroup(groupId);
    data.expenses = [];
    saveGroup(groupId, data);
  });
}

// mode: 'weekly' | 'monthly' | null (off)
function setDigest(groupId, mode) {
  return withGroupLock(groupId, () => {
    const data = loadGroup(groupId);
    data.digest = mode;
    saveGroup(groupId, data);
  });
}

// dateKey identifies "this digest period" (e.g. the Monday of the week, or
// year-month) so the scheduler doesn't resend within the same period.
function markDigestSent(groupId, dateKey) {
  return withGroupLock(groupId, () => {
    const data = loadGroup(groupId);
    data.lastDigestSent = dateKey;
    saveGroup(groupId, data);
  });
}

// Records that `fromJid` paid `toJid` amount, settling (part of) a debt.
// Stored like a reverse expense so computeBalances can fold it in directly.
function recordPayment(groupId, fromJid, toJid, amount) {
  return withGroupLock(groupId, () => {
    const data = loadGroup(groupId);
    if (!data.payments) data.payments = [];
    const payment = {
      from: fromJid,
      to: toJid,
      amount,
      timestamp: new Date().toISOString(),
    };
    data.payments.push(payment);
    saveGroup(groupId, data);
    return payment;
  });
}

function computeBalances(groupId) {
  const data = loadGroup(groupId);
  const net = {}; // jid -> net amount (+ve = owed money, -ve = owes money)

  for (const exp of data.expenses) {
    net[exp.payer] = (net[exp.payer] || 0) + exp.amount;
    for (const share of exp.shares) {
      net[share.jid] = (net[share.jid] || 0) - share.amount;
    }
  }

  for (const pay of data.payments || []) {
    net[pay.from] = (net[pay.from] || 0) + pay.amount;
    net[pay.to] = (net[pay.to] || 0) - pay.amount;
  }

  // round to 2 decimals
  for (const jid of Object.keys(net)) {
    net[jid] = Math.round(net[jid] * 100) / 100;
  }
  return { data, net };
}

/**
 * Greedy debt simplification: repeatedly settle the biggest creditor
 * against the biggest debtor. Produces a near-minimal set of transactions.
 */
function simplifyDebts(net) {
  const creditors = [];
  const debtors = [];
  for (const [jid, amt] of Object.entries(net)) {
    if (amt > 0.01) creditors.push({ jid, amt });
    else if (amt < -0.01) debtors.push({ jid, amt: -amt });
  }
  creditors.sort((a, b) => b.amt - a.amt);
  debtors.sort((a, b) => b.amt - a.amt);

  const transactions = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    transactions.push({ from: debtors[i].jid, to: creditors[j].jid, amount: Math.round(pay * 100) / 100 });
    debtors[i].amt -= pay;
    creditors[j].amt -= pay;
    if (debtors[i].amt < 0.01) i++;
    if (creditors[j].amt < 0.01) j++;
  }
  return transactions;
}

module.exports = {
  shortName,
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
};