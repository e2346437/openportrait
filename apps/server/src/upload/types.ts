import type { CameraLogin } from "./accounts.js";

/** What the two protocol servers need from the rest of the app. */
export interface ServerHooks {
  incomingDir: string;
  /** Checks a password for a login. Applies the failed-attempt limit, so callers just report the outcome. */
  authenticate(username: string, password: string, ip: string): Promise<CameraLogin | null>;
  findLogin(username: string): CameraLogin | null;
  /** Records a failed key attempt so repeated guessing gets blocked. */
  authFailed(username: string, ip: string): void;
  blocked(ip: string): boolean;
  land(): { sortByDay: boolean; today: string };
  onFile(login: CameraLogin, info: { name: string; bytes: number; ip: string }): void;
  /** Called on any traffic, so an idle timer knows the server is in use. */
  onActivity(): void;
  log: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void; error(obj: object, msg?: string): void };
}

export interface ProtocolServer {
  start(): Promise<void>;
  /** The port actually bound (differs from the configured one only when that was 0). */
  port(): number;
  stop(): Promise<void>;
  /** Cameras currently connected. */
  connections(): number;
  /** Files currently being received. */
  transfers(): number;
}
