import { expect, it } from "vitest";
import { taskDisplayIdentifier } from "./taskDisplayIdentifier";

it("shows short sheet task identifiers without mutating the durable source key", () => {
  const task = { identifier: "CHA-20", externalOrigin: "chargespot-design-sheet", externalKey: "sheet:long-stable-key" };
  expect(taskDisplayIdentifier(task)).toBe("CHA-20");
  expect(task.externalKey).toBe("sheet:long-stable-key");
  expect(taskDisplayIdentifier({ ...task, externalOrigin: "jira", externalKey: "ENG-12" })).toBe("ENG-12");
  expect(taskDisplayIdentifier({ ...task, externalOrigin: null, externalKey: null })).toBe("CHA-20");
});
