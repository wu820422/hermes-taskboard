export function memoryBlobs() {
  const map = new Map();
  return {
    async get(id) {
      return map.has(id) ? map.get(id) : null;
    },
    async put(id, bytes) {
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (data.byteLength === 0) {
        map.delete(id);
        return;
      }
      map.set(id, data);
    },
    async delete(id) {
      map.delete(id);
    },
  };
}
