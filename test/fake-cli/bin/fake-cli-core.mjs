// A fake coding CLI, for tests. No model, no network. Its behaviour set is closed: it reads a behaviour
// name from a script file and acts from the fixed table below. It never runs a command, path or argv
// taken from input. It spawns only itself, for the child behaviours.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const [kind, ...args] = process.argv.slice(2);

const ESCAPES = ['plain', 'chdir', 'argv', 'session', 'chdir,argv,session'];

function escapeMode(flags) {
  const home = process.env.HOME ?? '.';
  const heartbeat = join(home, 'escape-heartbeat');
  appendFileSync(join(home, 'escape-pids'), `${process.pid}\n`);
  if (flags.includes('chdir')) process.chdir('/');
  if (flags.includes('argv')) process.title = 'not-this-attempt';
  const beat = () => {
    try {
      appendFileSync(heartbeat, `${Date.now()}\n`);
    } catch {
      // Keep going: a writer that survives is the point of this mode.
    }
  };
  beat();
  setInterval(beat, 50);
}
if (kind === '--escape') {
  escapeMode(args[0]);
} else {
  run();
}

function loadStep() {
  const home = process.env.HOME ?? '';
  const file = join(home, 'fake-cli-script.json');
  if (!existsSync(file)) return { behaviour: 'ok' };
  const script = JSON.parse(readFileSync(file, 'utf8'));
  const counter = join(home, 'fake-cli-counter');
  const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
  writeFileSync(counter, String(n + 1));
  const list = script.steps ?? [];
  const step = list[Math.min(n, list.length - 1)] ?? {};
  return { behaviour: 'ok', ...step };
}

function option(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

function block(brief, label) {
  const m = new RegExp(`<data label="${label}">\\n([\\s\\S]*?)\\n</data>`).exec(brief);
  return m ? m[1] : null;
}

const CHECKS = ['spec_fidelity', 'architecture', 'security', 'test_adequacy', 'merge_compat'];

function reviewPass(brief, acs) {
  const files = [...(block(brief, 'diff') ?? '').matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
  return {
    verdict: 'PASS',
    criteria: acs.map((ac) => ({ ac, verdict: 'PASS', evidence: 'looked', finding_refs: [] })),
    semantic_checks: Object.fromEntries(CHECKS.map((n) => [n, { verdict: 'PASS', note: 'ok', finding_refs: [] }])),
    findings: [],
    claims_reviewed: [],
    looked_at: { files, commands: [], not_examined: [] },
  };
}

// What a cooperative worker answers, by the kind of brief it got. Data, and one fixed file for writers.
function autoReport(brief) {
  const specAcs = () => JSON.parse(block(brief, 'spec') ?? '{"acceptance_criteria":[]}').acceptance_criteria.map((c) => c.id);
  if (brief.startsWith('You are planning')) {
    const task = (id, acs) => ({ task_id: id, goal: `do ${id}`, lane: 'implementation', allowed_paths: [`src/${id.toLowerCase()}/**`], forbidden_paths: [], acceptance_criteria: acs, required_tests: ['unit'], depends_on: [] });
    return { tasks: [task('T1', specAcs()), task('T2', [])], proposed_risk: 'low', spec_defects: [] };
  }
  if (brief.startsWith('You are reviewing a task plan')) return reviewPass(brief, specAcs());
  if (brief.startsWith('You are an independent reviewer')) return reviewPass(brief, JSON.parse(block(brief, 'acceptance_criteria') ?? '[]'));
  if (brief.startsWith('Verify the integrated') || brief.startsWith('Assume this') || brief.startsWith('Review the integrated')) return reviewPass(brief, specAcs());
  if (brief.startsWith('A soft gate')) return { challenges: [] };
  if (brief.startsWith('You are proposing')) return { action: 'other', target: null, reason: 'fixture', confidence: 'low', evidence_refs: { fingerprints: [], signatures: [], artifacts: [] }, predicted_defects: [], alternatives: [] };
  const id = JSON.parse(block(brief, 'task') ?? '{"task_id":"x"}').task_id;
  if (/^T\d+$/.test(id)) {
    mkdirSync(join('src', id.toLowerCase()), { recursive: true });
    writeFileSync(join('src', id.toLowerCase(), `${id}.txt`), `${id}\n`);
  }
  return { status: 'done', summary: 'ok', claims: [], tests_run_claimed: [], known_issues: [], disputed_findings: [] };
}

function emitResult(step, brief) {
  const text = step.final ?? `Done.\n\n\`\`\`json\n${JSON.stringify(autoReport(brief))}\n\`\`\``;
  const session = step.session ?? `fake-session-${process.pid}`;
  if (kind === 'codex') {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: session }));
    console.log(JSON.stringify({ type: 'turn.started' }));
    if (step.usage !== false) console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 1, output_tokens: 5 } }));
    if (step.reported_model) console.log(JSON.stringify({ type: 'model', model: step.reported_model }));
    const out = option('-o');
    if (out) writeFileSync(out, text);
  } else if (kind === 'claude') {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: session, permissionMode: option('--permission-mode') }));
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01, num_turns: 1 }));
  } else {
    console.log(JSON.stringify({ type: 'text', sessionID: session, part: { id: 'p1', type: 'text', text } }));
    console.log(JSON.stringify({ type: 'step_finish', part: { cost: 0.02 } }));
  }
}

function fail(step, message, code = 1) {
  process.stderr.write(`${step.stderr ?? message}\n`);
  process.exitCode = code;
}

function run() {
  if (args.includes('--version')) {
    console.log(kind === 'codex' ? 'codex-cli 0.166.0' : kind === 'claude' ? '2.1.309 (Claude Code)' : '1.18.23');
    return;
  }
  if (args.includes('--help')) {
    console.log('--json --sandbox --model --permission-mode --agent --help');
    return;
  }
  if (args[0] === 'login' && args[1] === 'status') {
    const file = join(process.env.HOME ?? '', 'fake-cli-script.json');
    const login = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).login : undefined;
    if (login === 'apikey') console.log('Logged in using an API key');
    else console.log(login === 'none' ? 'Not logged in' : 'Logged in using ChatGPT');
    return;
  }
  let brief = '';
  process.stdin.on('data', (c) => {
    brief += c;
  });
  process.stdin.on('end', () => act(brief));
}

function act(brief) {
  const step = loadStep();
  const log = join(process.env.HOME ?? '.', 'fake-cli-calls.log');
  appendFileSync(log, `${JSON.stringify({ kind, args, cwd: process.cwd(), env: Object.keys(process.env), pid: process.pid })}\n`);
  switch (step.behaviour) {
    case 'quota':
      return fail(step, 'usage limit reached');
    case 'auth':
      return fail(step, 'not authenticated');
    case 'rate_limit':
      return fail(step, 'HTTP 429 rate limit');
    case 'outage':
      return fail(step, 'HTTP 503 service unavailable');
    case 'unknown':
      return fail(step, 'something odd');
    case 'no_output':
      return;
    case 'hang':
      setInterval(() => {}, 1000);
      return;
    case 'ignore_term':
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
      return;
    case 'hang_writers':
      if (brief.startsWith('Implement') || brief.startsWith('Repair')) {
        setInterval(() => {}, 1000);
        return;
      }
      emitResult(step, brief);
      return;
    case 'escape_writers':
    case 'escape': {
      if (step.behaviour === 'escape_writers' && !brief.startsWith('Implement')) {
        emitResult(step, brief);
        return;
      }
      // Only ever this file again, and only with these fixed argument shapes.
      const flags = ESCAPES.includes(step.flags) ? step.flags : 'plain';
      const child = spawn(process.execPath, [SELF, '--escape', flags], {
        detached: flags.includes('session'),
        stdio: 'ignore',
      });
      child.unref();
      if (step.then === 'hang') {
        setInterval(() => {}, 1000);
        return;
      }
      emitResult(step, brief);
      return;
    }
    default:
      emitResult(step, brief);
  }
}
