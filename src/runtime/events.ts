import type { Approval, Message, Notification, Task, Thread } from "./repo.js";

export type BotStatus = "idle" | "working" | "waiting";

/** Everything the UI hears about, per user, over the SSE stream. */
export type HubEvent =
    | { type: "thread.updated"; thread: Thread }
    | { type: "thread.deleted"; threadId: string }
    | { type: "message.created"; message: Message; streamId?: string }
    | { type: "message.delta"; threadId: string; botId: string; streamId: string; text: string; channel: "text" | "reasoning" }
    | { type: "message.tool"; threadId: string; botId: string; streamId: string; tool: string; phase: "start" | "complete"; success?: boolean; detail?: string }
    | { type: "bot.status"; botId: string; threadId: string | null; status: BotStatus }
    | { type: "approval.created"; approval: Approval }
    | { type: "approval.decided"; approval: Approval }
    | { type: "task.updated"; task: Task }
    | { type: "routine.run"; routineId: string; runId: string; status: string }
    | { type: "notification"; notification: Notification }
    | { type: "bots.changed" };

type Listener = (event: HubEvent) => void;

export class Hub {
    private readonly listeners = new Map<string, Set<Listener>>();

    subscribe(owner: string, listener: Listener): () => void {
        let set = this.listeners.get(owner);
        if (!set) this.listeners.set(owner, (set = new Set()));
        set.add(listener);
        return () => {
            set!.delete(listener);
            if (set!.size === 0) this.listeners.delete(owner);
        };
    }

    publish(owner: string, event: HubEvent): void {
        for (const l of this.listeners.get(owner) ?? []) {
            try {
                l(event);
            } catch (err) {
                console.error("hub listener failed:", err);
            }
        }
    }

    connected(owner: string): boolean {
        return (this.listeners.get(owner)?.size ?? 0) > 0;
    }
}
