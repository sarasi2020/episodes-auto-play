# Episode Autoplay (QA test students)

An experimental automation project developed with Claude to play 10 unique episodes for a manually selected group of students.

This script plays Matific episodes question by question for test students. It targets **staging** by default, and can also target production for test users created there. It sends the same facts the real episode player sends to the Scoring Service:

```
StartEpisode → SubmitSolution (one per attempt, per question) → FinishEpisode
```

Cheat mode's "finish with N stars" only sends `FinishEpisode`. This script also records each question and attempt, so reports that use question-level data, mistakes or time-on-task get filled in.

> ⚠️ **Production is allowed.** Use `--base-url https://www.matific.com` (or your production URL) for test users created in production. The script prints a `Running against PRODUCTION` warning for any host that doesn't contain `staging`, `dev`, `matificrnd` or `localhost`. Only use test student accounts there, never real students.

## Requirements

- Node.js 18 or later. Check with `node --version`.
- Nothing else. The script uses only Node's built-in modules, so there's no `npm install`.

## Files

| File | Purpose |
|---|---|
| `autoplay.js` | The script |
| `students.example.js` | Template for your test-student logins (see Setup) |
| `episodes.csv` | Which episodes to play, and how well |

Each run also writes a JSON log to a `results/` folder, which is created on the first run and stays on your machine (it is git-ignored).

## Setup

### 1. Add your test students from `students.example.js`

`students.example.js` is a template. Make a copy of it in the same folder named `students.js`, then replace the placeholders with your test students' logins:

```bash
cp students.example.js students.js        # Windows: copy students.example.js students.js
```

```js
module.exports = [
    { username: 'student1_username', password: 'password1' },
    { username: 'student2_username', password: 'password2' },
];
```

- Accounts must be **class students or home students**, because only students get a scoring token.
- Your copy is git-ignored, so the logins stay on your machine and are never committed. Leave `students.example.js` itself with placeholders only.
- Passwords are stored in plain text, so use test accounts only. The accounts must exist in the environment you target (staging accounts won't work on production, and the other way round).

### 2. Add episodes: `episodes.csv`

```csv
slug,question_count,correct_count,stars,activity_context,assignment_id,assign_to_all,student
CherryMonster,5,,,,,,
DovecotesMaking,10,7,,1,,true,
Worksheet,8,,3,0,,,student1_username
```

The `episodes.csv` in the repo has one example row. To keep your own list out of git (it may contain test usernames), save it as `episodes-local.csv`, which is git-ignored, and run with `node autoplay.js --csv episodes-local.csv`.

| Column | Required | Default | Meaning |
|---|---|---|---|
| `slug` | ✅ | | Episode slug. It must exist in the target environment. |
| `question_count` | ✅ | | Number of questions to play |
| `correct_count` | | all correct | How many questions are answered correctly |
| `stars` | | from `correct_count` | Force a star result (0–5). If `correct_count` is empty, it is set to land in this star band. A range such as `3-5` gives students different stars on the same episode: the values in the range are spread across the students and shuffled, so they are never all equal (with 4 students, `3-5` gives 3, 4, 5 and one random repeat). With a range, `correct_count` is ignored and set to match the stars picked. |
| `activity_context` | | `2` | `0` Homework, `1` Classwork, `2` Adventure Island (free play), `4` Training Zone, `6` Parent assignment, `13` Core work |
| `assignment_id` | | blank | Can be left blank for `0`/`1`, because the scoring service finds the student's assignment for the episode |
| `assign_to_all` | | `true` | `true` = class assignment, `false` = personal assignment (only used for contexts `0`/`1`) |
| `student` | | blank | Username this episode is assigned to. Used for tracking only, every student still plays the row |

Each row is played once for each of your test students, in a random order per student (use `--in-order` for CSV order). The `student` column does not limit who plays the row. It is shown in the output (`(assigned)` / `(assigned to …)`) and saved in the results log as `assignedTo` / `assignedToThisStudent`. With `--count`, a student's assigned episodes are always among their picks. A student never plays the same slug twice, and **stops once they have completed 10 unique episodes** across all runs. Earlier completions are read from your local logs in `results/` (successful real runs only), so keep that folder: deleting it makes those episodes playable again. Use `--max-episodes N` to change the limit (`0` = no limit), or `--ignore-history` to ignore earlier runs.

## Commands

Run all commands from the project folder (where `autoplay.js` is).

| What | Command |
|---|---|
| Preview the facts without sending anything | `node autoplay.js --dry-run` |
| Play everything on staging | `node autoplay.js` |
| Play exactly the same simulated answers again | `node autoplay.js --seed 42` |
| Use a different CSV or students file (for example one per environment) | `node autoplay.js --csv path\to\episodes.csv --students path\to\students-prod.js` |
| Change the pause between requests (default 300 ms) | `node autoplay.js --delay-ms 1000` |
| Target another environment (dev, or production for test users) | `node autoplay.js --base-url https://dev.matific.com` |
| Write logs somewhere else | `node autoplay.js --out path\to\logs` |
| Show help | `node autoplay.js --help` |

You can combine options, for example:

```bash
node autoplay.js --csv regression.csv --seed 7 --dry-run
```

## Output

```
=== student1_username (3 episode(s)) ===
  ✓ DovecotesMaking [7/10 correct -> 3★, 70 pts, ctx 1]  run 20261015_MPAD1NPQ8ZYLMEE6 (19 facts)
  ✗ BadSlug [5/5 correct -> 5★, 100 pts, ctx 2]: episode "BadSlug" not found on https://staging.matific.com (HTTP 404)

Done: 1 ok, 1 failed. Log: results\run-2026-10-15T10-30-00-000Z.json
```

- The `run …` value is the `episode_run_discriminator`. Use it to find the run in `episode_run`.
- The exit code is `1` if any episode failed.

## How answers are simulated

- **Correct question:** usually right on the first try. Sometimes (about 20% of the time) there's one mistake first.
- **Wrong question:** three wrong attempts, with the answer shown on the last one. Then the episode moves on.
- **Which questions are wrong:** random. Use `--seed` to repeat a run exactly.
- **Timing:** 4–20 s per attempt. Timestamps are back-dated so the run looks like it ended "now", so the script doesn't wait in real time.
- **Score:**
  - `points = round(correct / total × 100)`
  - `stars = floor(points / 20)`, and 100 points gives 5 stars

  The real stars are worked out inside each episode, and the server doesn't check them against the answers. If you need an exact star result, use the `stars` column.

## Finding script runs in the data

Every fact is tagged `invoked_from = 'qa-autoplay-script'`, so script runs can be separated from real play.

## Troubleshooting

| Error | Likely cause |
|---|---|
| `students.js not found` | You haven't made your copy of `students.example.js` yet (see Setup) |
| `login failed … HTTP 401/403` | Wrong credentials, an expired license, or a captcha after too many failed attempts |
| `game-initialization-data failed` | The account is not a student |
| `UserDataToken not found` | The student session has no scoring token. Log in once in the browser and try again |
| `episode "<slug>" not found` | The slug doesn't exist in the target environment. Check the spelling, which is case-sensitive |
| `addFacts … HTTP 401` | The scoring token expired or is invalid. Run again to get a fresh login |
