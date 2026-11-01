const FALLBACK = ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London"];

/** Every IANA zone the browser knows, always including UTC, the browser's own zone and any extras (such as the saved value). */
export function allTimezones(...extra: Array<string | undefined>): string[] {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = FALLBACK;
  }
  const missing = ["UTC", browserTimezone(), ...extra].filter((z): z is string => !!z && !zones.includes(z));
  return [...new Set(missing), ...zones];
}

export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function prettyTimezone(tz: string): string {
  try {
    const offset = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value;
    return `${tz.replace(/_/g, " ")}${offset ? ` (${offset})` : ""}`;
  } catch {
    return tz;
  }
}
