import type { Engine } from './engine.ts';

// M8P replaces this. Until the publish module exists, nothing can leave the machine.
export async function stepPushing(e: Engine): Promise<boolean> {
  e.runTo('PUSH_BLOCKED', 'push_blocked', { reason: 'publish module not present' });
  return true;
}
