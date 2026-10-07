import type { Task } from "./types";

export function taskDisplayIdentifier(task: Pick<Task, "identifier" | "externalOrigin" | "externalKey">): string {
  return task.externalOrigin === "chargespot-design-sheet"
    ? task.identifier : task.externalKey ?? task.identifier;
}
