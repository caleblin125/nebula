/**
 * Minimal typed event bus. No DOM types, no framework, no dependencies.
 */

export type EventListener<Payload> = (payload: Payload) => void;

export class EventBus<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<EventListener<never>>>();

  /** Subscribe; the returned function unsubscribes. */
  on<K extends keyof Events>(type: K, listener: EventListener<Events[K]>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as EventListener<never>);
    return () => this.off(type, listener);
  }

  once<K extends keyof Events>(type: K, listener: EventListener<Events[K]>): () => void {
    const unsubscribe = this.on(type, (payload) => {
      unsubscribe();
      listener(payload);
    });
    return unsubscribe;
  }

  off<K extends keyof Events>(type: K, listener: EventListener<Events[K]>): void {
    this.listeners.get(type)?.delete(listener as EventListener<never>);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const listener of [...set]) {
      (listener as EventListener<Events[K]>)(payload);
    }
  }

  clear(): void {
    this.listeners.clear();
  }

  listenerCount(type: keyof Events): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}
