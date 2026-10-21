import { describe, expect, it } from "vitest";
import { blockedUrlReason, isPrivateAddress } from "../src/engine/net.js";

const fakeDns = (map: Record<string, string[]>) =>
    (async (host: string) => (map[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))) as never;

describe("SSRF guard", () => {
    it("classifies private, loopback, link-local and metadata addresses", () => {
        for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
            expect(isPrivateAddress(ip), ip).toBe(true);
        }
        for (const ip of ["8.8.8.8", "140.82.112.3", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
    });

    it("blocks internal hosts, IP literals and names that resolve inward", async () => {
        const dns = fakeDns({ "docs.github.com": ["185.199.108.153"], "sneaky.example": ["10.0.0.5"], "mixed.example": ["8.8.8.8", "127.0.0.1"] });
        expect(await blockedUrlReason("https://docs.github.com/en", dns)).toBeUndefined();
        expect(await blockedUrlReason("http://169.254.169.254/latest/meta-data", dns)).toMatch(/private or internal/);
        expect(await blockedUrlReason("http://[::1]:8080/", dns)).toMatch(/private or internal/);
        expect(await blockedUrlReason("http://localhost:3000", dns)).toMatch(/internal address/);
        expect(await blockedUrlReason("http://metadata.google.internal/", dns)).toMatch(/internal address/);
        expect(await blockedUrlReason("https://sneaky.example/", dns)).toMatch(/10\.0\.0\.5/);
        expect(await blockedUrlReason("https://mixed.example/", dns)).toMatch(/127\.0\.0\.1/);
        expect(await blockedUrlReason("file:///etc/passwd", dns)).toMatch(/not allowed/);
    });
});
