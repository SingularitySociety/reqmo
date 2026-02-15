import test from "node:test";
import assert from "node:assert/strict";

import { createRepositoryFromEnv } from "../src/repository/factory.js";
import { FirestoreRepository } from "../src/repository/firestoreRepository.js";
import { InMemoryRepository } from "../src/repository/inMemoryRepository.js";
import { FakeFirestore } from "./helpers/fakeFirestore.js";

test("repository factory returns InMemoryRepository for local development", async () => {
  const repository = await createRepositoryFromEnv({
    adapter: "memory"
  });

  assert.ok(repository instanceof InMemoryRepository);
});

test("repository factory returns FirestoreRepository when requested", async () => {
  const repository = await createRepositoryFromEnv({
    adapter: "firestore",
    tenantId: "tenant_factory",
    firestore: new FakeFirestore()
  });

  assert.ok(repository instanceof FirestoreRepository);
  assert.equal(repository.tenantId, "tenant_factory");
});
