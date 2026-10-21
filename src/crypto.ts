import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * AES-256-GCM sealing for secrets at rest (GitHub tokens, connector credentials). New data is sealed
 * with the first key; older keys still open data sealed before a rotation.
 */
export class Sealer {
    private readonly keys: Buffer[];

    constructor(key: Buffer, ...previous: Buffer[]) {
        for (const k of [key, ...previous]) if (k.length !== 32) throw new Error("secret keys must be 32 bytes (base64)");
        this.keys = [key, ...previous];
    }

    /**
     * Uses SECRET_KEY (base64, 32 bytes) when set; otherwise creates `<stateDir>/secret.key` (mode
     * 0600) on first run. SECRET_KEY_PREVIOUS keeps data sealed with the old key readable during a
     * rotation; run `copilot-bots rotate-key` to re-seal everything, then drop it.
     */
    static fromEnvOrFile(envValue: string | undefined, stateDir: string, previous?: string): Sealer {
        const prev = previous ? [Buffer.from(previous, "base64")] : [];
        if (envValue) return new Sealer(Buffer.from(envValue, "base64"), ...prev);
        secureDir(stateDir);
        const file = path.join(stateDir, "secret.key");
        if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
        if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
            chmodSync(file, 0o600);
            console.warn(`${file} was readable by other users; permissions reset to 0600`);
        }
        return new Sealer(Buffer.from(readFileSync(file, "utf8").trim(), "base64"), ...prev);
    }

    seal(plaintext: string): string {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.keys[0]!, iv);
        const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
    }

    open(sealed: string): string {
        const raw = Buffer.from(sealed, "base64");
        let lastError: unknown;
        for (const key of this.keys) {
            try {
                const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
                decipher.setAuthTag(raw.subarray(12, 28));
                return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError instanceof Error ? lastError : new Error("could not open sealed value");
    }

    /** Re-seals with the current key; returns undefined when it already is. */
    reseal(sealed: string): string | undefined {
        const plaintext = this.open(sealed);
        try {
            const raw = Buffer.from(sealed, "base64");
            const d = createDecipheriv("aes-256-gcm", this.keys[0]!, raw.subarray(0, 12));
            d.setAuthTag(raw.subarray(12, 28));
            d.update(raw.subarray(28));
            d.final();
            return undefined;
        } catch {
            return this.seal(plaintext);
        }
    }
}

/** Creates a directory readable only by the platform's OS user (conversations, keys, uploads live here). */
export function secureDir(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32" && (statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
