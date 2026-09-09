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

/* eslint-disable */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface SandboxExecutionOptions {
  worktreePath: string;
  command: string;
  image?: string;
  memoryLimit?: string;
  cpuLimit?: string;
}

export interface SandboxExecutionResult {
  stdout: string;
  stderr: string;
  durationMs: number;
}

@Injectable()
export class SandboxService {
  private readonly logger = new Logger(SandboxService.name);

  constructor(private readonly configService: ConfigService) {}

  async executeCommand(
    options: SandboxExecutionOptions,
  ): Promise<SandboxExecutionResult> {
    const {
      worktreePath,
      command,
      image = 'node:20-alpine',
      memoryLimit = '512m',
      cpuLimit = '1.0',
    } = options;

    const networkMode = this.configService.get<string>(
      'SANDBOX_NETWORK_MODE',
      'bridge',
    );

    // Detect whether the app is running inside a Docker container.
    // When running locally (npm run start:dev), use a plain -v bind mount —
    // Docker Desktop on Mac can access the host filesystem directly.
    // When running inside Docker, use --volumes-from so the sandbox sibling
    // container can access paths inside the named 'worktrees' volume.
    const isInsideDocker = require('fs').existsSync('/.dockerenv');

    let volumeArg: string;
    if (isInsideDocker) {
      const containerName = this.configService.get<string>(
        'LAZYDEV_CONTAINER_NAME',
        'lazydev-app',
      );
      volumeArg = `--volumes-from ${containerName}`;
    } else {
      // Local dev: bind-mount the worktree path directly into the container
      volumeArg = `-v "${worktreePath}:${worktreePath}"`;
    }

    const dockerCommand = [
      'docker',
      'run',
      '--rm',
      `--network=${networkMode}`,
      `--memory=${memoryLimit}`,
      `--cpus=${cpuLimit}`,
      volumeArg,
      `-w "${worktreePath}"`,
      image,
      'sh',
      '-c',
      `"${command}"`,
    ].join(' ');

    this.logger.debug(`Executing sandbox command: ${dockerCommand}`);

    const startTime = Date.now();
    let stdout = '';
    let stderr = '';

    try {
      const result = await execAsync(dockerCommand);
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error: any) {
      stdout = error.stdout || '';
      stderr = error.stderr || error.message;

      this.logger.error(`Sandbox execution failed: ${stderr}`);
      throw new Error(`Sandbox execution failed: ${stderr}`);
    }

    const durationMs = Date.now() - startTime;

    return {
      stdout,
      stderr,
      durationMs,
    };
  }
}
