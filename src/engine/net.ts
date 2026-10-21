import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Server-side request forgery guard for bot web access. Bots' web_fetch runs on the platform host,
 * so without this anyone could have a bot read cloud metadata (169.254.169.254) or internal services.
 * Resolution here can't stop DNS rebinding between our check and the runtime's fetch; deployments
 * that need a hard guarantee should also restrict egress at the network layer.
 */
export async function blockedUrlReason(url: string | undefined, resolve: typeof lookup = lookup): Promise<string | undefined> {
    let parsed: URL;
    try {
        parsed = new URL(url ?? "");
    } catch {
        return "the URL could not be parsed";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return `${parsed.protocol} URLs are not allowed`;
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
        return `${host} is an internal address`;
    }
    const addresses = isIP(host) ? [host] : await resolve(host, { all: true }).then((r) => r.map((a) => a.address), () => []);
    if (addresses.length === 0) return undefined; // unresolvable: the fetch will fail on its own
    const bad = addresses.find(isPrivateAddress);
    return bad ? `${host} resolves to a private or internal address (${bad})` : undefined;
}

export function isPrivateAddress(ip: string): boolean {
    if (isIP(ip) === 4) {
        const [a, b] = ip.split(".").map(Number) as [number, number];
        return (
            a === 0 || a === 10 || a === 127 ||
            (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
            (a === 169 && b === 254) || // link-local, cloud metadata
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 198 && (b === 18 || b === 19)) ||
            a >= 224
        );
    }
    const v6 = ip.toLowerCase();
    if (v6 === "::" || v6 === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb") || v6.startsWith("ff");
}
