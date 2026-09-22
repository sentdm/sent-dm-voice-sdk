type Listener = (...args: any[]) => void;

export class TypedEmitter<Events extends { [E in keyof Events]: Listener }> {
  #listeners = new Map<keyof Events, Map<Listener, boolean>>();

  on<E extends keyof Events>(event: E, listener: Events[E]): this {
    return this.#add(event, listener, false);
  }

  once<E extends keyof Events>(event: E, listener: Events[E]): this {
    return this.#add(event, listener, true);
  }

  off<E extends keyof Events>(event: E, listener: Events[E]): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  protected emit<E extends keyof Events>(event: E, ...args: Parameters<Events[E]>): void {
    const listeners = this.#listeners.get(event);
    if (!listeners) return;

    for (const listener of [...listeners.keys()]) {
      const once = listeners.get(listener);
      if (once === undefined) continue;
      if (once) listeners.delete(listener);

      try {
        listener(...args);
      } catch (error) {
        setTimeout(() => {
          throw error;
        });
      }
    }
  }

  #add(event: keyof Events, listener: Listener, once: boolean): this {
    const listeners = this.#listeners.get(event);
    if (!listeners) this.#listeners.set(event, new Map([[listener, once]]));
    else if (!listeners.has(listener)) listeners.set(listener, once);
    return this;
  }
}
