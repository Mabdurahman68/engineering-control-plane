// Runs at most `limit` tasks at a time.
export class Queue {
  constructor(limit) {
    this.limit = limit;
    this.running = 0;
    this.waiting = [];
    this.started = [];
  }
  async note(event) {
    this.started.push(event);
  }
  async run(task) {
    if (this.running >= this.limit) {
      await new Promise((r) => this.waiting.push(r));
    }
    await this.note('start');
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}
