import { describe, expect, it, vi } from 'vitest';
import { events, makeSim, runSim } from '../support/harness.ts';

describe('a shadow attempt nobody is waiting for', () => {
  it('is stopped at the end of the run, not left running', async () => {
    const sim: any = makeSim({
      shadow: true,
      script: [{ match: { step: 'shadow' }, behaviour: 'shadow_slow' }] as never,
    });
    const cancel = vi.spyOn(sim.adapter, 'cancel');
    const exit = await runSim(sim);
    expect(exit.state).toBe('MOCK_RUN_COMPLETE');
    const unavailable = events(sim).filter(
      (e: any) => e.type === 'shadow.unavailable' && e.data.class === 'END_OF_RUN',
    );
    expect(unavailable.length).toBeGreaterThan(0);
    expect(cancel.mock.calls.length).toBeGreaterThanOrEqual(unavailable.length);
  });
});
