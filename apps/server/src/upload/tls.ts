import fs from "node:fs";
import path from "node:path";
import { generate } from "selfsigned";

export interface FtpsCert {
  cert: string;
  key: string;
}

const CERT = "ftps-cert.pem";
const KEY = "ftps-key.pem";

/**
 * The certificate cameras see for FTPS. It's self-signed and created on first use, because a home server has no
 * public name to get a trusted certificate for. A camera that checks certificates needs this file loaded as a
 * trusted (root) certificate; the settings page offers it for download.
 */
export async function ensureFtpsCert(configDir: string, hosts: string[]): Promise<FtpsCert> {
  const certFile = path.join(configDir, CERT);
  const keyFile = path.join(configDir, KEY);
  const wanted = [...new Set(["openportrait", "localhost", ...hosts.filter(Boolean)])];
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const cert = fs.readFileSync(certFile, "utf8");
    const key = fs.readFileSync(keyFile, "utf8");
    const names = cert.match(/^# names: (.*)$/m)?.[1]?.split(",") ?? [];
    if (wanted.every((h) => names.includes(h))) return { cert, key };
  }
  const isIp = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
  const notAfterDate = new Date(Date.now() + 10 * 365 * 86_400_000);
  const pems = await generate([{ name: "commonName", value: "OpenPortrait camera upload" }], {
    algorithm: "sha256",
    keySize: 2048,
    notBeforeDate: new Date(Date.now() - 86_400_000),
    notAfterDate,
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: wanted.map((h) => (isIp(h) ? { type: 7 as const, ip: h } : { type: 2 as const, value: h })) },
    ],
  });
  const cert = `# names: ${wanted.join(",")}\n${pems.cert}`;
  fs.writeFileSync(certFile, cert, { mode: 0o644 });
  fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
  return { cert, key: pems.private };
}

export function readFtpsCert(configDir: string): string | null {
  try {
    return fs.readFileSync(path.join(configDir, CERT), "utf8");
  } catch {
    return null;
  }
}
