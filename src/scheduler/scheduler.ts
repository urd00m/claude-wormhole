import { schedule, validate, type ScheduledTask } from "node-cron";
import type { CronEntry, CronStore } from "./store.js";

export type FireHandler = (entry: CronEntry) => Promise<void>;

export class Scheduler {
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly store: CronStore;
  private readonly onFire: FireHandler;

  constructor(store: CronStore, onFire: FireHandler) {
    this.store = store;
    this.onFire = onFire;
  }

  /** Start all stored crons. Call once at boot. */
  start(): void {
    for (const entry of this.store.list()) {
      this.registerTask(entry);
    }
  }

  /** Validate and add a new cron; persist; activate. */
  add(input: Omit<CronEntry, "id" | "createdAt"> & { id?: string }): CronEntry {
    if (!validate(input.expression)) {
      throw new Error(`invalid cron expression: ${input.expression}`);
    }
    const entry = this.store.add(input);
    this.registerTask(entry);
    return entry;
  }

  /** Stop and remove a cron by id. */
  remove(id: string): boolean {
    const task = this.tasks.get(id);
    if (task) {
      void task.stop();
      void task.destroy();
      this.tasks.delete(id);
    }
    return this.store.remove(id);
  }

  list(): CronEntry[] {
    return this.store.list();
  }

  /** Next run time for a given cron, if active. */
  nextRun(id: string): Date | null {
    return this.tasks.get(id)?.getNextRun() ?? null;
  }

  /** Stop everything. Call on shutdown. */
  stopAll(): void {
    for (const task of this.tasks.values()) {
      void task.stop();
      void task.destroy();
    }
    this.tasks.clear();
  }

  private registerTask(entry: CronEntry): void {
    if (this.tasks.has(entry.id)) return;
    const task = schedule(
      entry.expression,
      async () => {
        try {
          await this.onFire(entry);
        } catch (err) {
          console.error(`[cron] handler error for ${entry.id}:`, err);
        }
      },
      { timezone: entry.timezone, name: entry.id },
    );
    this.tasks.set(entry.id, task);
  }
}
