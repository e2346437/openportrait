import fs from "node:fs";
import os from "node:os";
import type { AppConfig } from "@openportrait/config";
import type { Settings } from "./settings.js";

/** True when running in a container, where the network interfaces belong to the container and not the host. */
export function inContainer(config?: Pick<AppConfig, "isUnraid">): boolean {
  return Boolean(config?.isUnraid) || fs.existsSync("/.dockerenv");
}

/**
 * Addresses of this machine's own network interfaces. In a container these are the container's private bridge
 * addresses, which no other device on the network can reach, so they're left out.
 */
export function lanAddresses(config?: Pick<AppConfig, "isUnraid">): string[] {
  if (inContainer(config)) return [];
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

export interface LanInfo {
  /** The address to use at home, such as http://192.168.1.20:8090. Null until it has been set. */
  url: string | null;
  source: "settings" | "template" | null;
  /** Just the host part of `url`, for FTP and SFTP settings. */
  host: string | null;
  /** The port inside the container. */
  port: number;
  /** Interface addresses, only when they're real (not inside Docker). */
  addresses: string[];
}

/**
 * Where this server can be reached from the home network. A container can't see its host's address or the
 * port Docker mapped, so this comes from Settings (or the LAN_URL template variable), not from the interfaces.
 */
export function lanInfo(settings: Settings, config: AppConfig): LanInfo {
  const saved = settings.get("internet.lanUrl");
  const url = saved || config.lanUrl || null;
  let host: string | null = null;
  try {
    host = url ? new URL(url).hostname : null;
  } catch {
    host = null;
  }
  return { url, source: saved ? "settings" : config.lanUrl ? "template" : null, host, port: config.port, addresses: lanAddresses(config) };
}

/** Hosts a camera on the home network could use to reach this server, best first. */
export function lanHosts(settings: Settings, config: AppConfig): string[] {
  const info = lanInfo(settings, config);
  return [...new Set([info.host, ...info.addresses].filter((h): h is string => Boolean(h)))];
}

/** A host name that only makes sense on a home network: an IP address, a .local name, or a bare name. */
export function isLocalHostName(host: string): boolean {
  return host === "localhost" || host.endsWith(".local") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || (!host.includes(".") && !host.includes(":"));
}
