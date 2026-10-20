import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** AES-256-GCM sealing for secrets at rest (connector credentials, web-session tokens). */
export class Sealer {
    private readonly key: Buffer;

    constructor(key: Buffer) {
        if (key.length !== 32) throw new Error("secret key must be 32 bytes");
        this.key = key;
    }

    /**
     * Uses SECRET_KEY (base64, 32 bytes) when set; otherwise creates `<stateDir>/secret.key`
     * with mode 0600 on first run. Production deployments should set SECRET_KEY from a vault.
     */
    static fromEnvOrFile(envValue: string | undefined, stateDir: string): Sealer {
        if (envValue) return new Sealer(Buffer.from(envValue, "base64"));
        const file = path.join(stateDir, "secret.key");
        if (!existsSync(file)) {
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
        }
        return new Sealer(Buffer.from(readFileSync(file, "utf8").trim(), "base64"));
    }

    seal(plaintext: string): string {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, iv);
        const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
    }

    open(sealed: string): string {
        const raw = Buffer.from(sealed, "base64");
        const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    }
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
