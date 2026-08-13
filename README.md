# wa-splitbot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

A WhatsApp group expense splitter (Splitwise-style), built on
[Baileys](https://github.com/WhiskeySockets/Baileys).

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the
workflow and pull request rules.

## Run locally

```bash
npm install
node bot.js
```

A QR code prints straight to your terminal. Scan it with
**WhatsApp → Settings → Linked Devices → Link a Device** on your phone.
Once connected you'll see `✅ Connected to WhatsApp`, and a session folder
`auth_info/` is created — you won't need to re-scan on restart unless you
log out from your phone.

## Deploy to Railway

Railway's filesystem is **ephemeral** — every redeploy or restart wipes
local files unless they live on a mounted Volume. Without one, you'd lose
your linked WhatsApp session (`auth_info/`) and your entire ledger
(`data/`) on every deploy.

1. **Push this project to a GitHub repo** and create a new Railway project
   from it (Railway auto-detects Node and runs `npm start`, which is
   already set to `node bot.js` in `package.json`).

2. **Add a Volume** in the Railway dashboard (Service → Settings →
   Volumes). Mount it at, say, `/data`.

3. **Set environment variables** on the service so the bot writes into
   that volume instead of local disk:
   ```
   AUTH_DIR=/data/auth_info
   DATA_DIR=/data/expenses
   ```
   (Railway sets `PORT` automatically — no need to set it yourself.)

4. **Deploy**, then open the service's public URL with `/qr` appended
   (e.g. `https://your-app.up.railway.app/qr`) in a browser. You'll see a
   scannable QR code there — scan it the same way as local setup. Once
   connected, that page will say "No QR pending" since the session is
   live.

5. Redeploys and restarts will now reuse the same volume, so you stay
   logged in and keep your ledger across deploys.

If you'd rather not expose the `/qr` page publicly long-term, you can
remove the route (or gate it behind a check) once you've linked the
session — the bot itself doesn't need it after the first connection.

## Usage (inside a WhatsApp group)

```
/expense 600 dinner @person1 @person2      -> equal split (you + tagged people)
/expense 600 dinner @all                   -> equal split across every group member
/expense 600 dinner @person1=300 @person2=300  -> custom split
/expense repeat                            -> re-add the last expense (you as payer)
/items groceries                           -> itemized bill, one item per line:
pizza 300 @a @b                               <item> <amount> @person @person
snacks 150 @a @c                              (payer is added to every item automatically)
/edit 700 new description                  -> update the last expense's amount/description
/balance                                    -> who owes / is owed
/balance @person                            -> just that person's balance
/settle                                    -> who needs to pay whom (numbered per person)
/nudge                                     -> ping everyone who currently owes money
/digest weekly                             -> auto-post balances every Monday 9am
/digest monthly                            -> auto-post balances on the 1st of the month, 9am
/digest off                                -> turn off the digest
/history                                   -> last 10 expenses
/export                                    -> download the ledger as a JSON file
/undo confirm                              -> remove the last expense
/reset confirm                             -> clear the ledger (after settling, group admins only)
/                                          -> show the command menu
/help                                      -> same as sending just /
```

Notes:
- WhatsApp has no native slash-command autocomplete like Discord/Slack —
  sending a bare `/` is handled by the bot itself, which replies with the
  full command menu. Sending an unrecognized `/something` also nudges you
  back to the menu instead of silently doing nothing.
- You must actually @-mention people (select them from WhatsApp's contact
  picker when typing @) for the bot to resolve their JIDs correctly. `@all`
  is a special keyword the bot handles itself — no need to select it as a
  contact.
- `@all` pulls the live member list from the group (via `groupMetadata`),
  so it always reflects who's actually in the group right now, including
  people added after the last expense.
- `@all` can't be combined with custom amounts (`@all=500`) — tag people
  individually for custom splits.
- The bot always includes the sender (payer) as one of the participants in
  equal splits, unless you give a custom split where the payer's amount is
  the remainder.
- Data is stored per-group in `<DATA_DIR>/<group_id>.json` (defaults to
  `./data` locally). Back this up if you care about history.

## Known limitations and mitigations

- **Ban risk (unofficial API):** this uses Baileys, not the official
  WhatsApp Business API, so WhatsApp can in principle flag/ban a number
  that looks automated. Mitigations built in: outgoing messages are sent
  through a queue with a 1.2–2.0s randomized delay between each (never a
  burst), and reconnects back off exponentially instead of hammering the
  server after a disconnect. For extra safety, use a secondary number
  (not your daily-driver number) as the bot's WhatsApp account, and keep
  usage to a small personal group rather than anything high-volume.
- **Debt simplification:** the settlement algorithm greedily matches the
  biggest debtor against the biggest creditor each round. This is the same
  approach Splitwise itself uses — it's very close to the mathematically
  minimal number of transactions, and finding the *true* minimum is
  NP-hard in general, so this isn't something worth over-engineering for
  a personal bot.
- **Concurrency:** ledger writes (`/expense`, `/undo`, `/reset`) now go
  through a per-group lock (`withGroupLock` in `store.js`), so if two
  people fire off commands in the same group at nearly the same moment,
  they're processed one at a time in order rather than racing to
  overwrite each other's changes.
- **Ephemeral hosting:** if you deploy somewhere without persistent disk
  (Railway, most serverless platforms), always set `AUTH_DIR`/`DATA_DIR`
  to a mounted persistent volume — see the Railway section above.

## Contributing

Bug fixes, new commands, and docs improvements are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the branch/PR workflow and rules.
`main` is protected — changes land via pull request with at least one
review approval.

## License

[MIT](LICENSE)