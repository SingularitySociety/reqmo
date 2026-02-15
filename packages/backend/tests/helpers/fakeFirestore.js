function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class FakeDocSnapshot {
  constructor(id, value) {
    this.id = id;
    this._value = value === undefined ? undefined : clone(value);
  }

  get exists() {
    return this._value !== undefined;
  }

  data() {
    if (this._value === undefined) {
      return undefined;
    }
    return clone(this._value);
  }
}

class FakeQuerySnapshot {
  constructor(docs) {
    this.docs = docs;
  }
}

class FakeDocRef {
  constructor(store, segments) {
    this.store = store;
    this.segments = segments;
  }

  key() {
    return this.segments.join("/");
  }

  async get() {
    const key = this.key();
    const id = this.segments[this.segments.length - 1];
    return new FakeDocSnapshot(id, this.store.docs.get(key));
  }

  async set(value, options = {}) {
    const key = this.key();
    const next = clone(value);

    if (options.merge) {
      const current = this.store.docs.get(key) ?? {};
      this.store.docs.set(key, { ...clone(current), ...next });
      return;
    }

    this.store.docs.set(key, next);
  }

  collection(name) {
    return new FakeCollectionRef(this.store, [...this.segments, name]);
  }
}

class FakeCollectionRef {
  constructor(store, segments) {
    this.store = store;
    this.segments = segments;
  }

  doc(id) {
    return new FakeDocRef(this.store, [...this.segments, id]);
  }

  async get() {
    const prefix = `${this.segments.join("/")}/`;
    const docs = [];

    for (const [key, value] of this.store.docs.entries()) {
      if (!key.startsWith(prefix)) {
        continue;
      }

      const suffix = key.slice(prefix.length);
      if (suffix.includes("/")) {
        continue;
      }

      docs.push(new FakeDocSnapshot(suffix, value));
    }

    docs.sort((a, b) => a.id.localeCompare(b.id));
    return new FakeQuerySnapshot(docs);
  }
}

export class FakeFirestore {
  constructor(initialDocs = {}) {
    this.docs = new Map();
    for (const [key, value] of Object.entries(initialDocs)) {
      this.docs.set(key, clone(value));
    }
  }

  collection(name) {
    return new FakeCollectionRef(this, [name]);
  }

  get(path) {
    const value = this.docs.get(path);
    return value === undefined ? undefined : clone(value);
  }
}
