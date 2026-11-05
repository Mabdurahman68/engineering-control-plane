import type {
  DispatchRequest,
  RawOutcome,
  RunHandle,
  WorkerAdapter,
} from '../../src/contracts/index.ts';
import type { MockAdapter } from '../../src/workers/mock/mock-adapter.ts';

// A WorkerAdapter whose reviews count as real. It exists only inside a test process: src/cli wires the
// mock and the relay and nothing else, and a test checks that from the import graph.
export function readyAdapter(inner: MockAdapter): WorkerAdapter {
  return {
    id: 'ready-fixture',
    probe: (r) => inner.probe(r),
    dispatch: (req: DispatchRequest) => inner.dispatch(req),
    wait: async (h: RunHandle): Promise<RawOutcome> => ({
      ...(await inner.wait(h)),
      transport_provenance: 'real',
    }),
    attach: (rec) => inner.attach(rec),
    cancel: (h) => inner.cancel(h),
    classify: (o) => inner.classify(o),
    usage: (o) => inner.usage(o),
  };
}
