#!/usr/bin/env node
/*
 * Episode auto-play for QA test students (staging by default; production allowed via --base-url).
 *
 * Simulates a student playing episodes question by question, sending the same
 * fact sequence the real episode-container sends to the Scoring Service Lambda:
 *
 *   StartEpisode -> SubmitSolution (one per attempt, per question) -> FinishEpisode
 *
 * instead of the cheat-mode "finish with N stars" shortcut (FinishEpisode only).
 *
 * Note: the server never derives stars from SubmitSolution facts - the episode
 * bundle computes them client-side. This script therefore computes stars/points
 * from the simulated answers (or uses the `stars` column if you set it).
 *
 * Zero dependencies - Node 18+ (uses built-in fetch).
 *
 * Usage:
 *   node autoplay.js                       # uses students.js (your copy of students.example.js) + episodes.csv
 *   node autoplay.js --csv my.csv --students my-students.js
 *   node autoplay.js --dry-run             # print facts, send nothing
 *   node autoplay.js --count 10            # each student plays 10 random rows
 *   node autoplay.js --in-order            # play rows in CSV order instead of a random order per student
 *   node autoplay.js --max-episodes 15     # change the per-student limit of unique episodes (default 10, 0 = no limit)
 *   node autoplay.js --ignore-history      # don't look at earlier runs (allows replays, no limit carried over)
 *   node autoplay.js --base-url https://staging.matific.com --seed 42 --delay-ms 300
 *
 * Every student plays every row. The CSV `student` column only records who the episode is
 * assigned to (shown in the output/log, and always included in that student's --count picks).
 * A student never plays the same episode (slug) twice, and stops once they have completed
 * --max-episodes unique episodes. Earlier completions are read from the logs in --out.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------- CLI args

function parseArgs(argv) {
    const args = {
        baseUrl: 'https://staging.matific.com',
        csv: path.join(__dirname, 'episodes.csv'),
        students: path.join(__dirname, 'students.js'),
        dryRun: false,
        seed: Date.now() % 2147483647,
        delayMs: 300,
        out: path.join(__dirname, 'results'),
        maxEpisodes: 10,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === '--base-url') args.baseUrl = next().replace(/\/+$/, '');
        else if (a === '--csv') args.csv = path.resolve(next());
        else if (a === '--students') args.students = path.resolve(next());
        else if (a === '--dry-run') args.dryRun = true;
        else if (a === '--shuffle') args.inOrder = false; // random order is the default; kept for old commands
        else if (a === '--in-order') args.inOrder = true;
        else if (a === '--skip-played') args.ignoreHistory = false; // now the default; kept for old commands
        else if (a === '--ignore-history') args.ignoreHistory = true;
        else if (a === '--max-episodes') {
            args.maxEpisodes = parseInt(next(), 10);
            if (!(args.maxEpisodes >= 0)) throw new Error('--max-episodes needs a number (0 = no limit)');
        }
        else if (a === '--count') {
            args.count = parseInt(next(), 10);
            if (!(args.count > 0)) throw new Error('--count needs a positive number');
        }
        else if (a === '--seed') args.seed = parseInt(next(), 10);
        else if (a === '--delay-ms') args.delayMs = parseInt(next(), 10);
        else if (a === '--out') args.out = path.resolve(next());
        else if (a === '-h' || a === '--help') {
            console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${a}`);
        }
    }
    return args;
}

// Production is allowed (for test users created there), but make it obvious in the output.
function warnIfProduction(baseUrl) {
    const host = new URL(baseUrl).hostname;
    if (!/(staging|dev|matificrnd|localhost|127\.0\.0\.1)/i.test(host)) {
        console.warn(`! Running against PRODUCTION host "${host}". Use test student accounts only.`);
    }
}

// ---------------------------------------------------------------- seeded RNG

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

let rand = Math.random;
const randInt = (min, max) => min + Math.floor(rand() * (max - min + 1));

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// ---------------------------------------------------------------- CSV

function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') inQuotes = false;
            else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (row.some((v) => v.trim() !== '')) rows.push(row);
            row = [];
        } else field += c;
    }
    row.push(field);
    if (row.some((v) => v.trim() !== '')) rows.push(row);

    const header = rows.shift().map((h) => h.trim().replace(/^﻿/, '').toLowerCase());
    return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
}

function loadEpisodes(csvPath) {
    const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
    return rows.map((r, idx) => {
        const line = idx + 2;
        if (!r.slug) throw new Error(`${csvPath}:${line} missing "slug"`);
        const questionCount = parseInt(r.question_count, 10);
        if (!(questionCount > 0)) throw new Error(`${csvPath}:${line} "question_count" must be a positive integer`);

        // `stars` is a fixed value ("4") or a range ("3-5") picked at random for every play.
        let stars = null;
        let starsRange = null;
        const range = (r.stars || '').match(/^(\d)\s*-\s*(\d)$/);
        if (range) {
            starsRange = [parseInt(range[1], 10), parseInt(range[2], 10)];
            if (!(starsRange[0] <= starsRange[1] && starsRange[1] <= 5)) {
                throw new Error(`${csvPath}:${line} "stars" range must be like 3-5 (within 0..5)`);
            }
        } else if (r.stars) {
            stars = /^\d$/.test(r.stars) ? parseInt(r.stars, 10) : NaN;
            if (!(stars >= 0 && stars <= 5)) throw new Error(`${csvPath}:${line} "stars" must be 0..5 or a range like 3-5`);
        }

        let correctCount;
        if (r.correct_count !== undefined && r.correct_count !== '') {
            correctCount = parseInt(r.correct_count, 10);
        } else if (stars !== null) {
            // Pick a correct count that lands in the requested star band.
            correctCount = correctCountForStars(stars, questionCount);
        } else {
            correctCount = questionCount;
        }
        if (!(correctCount >= 0 && correctCount <= questionCount)) {
            throw new Error(`${csvPath}:${line} "correct_count" must be 0..question_count`);
        }

        return {
            line,
            student: r.student || '',
            slug: r.slug,
            questionCount,
            correctCount,
            stars,
            starsRange,
            activityContext: r.activity_context === undefined || r.activity_context === '' ? '2' : r.activity_context,
            assignmentId: r.assignment_id || '',
            assignToAll: !['false', '0', 'no'].includes((r.assign_to_all || 'true').toLowerCase()),
        };
    });
}

// Episodes each student already completed, from earlier real (non dry-run) logs in the results dir
// for the same base URL. Returns Map<lowercase username, Set<lowercase slug>>.
function loadPlayedHistory(outDir, baseUrl) {
    const played = new Map();
    if (!fs.existsSync(outDir)) return played;
    for (const file of fs.readdirSync(outDir).filter((f) => /^run-.*\.json$/.test(f))) {
        let log;
        try { log = JSON.parse(fs.readFileSync(path.join(outDir, file), 'utf8')); } catch (_) { continue; }
        if (log.dryRun || log.baseUrl !== baseUrl || !Array.isArray(log.results)) continue;
        for (const r of log.results) {
            if (!r.ok || r.dryRun || !r.student || !r.slug) continue;
            const key = r.student.toLowerCase();
            if (!played.has(key)) played.set(key, new Set());
            played.get(key).add(r.slug.toLowerCase());
        }
    }
    return played;
}

function loadStudents(studentsPath) {
    if (!fs.existsSync(studentsPath)) {
        throw new Error(`${studentsPath} not found. Copy students.example.js to ${path.basename(studentsPath)} and add your test students.`);
    }
    const students = require(studentsPath);
    if (!Array.isArray(students) || students.length === 0) {
        throw new Error(`${studentsPath} must export a non-empty array of { username, password }`);
    }
    students.forEach((s, i) => {
        if (!s.username || !s.password) throw new Error(`${studentsPath}: entry ${i} needs username and password`);
    });
    return students;
}

// ---------------------------------------------------------------- HTTP + cookies

class CookieJar {
    constructor() { this.cookies = []; }

    store(url, response) {
        const host = new URL(url).hostname;
        const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
        for (const raw of setCookies) {
            const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
            const eq = pair.indexOf('=');
            const name = pair.slice(0, eq);
            const value = pair.slice(eq + 1);
            let domain = host;
            let hostOnly = true;
            for (const attr of attrs) {
                const [k, v] = attr.split('=');
                if (k.toLowerCase() === 'domain' && v) { domain = v.replace(/^\./, '').toLowerCase(); hostOnly = false; }
            }
            this.cookies = this.cookies.filter((c) => !(c.name === name && c.domain === domain));
            this.cookies.push({ name, value, domain, hostOnly });
        }
    }

    header(url) {
        const host = new URL(url).hostname.toLowerCase();
        return this.cookies
            .filter((c) => (c.hostOnly ? host === c.domain : host === c.domain || host.endsWith('.' + c.domain)))
            .map((c) => `${c.name}=${c.value}`)
            .join('; ');
    }

    get(name) {
        const c = this.cookies.find((x) => x.name === name);
        return c ? c.value : undefined;
    }
}

async function request(jar, url, { method = 'GET', headers = {}, body } = {}) {
    const cookie = jar.header(url);
    const res = await fetch(url, {
        method,
        redirect: 'manual',
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body,
    });
    jar.store(url, res);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, location: res.headers.get('location'), text, json };
}

function findKey(obj, key) {
    if (!obj || typeof obj !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key]) return obj[key];
    for (const v of Object.values(obj)) {
        const found = findKey(v, key);
        if (found) return found;
    }
    return undefined;
}

// ---------------------------------------------------------------- Matific API

async function login(jar, baseUrl, { username, password }) {
    // GET first so we pick up csrftoken / session cookies like a browser would.
    // Follow redirects (e.g. /login-page/ -> /us/en-us/login-page/) so we POST to the real page.
    let loginUrl = `${baseUrl}/login-page/`;
    for (let hops = 0; ; hops++) {
        const page = await request(jar, loginUrl);
        if (page.status < 300 || page.status >= 400 || !page.location) break;
        if (hops >= 5) throw new Error(`login page redirected too many times (last: ${loginUrl})`);
        loginUrl = new URL(page.location, loginUrl).href;
    }
    const csrf = jar.get('csrftoken');
    const res = await request(jar, loginUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Referer: loginUrl,
            Origin: baseUrl,
            ...(csrf ? { 'X-CSRFToken': csrf } : {}),
        },
        body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error(`login failed for ${username} (HTTP ${res.status}): ${res.text.slice(0, 300)}`);
}

async function getGameInit(jar, baseUrl) {
    // platform=webglplayer makes the server set the temp_ref cookie the scoring service checks.
    const res = await request(jar, `${baseUrl}/api/student-site-v2/game-initialization-data/?platform=webglplayer`, {
        headers: { Accept: 'application/json', Referer: `${baseUrl}/` },
    });
    if (!res.ok || !res.json) {
        throw new Error(`game-initialization-data failed (HTTP ${res.status}). Is this a class/home student? ${res.text.slice(0, 300)}`);
    }
    const scoringUrl = findKey(res.json, 'ScoringServiceUrl');
    const token = findKey(res.json, 'UserDataToken') || jar.get('user_data_token');
    if (!scoringUrl) throw new Error('ScoringServiceUrl not found in game-initialization-data');
    if (!token) throw new Error('UserDataToken not found (student session has no user data token)');
    return { scoringUrl: scoringUrl.endsWith('/') ? scoringUrl : scoringUrl + '/', token };
}

async function checkEpisodeExists(jar, baseUrl, slug) {
    const res = await request(jar, `${baseUrl}/api/v2/episodes/episode/${encodeURIComponent(slug)}/`, {
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`episode "${slug}" not found on ${baseUrl} (HTTP ${res.status})`);
}

async function sendFact(jar, ctx, fact) {
    const res = await request(jar, `${ctx.scoringUrl}addFacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ctx.baseUrl, Referer: `${ctx.baseUrl}/` },
        body: JSON.stringify({ facts: [fact], user_data_token: ctx.token }),
    });
    if (!res.ok) throw new Error(`addFacts ${fact.type} failed (HTTP ${res.status}): ${res.text.slice(0, 300)}`);
}

// ---------------------------------------------------------------- play simulation

function newDiscriminator() {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let suffix = '';
    for (let i = 0; i < 16; i++) suffix += chars[Math.floor(rand() * chars.length)];
    return `${ymd}_${suffix}`;
}

function getAssignmentType(activityContext, assignToAll) {
    // Mirrors episode-container ConfigService.getAssignmentType
    if (activityContext === '0' || activityContext === '1') return assignToAll ? 1 : 2;
    if (activityContext === '6') return 3;
    if (activityContext === '13') return 4;
    return 0;
}

// Correct-answer count that lands in a star band.
function correctCountForStars(stars, questionCount) {
    return stars === 5 ? questionCount : Math.ceil((stars * 20 / 100) * questionCount);
}

// For each row with a `stars` range, deal its values out evenly across the students and shuffle,
// so students get different stars on the same episode (never all equal when the range allows it).
// Returns Map<row, stars[] indexed by student position>.
function planStars(episodes, studentCount) {
    const plan = new Map();
    for (const ep of episodes) {
        if (!ep.starsRange) continue;
        const [min, max] = ep.starsRange;
        const size = max - min + 1;
        const offset = randInt(0, size - 1); // so leftover slots don't always go to the lowest stars
        plan.set(ep, shuffle(Array.from({ length: studentCount }, (_, i) => min + ((i + offset) % size))));
    }
    return plan;
}

// Apply this play's planned stars (and a matching correct count) for rows with a `stars` range.
function resolvePlay(ep, stars) {
    if (!ep.starsRange) return ep;
    return { ...ep, stars, correctCount: correctCountForStars(stars, ep.questionCount) };
}

function computeResult(ep) {
    if (ep.stars !== null) {
        return { stars: ep.stars, points: ep.stars === 5 ? 100 : ep.stars * 20 };
    }
    const points = Math.round((100 * ep.correctCount) / ep.questionCount);
    return { stars: points >= 100 ? 5 : Math.floor(points / 20), points };
}

/**
 * Builds the full fact sequence for one episode run, with simulated timestamps
 * ending "now". Field names match what episode-container's FactsService.buildFact sends.
 */
function buildPlayFacts(ep) {
    const discriminator = newDiscriminator();
    const episodeInstanceId = crypto.randomUUID();
    const common = {
        episode_slug: ep.slug,
        episode_run_discriminator: discriminator,
        channel: 'Website',
        is_offline_fact: false,
        activity_context: ep.activityContext,
        assignment_type: getAssignmentType(ep.activityContext, ep.assignToAll),
        ...(ep.assignmentId ? { assignment_id: ep.assignmentId } : {}),
        is_auto_assigned: 0,
        episode_instance_id: episodeInstanceId,
        platform: 'webglplayer',
        is_arena: false,
        from_tablet: false,
        invoked_from: 'qa-autoplay-script',
    };

    // Which questions end up correct.
    const outcomes = shuffle([
        ...Array(ep.correctCount).fill(true),
        ...Array(ep.questionCount - ep.correctCount).fill(false),
    ]);

    // Build a timeline (ms offsets from episode start) first, then anchor it to "now".
    const timeline = [];
    let t = randInt(2000, 6000); // intro / loading
    timeline.push({ at: 0, type: 'StartEpisode' });

    outcomes.forEach((solved, problemIndex) => {
        const problemId = crypto.randomBytes(16).toString('hex');
        const questionStart = t;
        // Solved questions: usually first try, sometimes one mistake first.
        // Unsolved questions: three wrong attempts, then the episode moves on.
        const wrongAttempts = solved ? (rand() < 0.2 ? 1 : 0) : 3;
        let lastAnswerAt = questionStart;
        for (let mistakes = 0; mistakes <= wrongAttempts; mistakes++) {
            const isLastWrong = !solved && mistakes === wrongAttempts;
            if (isLastWrong) break;
            const isCorrect = solved && mistakes === wrongAttempts;
            t += randInt(4000, 20000);
            timeline.push({
                at: t,
                type: 'SubmitSolution',
                problemIndex,
                problemId,
                mistakes,
                isCorrect,
                sinceQuestionStart: t - questionStart,
                sinceLastAnswer: t - lastAnswerAt,
                wasCorrectAnswerShown: !solved && mistakes === wrongAttempts - 1,
            });
            lastAnswerAt = t;
        }
        t += randInt(1000, 3000); // transition to next question
    });
    timeline.push({ at: t, type: 'FinishEpisode' });

    const startMs = Date.now() - t;
    const { stars, points } = computeResult(ep);

    const facts = timeline.map((e) => {
        const clientTime = startMs + e.at;
        const base = {
            ...common,
            type: e.type,
            client_time: clientTime,
            time_diff: Date.now() - clientTime,
            since_episode_start_sec: e.at, // episode-container forwards sinceStart (ms) under this key
            problem_count: ep.questionCount,
        };
        if (e.type === 'StartEpisode') {
            return { ...base, ran_in_adaptive_mode: false, load_time_sec: randInt(1500, 4000) };
        }
        if (e.type === 'SubmitSolution') {
            return {
                ...base,
                problem_id: e.problemId,
                problem_index: e.problemIndex,
                step_count: 1,
                step_index: 0,
                mistakes: e.mistakes,
                is_correct: e.isCorrect ? 1 : 0,
                attempt: e.mistakes + (e.isCorrect ? 1 : 0), // same rule as FactsService.buildFact
                was_correct_answer_shown: e.wasCorrectAnswerShown ? 1 : 0,
                since_question_start_sec: Math.round(e.sinceQuestionStart / 1000),
                since_last_answer_sec: Math.round(e.sinceLastAnswer / 1000),
            };
        }
        return { ...base, score: stars, points, episode_duration: e.at };
    });

    return { discriminator, stars, points, facts };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- main

async function main() {
    const args = parseArgs(process.argv);
    warnIfProduction(args.baseUrl);
    rand = mulberry32(args.seed);

    const students = loadStudents(args.students);
    const episodes = loadEpisodes(args.csv);
    const played = args.ignoreHistory ? new Map() : loadPlayedHistory(args.out, args.baseUrl);
    console.log(`Base URL: ${args.baseUrl}  |  students: ${students.length}  |  episode rows: ${episodes.length}  |  seed: ${args.seed}${args.dryRun ? '  |  DRY RUN' : ''}`);

    const starsPlan = planStars(episodes, students.length);
    const results = [];
    for (const [studentIndex, student] of students.entries()) {
        // Every student may play every row; the `student` column only records who the episode is assigned to.
        const randomize = !args.inOrder;
        const isMine = (e) => e.student.toLowerCase() === student.username.toLowerCase();
        let rows = randomize ? shuffle([...episodes]) : [...episodes];
        // Episodes this student already completed in earlier runs are never played again.
        const done = played.get(student.username.toLowerCase()) || new Set();
        {
            const skipped = [...new Set(rows.filter((e) => done.has(e.slug.toLowerCase())).map((e) => e.slug))];
            const capped = args.maxEpisodes && done.size >= args.maxEpisodes; // reported below instead
            if (skipped.length && !capped) console.log(`\n- ${student.username}: skipping ${skipped.length} already-completed episode(s): ${skipped.join(', ')}`);
            rows = rows.filter((e) => !done.has(e.slug.toLowerCase()));
        }
        // Rows assigned to this student go first so they win duplicate slugs and always make the --count cut.
        rows = [...rows.filter(isMine), ...rows.filter((e) => !isMine(e))];
        // Never play the same episode twice for a student in one run.
        const seen = new Set();
        rows = rows.filter((e) => !seen.has(e.slug.toLowerCase()) && seen.add(e.slug.toLowerCase()));
        let limit = args.count || Infinity;
        if (args.maxEpisodes) {
            const remaining = Math.max(0, args.maxEpisodes - done.size);
            if (remaining === 0) {
                console.log(`\n=== ${student.username}: already completed ${done.size} unique episode(s) (limit ${args.maxEpisodes}), skipping ===`);
                continue;
            }
            if (done.size) console.log(`\n- ${student.username}: ${done.size} of ${args.maxEpisodes} unique episodes already completed, up to ${remaining} more`);
            limit = Math.min(limit, remaining);
        }
        if (args.count && rows.length < Math.min(args.count, limit)) {
            console.warn(`\n! ${student.username}: only ${rows.length} unique episode(s) available, wanted ${Math.min(args.count, limit)}`);
        }
        rows = rows.slice(0, limit);
        rows = randomize ? shuffle(rows) : rows.sort((a, b) => a.line - b.line);
        if (rows.length === 0) {
            console.log(`\n=== ${student.username}: nothing left to play ===`);
            continue;
        }
        console.log(`\n=== ${student.username} (${rows.length} episode(s)) ===`);

        const jar = new CookieJar();
        let ctx = { baseUrl: args.baseUrl };
        if (!args.dryRun) {
            try {
                await login(jar, args.baseUrl, student);
                ctx = { ...ctx, ...(await getGameInit(jar, args.baseUrl)) };
            } catch (err) {
                console.error(`  ✗ ${err.message}`);
                rows.forEach((ep) => results.push({ student: student.username, slug: ep.slug, assignedTo: ep.student || null, assignedToThisStudent: isMine(ep), ok: false, error: err.message }));
                continue;
            }
        }

        for (const row of rows) {
            const ep = resolvePlay(row, starsPlan.get(row)?.[studentIndex]);
            const run = buildPlayFacts(ep);
            const label = `${ep.slug} [${ep.correctCount}/${ep.questionCount} correct -> ${run.stars}★, ${run.points} pts, ctx ${ep.activityContext}]`
                + (ep.student ? (isMine(ep) ? '  (assigned)' : `  (assigned to ${ep.student})`) : '');
            const assigned = { assignedTo: ep.student || null, assignedToThisStudent: isMine(ep) };
            if (args.dryRun) {
                console.log(`  • ${label}  run ${run.discriminator}`);
                run.facts.forEach((f) => console.log('    ' + JSON.stringify(f)));
                results.push({ student: student.username, slug: ep.slug, ...assigned, ok: true, dryRun: true, discriminator: run.discriminator, stars: run.stars, points: run.points });
                continue;
            }
            try {
                await checkEpisodeExists(jar, args.baseUrl, ep.slug);
                for (const fact of run.facts) {
                    await sendFact(jar, ctx, fact);
                    if (args.delayMs > 0) await sleep(args.delayMs);
                }
                console.log(`  ✓ ${label}  run ${run.discriminator} (${run.facts.length} facts)`);
                results.push({ student: student.username, slug: ep.slug, ...assigned, ok: true, discriminator: run.discriminator, stars: run.stars, points: run.points, facts: run.facts.length });
            } catch (err) {
                console.error(`  ✗ ${label}: ${err.message}`);
                results.push({ student: student.username, slug: ep.slug, ...assigned, ok: false, discriminator: run.discriminator, error: err.message });
            }
        }
    }

    fs.mkdirSync(args.out, { recursive: true });
    const outFile = path.join(args.out, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(outFile, JSON.stringify({ baseUrl: args.baseUrl, seed: args.seed, dryRun: args.dryRun, results }, null, 2));

    const failed = results.filter((r) => !r.ok).length;
    console.log(`\nDone: ${results.length - failed} ok, ${failed} failed. Log: ${outFile}`);
    process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
