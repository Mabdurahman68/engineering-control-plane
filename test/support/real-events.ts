import { loadLedger } from '../../src/ledger/ledger.ts';

export const ofTypeReal = (sim: { ledger: any }, type: string) =>
  loadLedger(sim.ledger).events.filter((e) => e.type === type);
