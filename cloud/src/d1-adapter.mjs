export function createD1Adapter(d1) {
  const bind = (statement, params = []) => (params.length ? statement.bind(...params) : statement);
  return {
    async get(sql, params = []) {
      return (await bind(d1.prepare(sql), params).first()) ?? null;
    },
    async all(sql, params = []) {
      const result = await bind(d1.prepare(sql), params).all();
      return result.results ?? [];
    },
    async run(sql, params = []) {
      return bind(d1.prepare(sql), params).run();
    },
    // One D1 batch is one subrequest and runs as a single transaction.
    async batch(statements) {
      if (!statements.length) return [];
      return d1.batch(statements.map(([sql, params = []]) => bind(d1.prepare(sql), params)));
    },
  };
}

export function createR2Blobs(bucket) {
  return {
    async get(id) {
      const object = await bucket.get(id);
      if (!object) return null;
      return new Uint8Array(await object.arrayBuffer());
    },
    async put(id, bytes) {
      if (!bytes || bytes.byteLength === 0) {
        await bucket.delete(id);
        return;
      }
      await bucket.put(id, bytes);
    },
    async delete(id) {
      await bucket.delete(id);
    },
  };
}
