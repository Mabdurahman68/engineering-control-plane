import type { ShadowProposal } from '../contracts/index.ts';

export type ReplayPorts = {
  // Restores a fresh disposable copy of the fixture at the tree. Returns where it is.
  restore(tree: string, label: 'coordinator' | 'shadow'): Promise<string>;
  // Runs one path's action, under the same worker and limits for both.
  runAction(action: string, target: string | null, dir: string): Promise<void>;
  // Fixed before the replay, and held where neither path can read them.
  hiddenChecks(dir: string): Promise<{ passed: number; total: number }>;
  isDisposableFixture: boolean;
};

export type ReplayResult =
  | { status: 'NOT_REPLAYABLE'; reason: string }
  | {
      status: 'REPLAYED';
      replay_id: string;
      coordinator: { action: string; passed: number; total: number };
      shadow: { action: string; passed: number; total: number };
    };

// The only counterfactual evidence. v0.1 builds and mock-tests the mechanism; measurements come later.
export async function replayDecision(
  p: ShadowProposal,
  ports: ReplayPorts,
  replayId: string,
): Promise<ReplayResult> {
  if (!ports.isDisposableFixture)
    return { status: 'NOT_REPLAYABLE', reason: 'not a disposable fixture' };
  if (p.shadow.status !== 'RECORDED' || !p.shadow.report)
    return { status: 'NOT_REPLAYABLE', reason: 'no recorded proposal' };
  if (p.comparison.proposal_legal !== true)
    return { status: 'NOT_REPLAYABLE', reason: 'the proposal is illegal' };
  if (p.comparison.match === true)
    return { status: 'NOT_REPLAYABLE', reason: 'no disagreement to replay' };
  if (!p.subject_tree) return { status: 'NOT_REPLAYABLE', reason: 'no subject tree' };
  const a = await ports.restore(p.subject_tree, 'coordinator');
  const b = await ports.restore(p.subject_tree, 'shadow');
  await ports.runAction(p.coordinator.action, p.coordinator.target, a);
  await ports.runAction(p.shadow.report.action, p.shadow.report.target, b);
  const scoreA = await ports.hiddenChecks(a);
  const scoreB = await ports.hiddenChecks(b);
  return {
    status: 'REPLAYED',
    replay_id: replayId,
    coordinator: { action: p.coordinator.action, ...scoreA },
    shadow: { action: p.shadow.report.action, ...scoreB },
  };
}
