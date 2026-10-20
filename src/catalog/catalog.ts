import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { BotSpec, ConnectorSpec, SkillFrontmatter, type SkillSpec } from "./schema.js";

export class CatalogError extends Error {
    constructor(readonly problems: string[]) {
        super(`Invalid catalog:\n  - ${problems.join("\n  - ")}`);
        this.name = "CatalogError";
    }
}

/**
 * Bots, connectors and skills loaded from a workspace directory:
 *
 *     <root>/bots/*.yaml
 *     <root>/connectors/*.yaml
 *     <root>/skills/<name>/SKILL.md
 *
 * A catalog is immutable; reloading builds a new one, so in-flight turns keep a consistent view.
 */
export class Catalog {
    private constructor(
        readonly root: string,
        readonly bots: ReadonlyMap<string, BotSpec>,
        readonly connectors: ReadonlyMap<string, ConnectorSpec>,
        readonly skills: ReadonlyMap<string, SkillSpec>,
    ) {}

    static async load(root: string): Promise<Catalog> {
        const problems: string[] = [];
        const bots = await loadYamlDir(path.join(root, "bots"), BotSpec, problems);
        const connectors = await loadYamlDir(path.join(root, "connectors"), ConnectorSpec, problems);
        const skills = await loadSkills(path.join(root, "skills"), problems);
        problems.push(...crossReferenceProblems(bots, connectors, skills));
        if (problems.length > 0) throw new CatalogError(problems);
        return new Catalog(path.resolve(root), bots, connectors, skills);
    }

    bot(id: string): BotSpec | undefined {
        return this.bots.get(id);
    }

    /**
     * Validates `input` against the schema and the rest of the catalog, then writes it to
     * `bots/<id>.yaml`. Returns the reloaded catalog; the receiver is left untouched.
     */
    async saveBot(input: unknown): Promise<{ catalog: Catalog; bot: BotSpec }> {
        const parsed = BotSpec.safeParse(input);
        if (!parsed.success) throw new CatalogError(zodProblems("bot", parsed.error));
        const bot = parsed.data;
        const bots = new Map(this.bots).set(bot.id, bot);
        const problems = crossReferenceProblems(bots, this.connectors, this.skills);
        if (problems.length > 0) throw new CatalogError(problems);

        const dir = path.join(this.root, "bots");
        await mkdir(dir, { recursive: true });
        const file = path.join(dir, `${bot.id}.yaml`);
        const tmp = `${file}.tmp-${process.pid}`;
        await writeFile(tmp, YAML.stringify(bot), "utf8");
        await rename(tmp, file);
        return { catalog: await Catalog.load(this.root), bot };
    }
}

async function loadYamlDir<S extends z.ZodType<{ id: string }>>(
    dir: string,
    schema: S,
    problems: string[],
): Promise<Map<string, z.infer<S>>> {
    const out = new Map<string, z.infer<S>>();
    if (!existsSync(dir)) return out;
    const files = (await readdir(dir)).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
    for (const file of files) {
        const where = path.join(path.basename(dir), file);
        let raw: unknown;
        try {
            raw = YAML.parse(await readFile(path.join(dir, file), "utf8"));
        } catch (err) {
            problems.push(`${where}: ${(err as Error).message}`);
            continue;
        }
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
            problems.push(...zodProblems(where, parsed.error));
            continue;
        }
        const id = parsed.data.id;
        const stem = file.replace(/\.ya?ml$/, "");
        if (stem !== id) problems.push(`${where}: file name must match id '${id}'`);
        if (out.has(id)) problems.push(`${where}: duplicate id '${id}'`);
        out.set(id, parsed.data);
    }
    return out;
}

async function loadSkills(dir: string, problems: string[]): Promise<Map<string, SkillSpec>> {
    const out = new Map<string, SkillSpec>();
    if (!existsSync(dir)) return out;
    const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory());
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const where = path.join("skills", entry.name, "SKILL.md");
        const file = path.join(dir, entry.name, "SKILL.md");
        if (!existsSync(file)) {
            problems.push(`${where}: missing`);
            continue;
        }
        const markdown = await readFile(file, "utf8");
        const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
        if (!match) {
            problems.push(`${where}: missing YAML frontmatter with name and description`);
            continue;
        }
        let front: unknown;
        try {
            front = YAML.parse(match[1] ?? "");
        } catch (err) {
            problems.push(`${where}: ${(err as Error).message}`);
            continue;
        }
        const parsed = SkillFrontmatter.safeParse(front);
        if (!parsed.success) {
            problems.push(...zodProblems(where, parsed.error));
            continue;
        }
        if (parsed.data.name !== entry.name) {
            problems.push(`${where}: frontmatter name '${parsed.data.name}' must match folder '${entry.name}'`);
            continue;
        }
        out.set(entry.name, {
            name: parsed.data.name,
            description: parsed.data.description,
            markdown,
            directory: path.resolve(dir, entry.name),
        });
    }
    return out;
}

function crossReferenceProblems(
    bots: ReadonlyMap<string, BotSpec>,
    connectors: ReadonlyMap<string, ConnectorSpec>,
    skills: ReadonlyMap<string, SkillSpec>,
): string[] {
    const problems: string[] = [];
    for (const bot of bots.values()) {
        for (const s of bot.skills) if (!skills.has(s)) problems.push(`bot '${bot.id}': unknown skill '${s}'`);
        for (const c of bot.connectors) if (!connectors.has(c)) problems.push(`bot '${bot.id}': unknown connector '${c}'`);
        for (const b of bot.canMessage) {
            if (b === "*") continue;
            if (b === bot.id) problems.push(`bot '${bot.id}': cannot list itself in canMessage`);
            else if (!bots.has(b)) problems.push(`bot '${bot.id}': canMessage references unknown bot '${b}'`);
        }
    }
    return problems;
}

function zodProblems(where: string, error: z.ZodError): string[] {
    return error.issues.map((i) => `${where}: ${i.path.length ? i.path.join(".") + ": " : ""}${i.message}`);
}
