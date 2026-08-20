import { createHash } from "node:crypto";

import {
  PREVIEW_SCHEMA_VERSION,
  previewEnvelopeId,
  type PreviewEnvelope,
} from "@cosmaneura-scribe/capture-preview-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cosmos = vi.hoisted(() => {
  const read = vi.fn();
  const item = vi.fn(() => ({ read }));
  return {
    item,
    read,
    container: {
      item,
      items: { create: vi.fn() },
      read: vi.fn(),
    },
  };
});

vi.mock("@azure/cosmos", () => ({
  CosmosClient: class {
    public database() {
      return { container: () => cosmos.container };
    }
  },
}));

vi.mock("@azure/identity", () => ({
  ManagedIdentityCredential: class {},
}));

import { CosmosPreviewRepository } from "./cosmos-repository";

const SCOPE_ID = "a".repeat(64);
const OBJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("CosmosPreviewRepository envelope reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes only Cosmos system metadata before strict envelope validation", async () => {
    const envelope = previewEnvelope();
    cosmos.read.mockResolvedValue({
      resource: {
        ...envelope,
        _rid: "synthetic-rid",
        _self: "dbs/synthetic/colls/synthetic/docs/synthetic/",
        _etag: '"synthetic-etag"',
        _attachments: "attachments/",
        _ts: 1_755_648_000,
      },
    });

    const repository = new CosmosPreviewRepository(configuration());

    await expect(repository.readEnvelope(SCOPE_ID, OBJECT_ID)).resolves.toEqual(envelope);
    expect(cosmos.item).toHaveBeenCalledWith(previewEnvelopeId(OBJECT_ID), SCOPE_ID);
  });

  it("continues to reject non-Cosmos fields", async () => {
    cosmos.read.mockResolvedValue({
      resource: {
        ...previewEnvelope(),
        unexpected: "must-not-cross-the-adapter",
        _etag: '"synthetic-etag"',
      },
    });

    const repository = new CosmosPreviewRepository(configuration());

    await expect(repository.readEnvelope(SCOPE_ID, OBJECT_ID)).rejects.toThrow(
      "stored preview envelope is invalid",
    );
  });
});

function configuration() {
  return {
    endpoint: "https://synthetic-preview.documents.azure.com/",
    databaseId: "capture-preview",
    containerId: "workflow-state",
    managedIdentityClientId: "22222222-2222-4222-8222-222222222222",
  };
}

function previewEnvelope(): PreviewEnvelope {
  const bytes = Buffer.from([1, 2, 3, 4]);
  return {
    id: previewEnvelopeId(OBJECT_ID),
    scopeId: SCOPE_ID,
    kind: "capture-preview-envelope",
    schemaVersion: PREVIEW_SCHEMA_VERSION,
    ttl: 3_600,
    objectId: OBJECT_ID,
    bytesBase64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    uploadedAt: "2026-08-20T00:00:00.000Z",
  };
}
