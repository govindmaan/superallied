# Super Allied app: working rules

## Every change goes on the Help & Updates page (standard)
Staff read **Help & Updates** (`/help`) to learn what changed. Every commit that
changes what anyone sees or does in the app must, in the same commit:

1. Add an entry at the top of `changelog.js` under today's date (India time;
   start a new date block if needed). Fields: `commit` (short hash, may be filled
   in by the next commit), `type` (`new` | `improved` | `fixed` | `removed`),
   `title`, `details` (plain sentences a salesperson would understand: what
   changed, where to find it, what they must do; no code words).
2. Add the Hindi version in `i18n/changelog-hi.js`, keyed by the same English
   title, with the same number of details.

Small follow-up fixes to something already listed the same day can update that
entry instead of adding a new one.

Enforced by:
- `test/changelog.test.js` (`npm test`): Hindi present for every entry, dates in
  order, and the newest Help date is not older than the latest commit.
- `.githooks/pre-push`: a push to `main` that changes the app without touching
  `changelog.js` is stopped. After a fresh clone run
  `git config core.hooksPath .githooks`.
- Changes staff cannot notice (tests, comments, tooling): put `[no-help]` in the
  commit message.

## Deploying
- A push to `main` deploys to production on Railway. Push only when the owner says so.
- `git fetch` / pull before starting work.
- Never drop production data or remove features without the owner's OK.

## Language
- Screens and menus use `t("…")` with Hindi in `i18n/hi/`. Stored data, PDFs and
  exports stay in English. `<option>` values that get saved stay English.
