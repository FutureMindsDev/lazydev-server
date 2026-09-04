/* eslint-disable */
import * as crypto from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { LlmConfigService } from './llm-config.service';
import {
  decryptSecret,
  encryptSecret,
  LlmConfigCryptoError,
  resolveMasterKey,
} from './llm-config-crypto';
import { LlmConfig } from './entities/llm-config.entity';

/**
 * In-memory Repository<LlmConfig> stand-in. Scopes rows exactly like the
 * service expects: installationId number, or null for the global row
 * (persisted via TypeORM's IsNull() — the mock normalizes that to null).
 */
function mockRepo() {
  const rows = new Map<number | 'global', LlmConfig>();
  const keyOf = (installationId: unknown): number | 'global' =>
    typeof installationId === 'number' ? installationId : 'global';

  return {
    rows,
    findOne: jest.fn(async ({ where }: any) => {
      const key = keyOf(where.installationId);
      return rows.get(key) ?? null;
    }),
    create: jest.fn((partial: any) => ({
      ...partial,
      apiKeyEncrypted: null,
      apiKeyHint: null,
      baseUrl: null,
      model: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...partial,
    })),
    save: jest.fn(async (row: any) => {
      const key = keyOf(row.installationId);
      const saved = { ...row, updatedAt: new Date() };
      rows.set(key, saved as LlmConfig);
      return saved;
    }),
    remove: jest.fn(async (row: any) => {
      rows.delete(keyOf(row.installationId));
      return row;
    }),
  };
}

const masterKeyB64 = () => crypto.randomBytes(32).toString('base64');

/** Minimal mock for LlmProviderConfigService — the config service delegates
 * provider listing/decryption to it. Most tests don't use provider configs,
 * so the mock returns empty lists / null by default. */
function mockProviderConfigService() {
  return {
    listForScope: jest.fn(async () => []),
    findById: jest.fn(async () => null),
    toResolved: jest.fn(() => null),
    toMasked: jest.fn((row: any) => ({
      id: row.id,
      label: row.label,
      baseUrl: row.baseUrl,
      model: row.model,
      apiKeyHint: row.apiKeyHint,
      updatedAt: row.updatedAt?.toISOString?.() ?? new Date().toISOString(),
    })),
  };
}

const makeService = (repo: ReturnType<typeof mockRepo>, key?: string) =>
  new LlmConfigService(
    repo as any,
    { get: (_k: string) => key } as any,
    mockProviderConfigService() as any,
  );

describe('llm-config-crypto', () => {
  it('round-trips a secret through the v1 envelope', () => {
    const key = resolveMasterKey(masterKeyB64());
    const stored = encryptSecret('sk-or-v1-abc123', key);
    expect(stored.startsWith('v1:')).toBe(true);
    expect(decryptSecret(stored, key)).toBe('sk-or-v1-abc123');
  });

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    const key = resolveMasterKey(masterKeyB64());
    const stored = encryptSecret('secret', key);
    const parts = stored.split(':');
    const tampered = [
      parts[0],
      parts[1],
      parts[2],
      Buffer.from('not-the-ciphertext').toString('base64'),
    ].join(':');
    expect(() => decryptSecret(tampered, key)).toThrow(LlmConfigCryptoError);
  });

  it('fails on a wrong master key instead of returning garbage', () => {
    const stored = encryptSecret('secret', resolveMasterKey(masterKeyB64()));
    expect(() =>
      decryptSecret(stored, resolveMasterKey(masterKeyB64())),
    ).toThrow(LlmConfigCryptoError);
  });

  it('rejects missing or wrong-length master keys', () => {
    expect(() => resolveMasterKey(undefined)).toThrow(LlmConfigCryptoError);
    expect(() => resolveMasterKey('')).toThrow(LlmConfigCryptoError);
    expect(() => resolveMasterKey('too-short')).toThrow(LlmConfigCryptoError);
  });

  it('accepts both base64 and hex 32-byte keys', () => {
    expect(resolveMasterKey(crypto.randomBytes(32).toString('base64')).length).toBe(32);
    expect(resolveMasterKey(crypto.randomBytes(32).toString('hex')).length).toBe(32);
  });
});

describe('LlmConfigService', () => {
  it('requires apiKey + model when creating a config', async () => {
    const repo = mockRepo();
    const svc = makeService(repo, masterKeyB64());

    await expect(svc.upsertConfig({ model: 'glm-5.3' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(svc.upsertConfig({ apiKey: 'sk-x' })).rejects.toThrow(
      BadRequestException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('rejects writes with no fields at all', async () => {
    const svc = makeService(mockRepo(), masterKeyB64());
    await expect(svc.upsertConfig({})).rejects.toThrow(BadRequestException);
  });

  it('rejects an invalid baseUrl', async () => {
    const svc = makeService(mockRepo(), masterKeyB64());
    await expect(
      svc.upsertConfig({
        apiKey: 'sk-x',
        model: 'glm-5.3',
        baseUrl: 'not-a-url',
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      svc.upsertConfig({
        apiKey: 'sk-x',
        model: 'glm-5.3',
        baseUrl: 'ftp://example.com',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects writes when no master key is configured (with instructions)', async () => {
    const svc = makeService(mockRepo(), undefined);
    try {
      await svc.upsertConfig({
        apiKey: 'sk-x',
        model: 'glm-5.3',
      });
      fail('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect(e.message).toContain('LLM_CONFIG_ENCRYPTION_KEY');
      expect(e.message).toContain('openssl rand -base64 32');
    }
  });

  it('allows override/baseUrl/model-only updates without a master key', async () => {
    // Set up a config WITH a master key, then rotate to a process with no key.
    // Updates that don't touch the encrypted apiKey column must still work.
    const repo = mockRepo();
    const key = masterKeyB64();
    const bootSvc = makeService(repo, key);
    await bootSvc.upsertConfig({
      apiKey: 'sk-x',
      model: 'shared',
      agentModelOverrides: { planner: 'strong' },
    });

    const noKeySvc = makeService(repo, undefined);
    // Override-only update.
    const masked = await noKeySvc.upsertConfig({
      agentModelOverrides: { planner: 'stronger', onboarding: 'cheap' },
    });
    expect(masked.agentModelOverrides).toEqual({
      planner: 'stronger',
      onboarding: 'cheap',
    });
    // Model-only update.
    const masked2 = await noKeySvc.upsertConfig({ model: 'new-shared' });
    expect(masked2.model).toBe('new-shared');
    // Clearing overrides.
    const masked3 = await noKeySvc.upsertConfig({ agentModelOverrides: null });
    expect(masked3.agentModelOverrides).toBeNull();

    // But an apiKey update still requires the master key.
    await expect(
      noKeySvc.upsertConfig({ apiKey: 'sk-rotated' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('encrypts the key at rest and stores only a 4-char hint', async () => {
    const repo = mockRepo();
    const key = masterKeyB64();
    const svc = makeService(repo, key);

    const masked = await svc.upsertConfig({
      installationId: 42,
      apiKey: 'sk-or-v1-supersecret',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'qwen/qwen2.5-coder-32b-instruct',
    });

    // Masked view never contains the key.
    expect(masked.configured).toBe(true);
    expect(masked.scope).toBe('installation');
    expect(masked.apiKeyHint).toBe('cret');
    expect(JSON.stringify(masked)).not.toContain('supersecret');

    // Row contains only the encrypted envelope.
    const row = repo.rows.get(42)!;
    expect(row.apiKeyEncrypted!.startsWith('v1:')).toBe(true);
    expect(row.apiKeyEncrypted).not.toContain('supersecret');
    expect(decryptSecret(row.apiKeyEncrypted!, resolveMasterKey(key))).toBe(
      'sk-or-v1-supersecret',
    );
  });

  it('partial update keeps the stored key when apiKey is omitted', async () => {
    const repo = mockRepo();
    const key = masterKeyB64();
    const svc = makeService(repo, key);

    await svc.upsertConfig({
      installationId: 42,
      apiKey: 'sk-first',
      model: 'old-model',
    });
    const before = repo.rows.get(42)!.apiKeyEncrypted;

    await svc.upsertConfig({ installationId: 42, model: 'new-model' });
    const row = repo.rows.get(42)!;
    expect(row.model).toBe('new-model');
    expect(row.apiKeyEncrypted).toBe(before);
  });

  it('resolves installation row → global row → null, synchronously after priming', async () => {
    const key = masterKeyB64();
    const repo = mockRepo();
    const svc = makeService(repo, key);

    // Nothing primed → env fallback.
    expect(svc.getResolvedConfig(42)).toBeNull();

    // Only a global row exists.
    await svc.upsertConfig({
      apiKey: 'sk-global',
      baseUrl: 'https://api.z.ai/api/paas/v4',
      model: 'glm-5.3',
    });
    // upsert re-primes the written scope (global).
    expect(svc.getResolvedConfig(42)?.scope).toBe('global');
    expect(svc.getResolvedConfig(null)?.scope).toBe('global');

    // An installation row now wins for that installation.
    await svc.upsertConfig({
      installationId: 42,
      apiKey: 'sk-install',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'kimi-k3',
    });
    expect(svc.getResolvedConfig(42)?.scope).toBe('installation');
    expect(svc.getResolvedConfig(42)?.model).toBe('kimi-k3');
    // Other installations still fall through to global.
    expect(svc.getResolvedConfig(99)?.scope).toBe('global');

    // Explicit priming (as runPipeline does) refreshes from the DB.
    await svc.loadForInstallation(99);
    expect(svc.getResolvedConfig(99)?.scope).toBe('global');
  });

  it('treats an undecryptable row as absent (wrong master key after rotation)', async () => {
    const oldKey = masterKeyB64();
    const repo = mockRepo();
    const oldSvc = makeService(repo, oldKey);
    await oldSvc.upsertConfig({
      installationId: 7,
      apiKey: 'sk-legacy',
      model: 'glm-4.5-air',
    });

    // New process with a rotated key: load must not throw, resolution is
    // null (env fallback) rather than a pipeline-killing decrypt error.
    const newSvc = makeService(repo, masterKeyB64());
    await expect(newSvc.loadForInstallation(7)).resolves.toBeUndefined();
    expect(newSvc.getResolvedConfig(7)).toBeNull();
  });

  it('deleteConfig removes the row and un-primes the scope', async () => {
    const repo = mockRepo();
    const svc = makeService(repo, masterKeyB64());
    await svc.upsertConfig({
      installationId: 42,
      apiKey: 'sk-x',
      model: 'glm-5.3',
    });
    expect(svc.getResolvedConfig(42)).not.toBeNull();

    expect(await svc.deleteConfig(42)).toBe(true);
    expect(svc.getResolvedConfig(42)).toBeNull();
    expect(await svc.deleteConfig(42)).toBe(false); // idempotent
    expect(repo.rows.has(42)).toBe(false);
  });

  it('getMaskedInfo prefers the installation row, then the global row', async () => {
    const repo = mockRepo();
    const svc = makeService(repo, masterKeyB64());

    const none = await svc.getMaskedInfo(42);
    expect(none.configured).toBe(false);
    expect(none.scope).toBeNull();

    await svc.upsertConfig({
      apiKey: 'sk-global',
      baseUrl: 'https://api.x.ai/v1',
      model: 'grok-4.6',
    });
    const viaGlobal = await svc.getMaskedInfo(42);
    expect(viaGlobal.configured).toBe(true);
    expect(viaGlobal.scope).toBe('global');
    expect(viaGlobal.model).toBe('grok-4.6');
    expect(viaGlobal.apiKeyHint).toBe('obal'); // last 4 chars of 'sk-global'

    await svc.upsertConfig({
      installationId: 42,
      apiKey: 'sk-install',
      model: 'glm-5.3',
    });
    const exact = await svc.getMaskedInfo(42);
    expect(exact.scope).toBe('installation');
    expect(exact.model).toBe('glm-5.3');
  });

  // ── Per-agent model overrides ──────────────────────────────────────────

  it('stores and returns agentModelOverrides', async () => {
    const repo = mockRepo();
    const svc = makeService(repo, masterKeyB64());

    const masked = await svc.upsertConfig({
      apiKey: 'sk-x',
      model: 'shared-model',
      agentModelOverrides: { planner: 'strong-model', patch_generator: 'strong-model' },
    });
    expect(masked.agentModelOverrides).toEqual({
      planner: 'strong-model',
      patch_generator: 'strong-model',
    });

    // Resolved config carries the overrides too.
    const resolved = svc.getResolvedConfig(null);
    expect(resolved?.agentModelOverrides).toEqual({
      planner: 'strong-model',
      patch_generator: 'strong-model',
    });
  });

  it('drops unknown agent role keys from overrides', async () => {
    const svc = makeService(mockRepo(), masterKeyB64());
    const masked = await svc.upsertConfig({
      apiKey: 'sk-x',
      model: 'shared',
      agentModelOverrides: {
        planner: 'good',
        unknown_role: 'dropped',
        validation: 'also-good',
      },
    });
    expect(masked.agentModelOverrides).toEqual({
      planner: 'good',
      validation: 'also-good',
    });
  });

  it('clears agentModelOverrides when null is passed', async () => {
    const repo = mockRepo();
    const svc = makeService(repo, masterKeyB64());

    await svc.upsertConfig({
      apiKey: 'sk-x',
      model: 'shared',
      agentModelOverrides: { planner: 'strong' },
    });
    expect(repo.rows.get('global')!.agentModelOverrides).toEqual({ planner: 'strong' });

    await svc.upsertConfig({ agentModelOverrides: null });
    expect(repo.rows.get('global')!.agentModelOverrides).toBeNull();
  });

  it('partial update leaves agentModelOverrides unchanged when omitted', async () => {
    const repo = mockRepo();
    const svc = makeService(repo, masterKeyB64());

    await svc.upsertConfig({
      apiKey: 'sk-x',
      model: 'shared',
      agentModelOverrides: { planner: 'strong' },
    });
    // Update only the model — overrides should be untouched.
    await svc.upsertConfig({ model: 'new-shared' });
    expect(repo.rows.get('global')!.agentModelOverrides).toEqual({ planner: 'strong' });
  });

  it('accepts agentModelOverrides alone (no other fields)', async () => {
    const repo = mockRepo();
    const svc = makeService(repo, masterKeyB64());

    // Create a config first.
    await svc.upsertConfig({ apiKey: 'sk-x', model: 'shared' });
    // Then set overrides only.
    const masked = await svc.upsertConfig({
      agentModelOverrides: { planner: 'strong', onboarding: 'cheap' },
    });
    expect(masked.agentModelOverrides).toEqual({ planner: 'strong', onboarding: 'cheap' });
    expect(masked.model).toBe('shared'); // unchanged
  });
});
