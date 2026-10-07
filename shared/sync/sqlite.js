// Node 22.16 made DatabaseSync.isTransaction a read-only getter. Track
// nesting on the side so sync can keep using BEGIN/COMMIT on 22.14 and 22.23.
const transactionDepth = new WeakMap();

export function createSqliteAdapter(database) {
  return {
    async get(sql, params = []) {
      return database.prepare(sql).get(...params) ?? null;
    },
    async all(sql, params = []) {
      return database.prepare(sql).all(...params);
    },
    async run(sql, params = []) {
      return database.prepare(sql).run(...params);
    },
    async transaction(fn) {
      const depth = transactionDepth.get(database) ?? 0;
      if (depth > 0) return fn();
      database.exec("BEGIN IMMEDIATE");
      transactionDepth.set(database, depth + 1);
      try {
        const result = await fn();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* already closed */ }
        throw error;
      } finally {
        transactionDepth.set(database, 0);
      }
    },
  };
}
