# Contributing to wa-splitbot

Thanks for taking the time to contribute! This is a small personal-tool
project, so the process is intentionally lightweight.

## Before you start

- For anything beyond a small fix (new commands, behavior changes), open an
  issue first to discuss the approach before writing code — saves you a
  rewrite if the direction doesn't fit.
- Typos, small bug fixes, and docs updates can go straight to a PR.

## Workflow

1. Fork the repo and create a branch off `main`:
   `git checkout -b fix/short-description` or `feat/short-description`.
2. Make your change. Keep PRs focused — one fix or feature per PR is much
   easier to review than a bundle of unrelated changes.
3. Run the app locally and exercise the command(s) you touched in an actual
   WhatsApp group (see the README's "Run locally" section). There's no
   automated test suite yet, so manual verification is the bar.
4. Commit with a clear message (`fix: ...`, `feat: ...`, `docs: ...` prefixes
   welcome but not required).
5. Push and open a pull request against `main`.

## Pull request rules

- **Describe the change and why**, not just what — link the issue if there
  is one.
- **Keep it small.** Large, sprawling PRs sit in review longer and are more
  likely to introduce regressions.
- **No secrets or personal data.** Never commit `auth_info/`, `data/`, phone
  numbers, or `.env` files — `.gitignore` already excludes the first two,
  keep it that way.
- **Match existing style.** No linter is enforced yet, but follow the
  patterns already in `bot.js` / `expense.js` / `store.js` (plain CommonJS,
  small focused functions, comments only where the *why* isn't obvious).
- **At least one review approval required** before merge — branch
  protection on `main` enforces this (see below), so a maintainer needs to
  approve before you can merge.
- Once approved and checks pass, a maintainer (or you, if you have write
  access) will merge — please don't force-push over review history after
  it's been reviewed; push a new commit instead.

## Reporting bugs / requesting features

Open a GitHub issue with:
- What you expected vs. what happened (for bugs).
- Steps to reproduce, if applicable.
- Your environment (local vs. Railway/other host) if it seems relevant.

## Code of conduct

Be respectful. Disagreements about approach are fine and expected — personal
attacks aren't.
