/**
 * Copyright (c) 2026 FutureMindsDev. All rights reserved.
 *
 * LazyDev™ is a trademark of FutureMindsDev.
 * Organization : https://github.com/FutureMindsDev
 *
 * Authors:
 *   Arkar Chan Myae  <https://github.com/arkar-chanmyae>
 *   Khin Me Me Latt  <https://github.com/KhinMeMeLatt>
 *
 * Licensed under the MIT License.
 * See LICENSE file in the project root for full license information.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LockService } from './lock.service';

const mockRedisInstance = {
  scan: jest.fn().mockResolvedValue(['0', []]),
  del: jest.fn().mockResolvedValue(0),
};
jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => mockRedisInstance),
);

const mockRedlockInstance = {
  acquire: jest.fn().mockResolvedValue({ resources: ['lock:test'] }),
  extend: jest.fn(),
  release: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
};
jest.mock('redlock', () =>
  jest.fn().mockImplementation(() => mockRedlockInstance),
);

/**
 * Regression coverage for a startup race: on a fresh container start with a
 * job already queued in Redis (e.g. a retried job surviving a rebuild),
 * BullMQ's Worker can start processing it the instant IssueProcessor is
 * instantiated — there's no guarantee Nest runs LockService's onModuleInit
 * first. Redlock previously wasn't built until onModuleInit, so `acquire()`
 * called before that ran threw "Cannot read properties of undefined (reading
 * 'acquire')".
 */
describe('LockService — startup race with BullMQ Worker', () => {
  let service: LockService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // acquire() starts a real setInterval heartbeat; fake timers keep it from
    // holding the Jest process open when a test doesn't call release().
    jest.useFakeTimers();
    mockRedisInstance.scan.mockResolvedValue(['0', []]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LockService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((_: string, def: unknown) => def) },
        },
      ],
    }).compile();

    service = module.get(LockService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('can acquire a lock immediately after construction, before onModuleInit ever runs', async () => {
    // Deliberately not calling `service.onModuleInit()` here — this is the
    // exact ordering that caused the crash in production.
    const acquired = await service.acquireIssueLock('acme', 'widgets', 70);
    const resources = (acquired.lock as { resources: string[] }).resources;
    expect(resources).toEqual(['lock:test']);
  });

  it('can acquire repo and branch locks before onModuleInit too', async () => {
    await expect(
      service.acquireRepoLock('acme', 'widgets'),
    ).resolves.toBeDefined();
    await expect(
      service.acquireBranchLock('acme', 'widgets', 'lazydev/fix-70'),
    ).resolves.toBeDefined();
  });

  it('still clears stale locks on onModuleInit as before', async () => {
    mockRedisInstance.scan.mockResolvedValue([
      '0',
      ['lock:issue:acme/widgets:70'],
    ]);

    await service.onModuleInit();

    expect(mockRedisInstance.del).toHaveBeenCalledWith(
      'lock:issue:acme/widgets:70',
    );
  });

  it('release does not throw even if called on a lock acquired pre-onModuleInit', async () => {
    const acquired = await service.acquireIssueLock('acme', 'widgets', 70);
    await expect(service.release(acquired)).resolves.toBeUndefined();
  });
});
