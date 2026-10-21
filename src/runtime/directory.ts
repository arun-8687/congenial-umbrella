import { randomBytes } from "node:crypto";
import type { Catalog } from "../catalog/catalog.js";
import { BotSpec, type SkillSpec } from "../catalog/schema.js";
import type { ComputerAccess } from "../engine/policy.js";
import { canUseBot, canUseConnector, type User } from "../identity.js";
import type { Repo } from "./repo.js";

export class DirectoryError extends Error {}

export interface BotEntry {
    bot: BotSpec;
    /** "org" bots come from the workspace; "personal" bots belong to one user. */
    scope: "org" | "personal";
}

/** Resolves which bots, skills and connectors a user can see: org catalog plus their own. */
export class Directory {
    constructor(
        private current: Catalog,
        private readonly repo: Repo,
    ) {}

    get catalog(): Catalog {
        return this.current;
    }

    /** Swaps in a reloaded catalog; in-flight turns keep the one they started with. */
    setCatalog(catalog: Catalog): void {
        this.current = catalog;
    }

    /** Every bot the user can talk to or reach, org bots first. */
    bots(user: Pick<User, "login" | "orgs">, opts: { includeInternal?: boolean } = {}): BotEntry[] {
        const org = [...this.catalog.bots.values()]
            .filter((b) => canUseBot(user, b) && (opts.includeInternal || !b.internal))
            .map((bot) => ({ bot, scope: "org" as const }));
        const mine = this.repo.personalBots(user.login).map((bot) => ({ bot, scope: "personal" as const }));
        return [...org, ...mine];
    }

    bot(user: Pick<User, "login" | "orgs">, id: string, opts: { includeInternal?: boolean } = { includeInternal: true }): BotEntry | undefined {
        return this.bots(user, opts).find((e) => e.bot.id === id);
    }

    /** True when `from` may message or hand work to `to` for this user. */
    canReach(user: Pick<User, "login" | "orgs">, from: BotSpec, toId: string): boolean {
        if (from.id === toId) return false;
        if (!this.bot(user, toId)) return false;
        return from.canMessage.includes("*") || from.canMessage.includes(toId);
    }

    skillsFor(owner: string, bot: BotSpec): SkillSpec[] {
        const out: SkillSpec[] = [];
        for (const name of bot.skills) {
            const org = this.catalog.skills.get(name);
            if (org) {
                out.push(org);
                continue;
            }
            const mine = this.repo.userSkill(owner, name);
            if (mine && mine.status === "published") out.push({ name: mine.name, description: mine.description, markdown: mine.markdown });
        }
        return out;
    }

    /** Validates and stores a personal bot. New bots get a fresh id derived from the name. */
    savePersonalBot(
        user: Pick<User, "login" | "orgs">,
        input: Record<string, unknown>,
        opts: { maxBotsAndGroups: number; computerAccess?: ComputerAccess },
    ): BotSpec {
        const existingId = typeof input.id === "string" ? input.id : undefined;
        const before = existingId ? this.repo.personalBots(user.login).find((b) => b.id === existingId) : undefined;
        let id = existingId;
        if (existingId) {
            if (this.repo.personalBotOwner(existingId) !== user.login) throw new DirectoryError(`bot ${existingId} not found`);
        } else {
            if (this.repo.countBotsAndGroups(user.login) >= opts.maxBotsAndGroups) {
                throw new DirectoryError(`limit of ${opts.maxBotsAndGroups} bots and group chats reached`);
            }
            const slug = String(input.name ?? "bot").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "bot";
            id = `${/^[a-z]/.test(slug) ? slug : `bot-${slug}`}-${randomBytes(2).toString("hex")}`;
        }
        const parsed = BotSpec.safeParse({ ...input, id, access: { users: [user.login], orgs: [] }, internal: false });
        if (!parsed.success) throw new DirectoryError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
        const bot = parsed.data;
        if (this.catalog.bots.has(bot.id)) throw new DirectoryError(`id ${bot.id} is taken`);

        const problems: string[] = [];
        for (const s of bot.skills) if (!this.catalog.skills.has(s) && !this.repo.userSkill(user.login, s)) problems.push(`unknown skill '${s}'`);
        for (const c of bot.connectors) {
            const spec = this.catalog.connectors.get(c);
            if (!spec) problems.push(`unknown connector '${c}'`);
            else if (!canUseConnector(user, spec) && !before?.connectors.includes(c)) problems.push(`you can't use connector '${c}'`);
        }
        if (bot.computer && !before?.computer && (opts.computerAccess ?? "off") === "off") {
            problems.push("the shared computer is turned off on this platform");
        }
        for (const b of bot.canMessage) if (b !== "*" && b !== bot.id && !this.bot(user, b)) problems.push(`unknown bot '${b}'`);
        if (problems.length) throw new DirectoryError(problems.join("; "));

        this.repo.savePersonalBot(user.login, bot);
        return bot;
    }
}
