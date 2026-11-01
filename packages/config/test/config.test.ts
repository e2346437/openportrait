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
});
