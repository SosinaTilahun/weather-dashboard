// Keeps one AbortController per "slot" (for example the main city search).
// Starting a new request in a slot cancels the previous one, so a slow, stale response
// can never overwrite the result of a newer search.

export class RequestManager {
  #controllers = new Map();

  /** Cancel whatever is running in `key`, then return a fresh controller for the new request. */
  start(key) {
    this.#controllers.get(key)?.abort();
    const controller = new AbortController();
    this.#controllers.set(key, controller);
    return controller;
  }

  /** Cancel the request in `key` (used by the Cancel button). Returns true if there was one. */
  cancel(key) {
    const controller = this.#controllers.get(key);
    if (!controller) return false;
    controller.abort();
    this.#controllers.delete(key);
    return true;
  }

  /** True while `controller` is still the newest request for `key`. */
  isCurrent(key, controller) {
    return this.#controllers.get(key) === controller;
  }

  /** Release the controller once its request has settled (only if it is still the current one). */
  finish(key, controller) {
    if (this.#controllers.get(key) === controller) this.#controllers.delete(key);
  }

  has(key) {
    return this.#controllers.has(key);
  }
}
