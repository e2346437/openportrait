import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/index.js";

describe("loadConfig", () => {
  it("uses container paths by default", () => {
    const c = loadConfig({});
    expect(c.port).toBe(8080);
    expect(c.configDir).toBe("/config");
    expect(c.galleriesDir).toBe("/galleries");
    expect(c.incomingDir).toBe("/incoming");
    expect(c.cacheDir).toBe("/cache");
    expect(c.appUrl).toBe("");
  });

  it("trims a trailing slash from APP_URL", () => {
    expect(loadConfig({ APP_URL: "https://studio.example.com/" }).appUrl).toBe("https://studio.example.com");
  });

  it("explains a bad APP_URL", () => {
    expect(() => loadConfig({ APP_URL: "studio.example.com" })).toThrow(/full URL/);
  });

  it("rejects a bad port", () => {
    expect(() => loadConfig({ PORT: "eighty" })).toThrow(/PORT/);
  });

  it("detects Unraid", () => {
    expect(loadConfig({ OPENPORTRAIT_PLATFORM: "unraid" }).isUnraid).toBe(true);
  });

  it("has camera upload defaults: SFTP, on demand, and the documented ports", () => {
    const c = loadConfig({});
    expect([c.sftpPort, c.ftpPort, c.ftpPassiveMin, c.ftpPassiveMax]).toEqual([2222, 2121, 30000, 30009]);
    expect(c.uploadProtocol).toBe("sftp");
    expect(c.uploadAccessMode).toBe("on_demand");
  });

  it("accepts template overrides for the upload protocol and mode", () => {
    const c = loadConfig({ UPLOAD_PROTOCOL: "FTP", UPLOAD_ACCESS_MODE: "scheduled" });
    expect(c.uploadProtocol).toBe("ftp");
    expect(c.uploadAccessMode).toBe("scheduled");
    expect(() => loadConfig({ UPLOAD_PROTOCOL: "telnet" })).toThrow(/UPLOAD_PROTOCOL/);
    expect(() => loadConfig({ SFTP_PORT: "22" })).toThrow(/SFTP_PORT/);
  });

  it("reads the home network address and rejects a bare IP", () => {
    expect(loadConfig({ LAN_URL: "http://192.168.1.20:8090/" }).lanUrl).toBe("http://192.168.1.20:8090");
    expect(loadConfig({}).lanUrl).toBe("");
    expect(() => loadConfig({ LAN_URL: "192.168.1.20:8090" })).toThrow(/LAN_URL/);
  });
});
