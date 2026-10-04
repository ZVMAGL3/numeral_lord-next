import { describe, expect, it } from "vitest";
import { shouldConnectWorkshopOnStartup } from "./workshop-startup.js";

describe("workshop startup connection", () => {
  it("loads the remote catalog on a direct workshop route even with no subscriptions", () => {
    expect(shouldConnectWorkshopOnStartup(true)).toBe(true);
  });

  it("checks subscribed updates when entering the battle lobby", () => {
    expect(shouldConnectWorkshopOnStartup(false, true)).toBe(true);
  });

  it("loads the Workshop catalog when a saved map needs Mod artwork", () => {
    expect(shouldConnectWorkshopOnStartup(false, false, true)).toBe(true);
  });

  it("does not open a workshop connection on unrelated pages", () => {
    expect(shouldConnectWorkshopOnStartup(false)).toBe(false);
    expect(shouldConnectWorkshopOnStartup(false, false)).toBe(false);
    expect(shouldConnectWorkshopOnStartup(false, false, false)).toBe(false);
  });
});
