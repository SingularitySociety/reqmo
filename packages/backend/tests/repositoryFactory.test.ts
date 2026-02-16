import test from "node:test";
import assert from "node:assert/strict";

import { createRepositoryFromEnv } from "../src/repository/factory.ts";
import { FirestoreRepository } from "../src/repository/firestoreRepository.ts";
import { InMemoryRepository } from "../src/repository/inMemoryRepository.ts";
import { FakeFirestore } from "./helpers/fakeFirestore.ts";

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
