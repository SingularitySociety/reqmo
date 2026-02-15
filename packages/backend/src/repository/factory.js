import { FirestoreRepository } from "./firestoreRepository.js";
import { InMemoryRepository } from "./inMemoryRepository.js";

export async function createRepositoryFromEnv({
  adapter = process.env.REPOSITORY_ADAPTER ?? "memory",
  tenantId = process.env.REQMO_TENANT_ID ?? "tenant_default",
  firestore
} = {}) {
  const normalized = String(adapter || "memory").toLowerCase();

  if (normalized === "firestore") {
    return FirestoreRepository.create({ firestore, tenantId });
  }

  return new InMemoryRepository();
}
