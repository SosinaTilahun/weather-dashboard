// A small Promise-based queue that limits how many tasks run at the same time.
//
//   const queue = new PromiseQueue({ concurrency: 2 });
//   const result = await queue.add((signal) => fetch(url, { signal }), { signal });
//
// Tasks start in FIFO order. At most `concurrency` tasks are in flight; the rest wait.
// A task that is still waiting when its signal aborts is removed and rejected right away,
// so cancelled requests never consume a slot.

import { createAbortError } from './errors.js';

export class PromiseQueue {
  #concurrency;
  #active = 0;
  #pending = [];
  #onChange;

  /**
   * @param {{concurrency?: number, onChange?: (stats: {active: number, pending: number, concurrency: number}) => void}} [options]
   */
  constructor({ concurrency = 2, onChange } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError('concurrency must be a positive integer');
    }
    this.#concurrency = concurrency;
    this.#onChange = onChange;
  }

  get stats() {
    return { active: this.#active, pending: this.#pending.length, concurrency: this.#concurrency };
  }

  /**
   * Schedule a task. Resolves/rejects with the task's own result.
   * @param {(signal?: AbortSignal) => Promise<T> | T} task
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<T>}
   * @template T
   */
  add(task, { signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError());
        return;
      }

      const entry = { task, resolve, reject, signal, onAbort: null };

      if (signal) {
        entry.onAbort = () => {
          const index = this.#pending.indexOf(entry);
          if (index === -1) return; // already running: the task handles its own signal
          this.#pending.splice(index, 1);
          this.#notify();
          reject(createAbortError());
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }

      this.#pending.push(entry);
      this.#notify();
      this.#drain();
    });
  }

  #drain() {
    while (this.#active < this.#concurrency && this.#pending.length > 0) {
      const entry = this.#pending.shift();
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
      this.#active++;
      this.#notify();
      this.#run(entry);
    }
  }

  async #run(entry) {
    try {
      entry.resolve(await entry.task(entry.signal));
    } catch (error) {
      entry.reject(error); // a failing task never blocks the queue
    } finally {
      this.#active--;
      this.#notify();
      this.#drain();
    }
  }

  #notify() {
    this.#onChange?.(this.stats);
  }
}
