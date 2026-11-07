import type { Clock } from './ports.ts';

export class RealClock implements Clock {
  now() {
    return Date.now();
  }
  sleep(ms: number) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
  // Wakes on new work, a due time, or every second so control requests get read.
  idle(wakeAt: number | null, isNotified: () => boolean, subscribe: (fn: () => void) => void) {
    return new Promise<void>((resolve) => {
      if (isNotified()) return resolve();
      const wait = Math.min(wakeAt === null ? 1000 : Math.max(0, wakeAt - Date.now()), 1000);
      const timer = setTimeout(resolve, wait);
      subscribe(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
