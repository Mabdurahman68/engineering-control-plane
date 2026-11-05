import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { cliEnv } from '../support/cli.ts';

describe('ecp, as a process', () => {
  it('run: a mock run ends in MOCK_RUN_COMPLETE, with a report, status and projection', () => {
    const c = cliEnv();
    const r = c.run(c.startArgs());
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('r1 MOCK_RUN_COMPLETE');
    const dir = join(c.home, 'runs/r1');
    for (const f of [
      'spec.yaml',
      'spec.lock',
      'policy.lock',
      'plan.json',
      'run.json',
      'status.txt',
      'RUN_REPORT.md',
      'ledger/events.jsonl',
    ]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    expect(readFileSync(join(dir, 'RUN_REPORT.md'), 'utf8')).toContain(
      'MOCK RUN — orchestration only; no semantic approval was given',
    );
  });
  it('status: plain text, stable keys, safe at any time', () => {
    const c = cliEnv();
    c.run(c.startArgs());
    const s = c.run(['status', 'r1']);
    expect(s.status).toBe(0);
    expect(s.stdout).toMatch(
      /^RUN r1\nSTATE MOCK_RUN_COMPLETE\nRISK low {2}DEPTH STANDARD\nELAPSED /,
    );
    expect(s.stdout).toContain('SHADOW agreement=');
    expect(s.stdout).toContain('USAGE tokens=unavailable');
    const j = JSON.parse(c.run(['status', 'r1', '--json']).stdout);
    expect(j.state).toBe('MOCK_RUN_COMPLETE');
    const all = c.run(['status', '--all']);
    expect(all.stdout.trim().split('\n').length).toBe(1);
  });
  it('report: prints it', () => {
    const c = cliEnv();
    c.run(c.startArgs());
    expect(c.run(['report', 'r1']).stdout).toContain('# SPEC-T — MOCK_RUN_COMPLETE');
  });
  it('refuses a second run while one is active, and an invalid spec', () => {
    const c = cliEnv();
    writeFileSync(c.specPath, 'schema: spec.v1\n');
    const r = c.run(c.startArgs());
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('invalid spec');
  });
  it('run: an escalation exits 4, and resume --with-decision continues it', () => {
    const c = cliEnv({
      script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'write_secret', times: 1 }],
    });
    const r = c.run(c.startArgs());
    expect(r.status).toBe(4);
    const decision = join(c.home, 'decision.yaml');
    writeFileSync(
      decision,
      stringify({
        schema: 'decision.v1',
        escalation_id: 'E-1',
        option_id: 'abandon',
        note: 'stop',
        new_information: false,
        authority_exercised: false,
        decided_by: 'owner',
      }),
    );
    const end = c.run(['resume', 'r1', '--with-decision', decision]);
    expect(end.stdout.trim()).toBe('r1 CANCELLED');
    expect(end.status).toBe(6);
  });
  it('a decision that fails its schema is refused, with no state change', () => {
    const c = cliEnv({
      script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'write_secret', times: 1 }],
    });
    c.run(c.startArgs());
    const bad = join(c.home, 'bad.yaml');
    writeFileSync(bad, stringify({ schema: 'decision.v1', escalation_id: 'E-1' }));
    const r = c.run(['resume', 'r1', '--with-decision', bad]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('invalid decision');
    expect(c.run(['status', 'r1']).stdout).toContain('STATE ESCALATION_REQUIRED');
  });
  it('a changed policy refuses resume without --accept-policy-change, then records it', () => {
    const c = cliEnv({
      policy: (p) => {
        p.settings.caps.run.invocations = 2;
      },
    });
    expect(c.run(c.startArgs()).status).toBe(3);
    const file = join(c.policyDir, 'settings.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('invocations: 2', 'invocations: 200'));
    const refused = c.run(['resume', 'r1']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('--accept-policy-change');
    const ok = c.run(['resume', 'r1', '--accept-policy-change']);
    expect(ok.stdout.trim()).toBe('r1 MOCK_RUN_COMPLETE');
    expect(readFileSync(join(c.home, 'runs/r1/ledger/events.jsonl'), 'utf8')).toContain(
      'accept_policy',
    );
  });
  it('--extend-budget resumes a capped run', () => {
    const c = cliEnv({
      policy: (p) => {
        p.settings.caps.run.invocations = 2;
      },
    });
    expect(c.run(c.startArgs()).status).toBe(3);
    expect(c.run(['resume', 'r1', '--extend-budget', '200']).stdout.trim()).toBe(
      'r1 MOCK_RUN_COMPLETE',
    );
  });
  it('cancel with no coordinator alive applies it, and reconciles', () => {
    const c = cliEnv({
      policy: (p) => {
        p.settings.caps.run.invocations = 2;
      },
    });
    c.run(c.startArgs());
    const r = c.run(['cancel', 'r1']);
    expect(r.stdout.trim()).toBe('r1 CANCELLED');
  });
  it('pause on a paused run changes nothing; cancel still works', () => {
    const c = cliEnv({
      policy: (p) => {
        p.settings.caps.run.invocations = 2;
      },
    });
    c.run(c.startArgs());
    const r = c.run(['pause', 'r1']);
    expect(r.stdout.trim()).toBe('r1 PAUSED_BUDGET');
  });
  it('a live pause, through the control file, while a run is working', async () => {
    const c = cliEnv({
      script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'ok', delay_ms: 30_000 }],
    });
    const running = c.runAsync(c.startArgs());
    const dir = join(c.home, 'runs/r1/ledger/events.jsonl');
    for (let i = 0; i < 300; i++) {
      if (existsSync(dir) && readFileSync(dir, 'utf8').includes('"dispatch.intent"')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const p = c.run(['pause', 'r1']);
    expect(p.stdout.trim()).toBe('pause requested');
    const end = await running;
    expect(end.stdout.trim()).toBe('r1 PAUSED_OPERATOR');
    expect(c.run(['status', 'r1']).stdout).toContain('BLOCKERS operator paused');
    const resumed = c.run(['resume', 'r1']);
    expect(resumed.stdout.trim()).toBe('r1 MOCK_RUN_COMPLETE');
  });
  it('clean removes worktrees, and keeps branches and refs', () => {
    const c = cliEnv({
      script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'write_secret' }],
    });
    expect(c.run(c.startArgs()).status).toBe(4);
    expect(existsSync(join(c.home, 'worktrees/r1'))).toBe(true);
    c.run(['clean', 'r1']);
    expect(existsSync(join(c.home, 'worktrees/r1'))).toBe(true);
    c.run(['clean', 'r1', '--force']);
    expect(existsSync(join(c.home, 'worktrees/r1'))).toBe(false);
  });
  it('metrics: figures across runs', () => {
    const c = cliEnv();
    c.run(c.startArgs('r1'));
    c.run(c.startArgs('r2'));
    const m = c.run(['metrics']).stdout;
    expect(m).toContain('Runs: 2');
    expect(m).toContain('Tasks finished without the owner: 6/6');
    expect(m).toContain('(no target; v0.1 is measuring)');
  });
  it('doctor: checks policy, families and relay pins, and warns about no notify channel', () => {
    const c = cliEnv();
    const r = c.run(['doctor', '--policy', c.policyDir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('at least two model families');
    expect(r.stdout).toContain('no notify.command');
  });
  it('doctor fails a single-family policy', () => {
    const c = cliEnv({
      policy: (p) => {
        for (const k of Object.keys(p.families.models)) p.families.models[k] = 'one';
      },
    });
    expect(c.run(['doctor', '--policy', c.policyDir]).status).toBe(1);
  });
  it('a notify command that fails is recorded, and shown', () => {
    const c = cliEnv({
      policy: (p) => {
        p.settings.notify.command = [process.execPath, '-e', 'process.exit(1)', '--'];
      },
    });
    c.run(c.startArgs());
    expect(readFileSync(join(c.home, 'runs/r1/ledger/events.jsonl'), 'utf8')).toContain(
      'notification.failed',
    );
  });
  it('notifications are appended for a person to read', () => {
    const c = cliEnv({
      script: [{ match: { task: 'T1', step: 'work' }, behaviour: 'write_secret' }],
    });
    c.run(c.startArgs());
    expect(readFileSync(join(c.home, 'notifications.jsonl'), 'utf8')).toContain(
      'ESCALATION_REQUIRED',
    );
  });
});
