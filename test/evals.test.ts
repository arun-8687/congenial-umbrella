import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Catalog } from "../src/catalog/catalog.js";
import { checkExpectations, loadEvals, runEvals, toJUnit } from "../src/evals.js";
import { alice, bot, FakeEngine, writeWorkspace } from "./helpers.js";

const EVALS = `
bot: reviewer
cases:
  - name: mentions retries
    prompt: Review the retry change
    expect: { contains: [retry], notContains: [LGTM], matches: ["/^review/i"], tools: [list_bots], maxToolCalls: 1 }
  - name: asks before running commands
    prompt: run the tests
    expect: { asksApproval: true, contains: [skipped] }
  - name: runs commands when approved
    prompt: run the tests
    approve: true
    expect: { contains: [ran] }
  - name: deliberately failing
    prompt: anything
    expect: { contains: [never-there], noTools: [list_bots] }
`;

async function workspace(evals = EVALS) {
    const root = await writeWorkspace({
        bots: [bot("reviewer", { computer: true, canMessage: ["*"], access: { users: [], orgs: ["somewhere-else"] } })],
        raw: { "evals/reviewer.yaml": evals },
    });
    return { root, catalog: await Catalog.load(root) };
}

const engine = () =>
    new FakeEngine({
        reviewer: async (req, tool) => {
            if (req.prompt.includes("run the tests")) {
                const v = await req.decidePermission({ kind: "shell", detail: "$ npm test" });
                return v.decision === "approve" ? "ran the tests" : "skipped: not approved";
            }
            await tool("list_bots", {});
            return "Review: the retry loop looks right.";
        },
    });

describe("bot evals", () => {
    it("validates eval files against the catalog", async () => {
        const { root, catalog } = await workspace();
        expect((await loadEvals(root, catalog)).problems).toEqual([]);
        const bad = await workspace("bot: nobody\ncases:\n  - name: x\n    prompt: y\n    expect: { matches: ['(unclosed'], typo: 1 }\n");
        const { problems } = await loadEvals(bad.root, bad.catalog);
        expect(problems.join("\n")).toMatch(/Unrecognized key/);
        const unknown = await workspace("bot: nobody\ncases:\n  - name: x\n    prompt: y\n");
        expect((await loadEvals(unknown.root, unknown.catalog)).problems).toEqual(["evals/reviewer.yaml: unknown bot 'nobody'"]);
    });

    it("runs each case in a fresh thread, answers approvals as told, and reports failures", async () => {
        const { root, catalog } = await workspace();
        const { suites } = await loadEvals(root, catalog);
        // The reviewer is restricted to another org: evals test behaviour, not access.
        const results = await runEvals({ catalog, engine: engine(), suites, user: alice, computerAccess: "shell", turnTimeoutMs: 5_000 });
        const byName = Object.fromEntries(results[0]!.cases.map((c) => [c.name, c]));
        expect(byName["mentions retries"]).toMatchObject({ ok: true, tools: ["list_bots"] });
        expect(byName["asks before running commands"]).toMatchObject({ ok: true, approvals: 1 });
        expect(byName["runs commands when approved"]).toMatchObject({ ok: true, approvals: 1 });
        expect(byName["deliberately failing"]!.ok).toBe(false);
        expect(byName["deliberately failing"]!.failures).toEqual(['reply should contain "never-there"', "should not use tool list_bots"]);

        const xml = toJUnit(results);
        expect(xml).toMatch(/<testsuites name="bot evals" tests="4" failures="1">/);
        expect(xml).toContain('<failure message="reply should contain &quot;never-there&quot;">');
    });

    it("filters cases by name", async () => {
        const { root, catalog } = await workspace();
        const { suites } = await loadEvals(root, catalog);
        const results = await runEvals({ catalog, engine: engine(), suites, user: alice, computerAccess: "shell", filter: "retries" });
        expect(results[0]!.cases.map((c) => c.name)).toEqual(["mentions retries"]);
    });

    it("checks each kind of expectation", () => {
        const e = { contains: ["A"], notContains: ["b"], matches: ["\\d+"], tools: ["web_*"], noTools: ["bash"], asksApproval: false, maxToolCalls: 1 };
        expect(checkExpectations(e, { reply: "a 42", tools: ["web_fetch"], approvals: 0 })).toEqual([]);
        expect(checkExpectations(e, { reply: "B", tools: ["bash", "x"], approvals: 2 })).toHaveLength(7);
    });

    it("ships valid example evals for the example workspace", async () => {
        const root = path.join(import.meta.dirname, "..", "workspace");
        const { suites, problems } = await loadEvals(root, await Catalog.load(root));
        expect(problems).toEqual([]);
        expect(suites.length).toBeGreaterThan(0);
        expect(await readFile(path.join(root, "evals", "concierge.yaml"), "utf8")).toContain("copilot-bots eval");
    });
});
