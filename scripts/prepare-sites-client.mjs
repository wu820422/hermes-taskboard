import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve("dist", "web");
const destination = resolve("dist", "client");
const migrationsSource = resolve("cloud", "migrations");
const migrationsDestination = resolve("dist", ".openai", "drizzle");

await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
await rm(migrationsDestination, { recursive: true, force: true });
await cp(migrationsSource, migrationsDestination, { recursive: true });
