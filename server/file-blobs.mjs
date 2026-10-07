import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export function createFileBlobs(directory) {
  return {
    async get(id) {
      try {
        return await readFile(path.join(directory, id));
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },
    async put(id, bytes) {
      await mkdir(directory, { recursive: true });
      const target = path.join(directory, id);
      if (!bytes || bytes.byteLength === 0) {
        await unlink(target).catch(() => {});
        return;
      }
      await writeFile(target, bytes, { mode: 0o600 });
    },
    async delete(id) {
      await unlink(path.join(directory, id)).catch(() => {});
    },
  };
}
