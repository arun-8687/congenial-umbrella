import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Auditor, MemoryAuditSink } from "../../src/audit.js";
import { Catalog } from "../../src/catalog/catalog.js";
import { Sealer } from "../../src/crypto.js";
import { CopilotEngine } from "../../src/engine/copilot.js";
import { Directory } from "../../src/runtime/directory.js";
import { Hub, type HubEvent } from "../../src/runtime/events.js";
import { Repo } from "../../src/runtime/repo.js";
import { DEFAULT_RUNTIME_OPTIONS, Runtime, type RuntimeOptions } from "../../src/runtime/runtime.js";
import { Db } from "../../src/store/db.js";
import { alice, writeWorkspace, type WorkspaceInput } from "../helpers.js";
import { FakeModel } from "./fake-model.js";

/**
 * The platform with the real Copilot runtime (the bundled binary, spawned as a child process) and
 * a scripted model behind a BYOK provider. Only the model is fake.
 */
export async function realRuntime(input: WorkspaceInput, opts: Partial<RuntimeOptions> = {}) {
    const model = new FakeModel();
    const baseUrl = await model.start();
    const state = await mkdtemp(path.join(tmpdir(), "real-rt-"));
    const engine = new CopilotEngine({
        baseDirectory: path.join(state, "copilot"),
        defaultModel: "gpt-4o",
        provider: { type: "openai", baseUrl, apiKey: "fake-key" },
        logLevel: "error",
    });
    await engine.start();
    const catalog = await Catalog.load(await writeWorkspace(input));
    const repo = new Repo(new Db(":memory:"));
    const sink = new MemoryAuditSink();
    const hub = new Hub();
    const events: HubEvent[] = [];
    hub.subscribe(alice.login, (e) => events.push(e));
    const runtime = new Runtime(repo, new Directory(catalog, repo), engine, hub, new Auditor(sink), new Sealer(Buffer.alloc(32, 3)), {
        ...DEFAULT_RUNTIME_OPTIONS,
        computersDir: path.join(state, "computers"),
        uploadsDir: path.join(state, "uploads"),
        ...opts,
    });
    runtime.rememberUser(alice);
    runtime.start();
    return {
        model,
        engine,
        runtime,
        repo,
        sink,
        events,
        state,
        async close() {
            await runtime.stop();
            await engine.stop();
            await model.stop();
        },
    };
}
