import { CosmosClient, type Container } from "@azure/cosmos";
import { ManagedIdentityCredential } from "@azure/identity";
import {
  PreviewRepositoryConflictError,
  previewEnvelopeId,
  validatePreviewEnvelope,
  validatePreviewScopeState,
  type PreviewEnvelope,
  type PreviewRepository,
  type PreviewScopeState,
  type VersionedScopeState,
} from "@cosmaneura-scribe/capture-preview-domain";

interface CosmosResource {
  readonly _etag?: string;
}

interface BootstrapBudget extends CosmosResource {
  readonly id: string;
  readonly scopeId: "capture-preview-global";
  readonly kind: "capture-preview-bootstrap-budget";
  readonly schemaVersion: 1;
  readonly ttl: 172800;
  readonly bucketId: string;
  readonly count: number;
}

const MAX_CONDITIONAL_RETRIES = 8;

export interface CosmosPreviewRepositoryOptions {
  readonly endpoint: string;
  readonly databaseId: string;
  readonly containerId: string;
  readonly managedIdentityClientId: string;
}

export class CosmosPreviewRepository implements PreviewRepository {
  readonly #container: Container;

  public constructor(options: CosmosPreviewRepositoryOptions) {
    const credential = new ManagedIdentityCredential(options.managedIdentityClientId);
    const client = new CosmosClient({
      endpoint: options.endpoint,
      aadCredentials: credential,
      consistencyLevel: "Session",
      userAgentSuffix: "cosmaneura-synthetic-capture-preview/1.0",
    });
    this.#container = client.database(options.databaseId).container(options.containerId);
  }

  public async health(): Promise<void> {
    await this.#container.read();
  }

  public async claimBootstrapSlot(bucketId: string, maximum: number): Promise<boolean> {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(bucketId) || !Number.isSafeInteger(maximum) || maximum < 1) {
      throw new Error("preview bootstrap budget is invalid");
    }
    const id = `capture-preview-bootstrap:${bucketId}`;
    for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
      let current: BootstrapBudget | null = null;
      try {
        const response = await this.#container
          .item(id, "capture-preview-global")
          .read<BootstrapBudget>();
        if (response.resource !== undefined) {
          current = validateBootstrapBudget(response.resource, id, bucketId);
        }
      } catch (error) {
        if (cosmosStatus(error) !== 404) throw error;
      }
      if (current === null) {
        try {
          await this.#container.items.create({
            id,
            scopeId: "capture-preview-global",
            kind: "capture-preview-bootstrap-budget",
            schemaVersion: 1,
            ttl: 172800,
            bucketId,
            count: 1,
          } satisfies BootstrapBudget);
          return true;
        } catch (error) {
          if (cosmosStatus(error) !== 409) throw error;
          continue;
        }
      }
      if (current.count >= maximum) return false;
      const etag = current._etag;
      if (etag === undefined) throw new Error("Cosmos bootstrap budget omitted ETag");
      try {
        await this.#container.item(id, "capture-preview-global").replace(
          { ...stripBudgetMetadata(current), count: current.count + 1 },
          { accessCondition: { type: "IfMatch", condition: etag } },
        );
        return true;
      } catch (error) {
        if (cosmosStatus(error) !== 409 && cosmosStatus(error) !== 412) throw error;
      }
    }
    throw new PreviewRepositoryConflictError();
  }

  public async readScope(scopeId: string): Promise<VersionedScopeState | null> {
    try {
      const response = await this.#container.item("capture-preview-state", scopeId).read<
        PreviewScopeState & CosmosResource
      >();
      if (response.resource === undefined) return null;
      const etag = response.resource._etag;
      if (etag === undefined) throw new Error("Cosmos state response omitted ETag");
      return {
        state: validatePreviewScopeState(stripCosmosMetadata(response.resource), scopeId),
        etag,
      };
    } catch (error) {
      if (cosmosStatus(error) === 404) return null;
      throw error;
    }
  }

  public async createScope(state: PreviewScopeState): Promise<void> {
    try {
      await this.#container.items.create(state, { disableAutomaticIdGeneration: true });
    } catch (error) {
      if (cosmosStatus(error) === 409) throw new PreviewRepositoryConflictError();
      throw error;
    }
  }

  public async replaceScope(
    state: PreviewScopeState,
    expectedEtag: string,
  ): Promise<void> {
    try {
      await this.#container.item(state.id, state.scopeId).replace(state, {
        accessCondition: { type: "IfMatch", condition: expectedEtag },
      });
    } catch (error) {
      if (cosmosStatus(error) === 409 || cosmosStatus(error) === 412) {
        throw new PreviewRepositoryConflictError();
      }
      throw error;
    }
  }

  public async readEnvelope(
    scopeId: string,
    objectId: string,
  ): Promise<PreviewEnvelope | null> {
    try {
      const response = await this.#container
        .item(previewEnvelopeId(objectId), scopeId)
        .read<PreviewEnvelope & CosmosResource>();
      return response.resource === undefined
        ? null
        : validatePreviewEnvelope(
            stripCosmosMetadata(response.resource),
            scopeId,
            objectId,
          );
    } catch (error) {
      if (cosmosStatus(error) === 404) return null;
      throw error;
    }
  }

  public async createEnvelope(envelope: PreviewEnvelope): Promise<void> {
    try {
      await this.#container.items.create(envelope, { disableAutomaticIdGeneration: true });
    } catch (error) {
      if (cosmosStatus(error) === 409) throw new PreviewRepositoryConflictError();
      throw error;
    }
  }

  public async deleteEnvelope(scopeId: string, objectId: string): Promise<void> {
    try {
      await this.#container.item(previewEnvelopeId(objectId), scopeId).delete();
    } catch (error) {
      if (cosmosStatus(error) === 404) return;
      throw error;
    }
  }
}

function stripCosmosMetadata<T extends object>(resource: T & CosmosResource): T {
  const clone = structuredClone(resource) as T & Record<string, unknown>;
  delete clone._etag;
  delete clone._rid;
  delete clone._self;
  delete clone._attachments;
  delete clone._ts;
  return clone;
}

function cosmosStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function validateBootstrapBudget(
  value: BootstrapBudget,
  expectedId: string,
  expectedBucketId: string,
): BootstrapBudget {
  if (
    value.id !== expectedId ||
    value.scopeId !== "capture-preview-global" ||
    value.kind !== "capture-preview-bootstrap-budget" ||
    value.schemaVersion !== 1 ||
    value.ttl !== 172800 ||
    value.bucketId !== expectedBucketId ||
    !Number.isSafeInteger(value.count) ||
    value.count < 1 ||
    value.count > 10_000
  ) {
    throw new Error("stored preview bootstrap budget is invalid");
  }
  return value;
}

function stripBudgetMetadata(value: BootstrapBudget): Omit<BootstrapBudget, "_etag"> {
  const clone = structuredClone(value) as unknown as Record<string, unknown>;
  delete clone._etag;
  delete clone._rid;
  delete clone._self;
  delete clone._attachments;
  delete clone._ts;
  return clone as unknown as Omit<BootstrapBudget, "_etag">;
}
