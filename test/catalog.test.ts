import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Catalog, CatalogError } from "../src/catalog/catalog.js";
import { bot, skillMd, writeWorkspace } from "./helpers.js";

async function problems(input: Parameters<typeof writeWorkspace>[0]): Promise<string[]> {
    try {
        await Catalog.load(await writeWorkspace(input));
    } catch (err) {
        if (err instanceof CatalogError) return err.problems;
        throw err;
    }
    return [];
}

describe("Catalog", () => {
    it("loads the example workspace", async () => {
        const c = await Catalog.load(path.join(import.meta.dirname, "..", "workspace"));
        expect([...c.bots.keys()].sort()).toEqual(["concierge", "release-writer", "researcher"]);
        expect(c.skills.get("release-notes")?.directory).toMatch(/skills[/\\]release-notes$/);
        expect(c.connectors.get("github")?.type).toBe("http");
    });

    it("applies defaults", async () => {
        const c = await Catalog.load(await writeWorkspace({ bots: [{ id: "alpha", name: "A", description: "d", instructions: "i" }] }));
        expect(c.bot("alpha")).toMatchObject({ builtinTools: [], skills: [], connectors: [], canMessage: [], access: { users: [], orgs: [] } });
    });

    it("reports dangling references and self-messaging", async () => {
        const p = await problems({ bots: [bot("alpha", { skills: ["nope"], connectors: ["ghost"], canMessage: ["alpha", "missing"] })] });
        expect(p).toEqual([
            "bot 'alpha': unknown skill 'nope'",
            "bot 'alpha': unknown connector 'ghost'",
            "bot 'alpha': cannot list itself in canMessage",
            "bot 'alpha': canMessage references unknown bot 'missing'",
        ]);
    });

    it("rejects unknown fields, bad ids, and file/id mismatches", async () => {
        const p = await problems({
            raw: {
                "bots/x.yaml": "id: Bad_Id\nname: n\ndescription: d\ninstructions: i\n",
                "bots/y.yaml": "id: zed\nname: n\ndescription: d\ninstructions: i\nshell: true\n",
                "bots/w.yaml": "id: other\nname: n\ndescription: d\ninstructions: i\n",
            },
        });
        expect(p.some((m) => m.startsWith("bots/x.yaml: id:"))).toBe(true);
        expect(p.some((m) => m.startsWith("bots/y.yaml") && m.includes("shell"))).toBe(true);
        expect(p).toContain("bots/w.yaml: file name must match id 'other'");
    });

    it("rejects builtin tools outside the allowlist", async () => {
        const p = await problems({ bots: [bot("alpha", { builtinTools: ["bash" as never] })] });
        expect(p[0]).toMatch(/^bots\/alpha.yaml: builtinTools.0:/);
    });

    it("validates skill frontmatter", async () => {
        const p = await problems({
            skills: { good: skillMd("good"), nofront: "# hi\n", mismatch: skillMd("other") },
        });
        expect(p).toEqual([
            "skills/mismatch/SKILL.md: frontmatter name 'other' must match folder 'mismatch'",
            "skills/nofront/SKILL.md: missing YAML frontmatter with name and description",
        ]);
    });

    it("validates connectors", async () => {
        const p = await problems({
            connectors: [
                { id: "ok", description: "d", type: "stdio", command: "node", args: ["server.js"] },
                { id: "bad", description: "d", type: "http", url: "not a url" },
            ],
        });
        expect(p).toHaveLength(1);
        expect(p[0]).toMatch(/^connectors\/bad.yaml: url:/);
    });

    it("saveBot validates against the catalog and writes YAML", async () => {
        const root = await writeWorkspace({ bots: [bot("alpha")] });
        const c = await Catalog.load(root);
        await expect(c.saveBot(bot("beta", { canMessage: ["zzz"] }))).rejects.toThrow(/unknown bot 'zzz'/);

        const { catalog, bot: saved } = await c.saveBot(bot("beta", { canMessage: ["alpha"] }));
        expect(saved.canMessage).toEqual(["alpha"]);
        expect(catalog.bot("beta")).toBeDefined();
        expect(c.bot("beta")).toBeUndefined();
        expect(await readFile(path.join(root, "bots", "beta.yaml"), "utf8")).toContain("canMessage:");
    });
});
