import type { AppEvent, EventPublisher } from "../domain/types.js";

export type EventListener = (event: AppEvent) => void;
export type Unsubscribe = () => void;

export class EventBus implements EventPublisher {
  readonly #listeners = new Set<EventListener>();

  publish(event: AppEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  subscribe(listener: EventListener): Unsubscribe {
    this.#listeners.add(listener);
    let subscribed = true;

    return () => {
      if (!subscribed) {
        return;
      }

      subscribed = false;
      this.#listeners.delete(listener);
    };
  }
}
