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
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

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

// Max bytes we keep from the sandbox container's output. Stops a runaway
// build from eating all our memory.
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

// Default + fallback kill timeout: 10 minutes.
const DEFAULT_TIMEOUT_MS = 600_000;

// Strict allow-patterns. Anything outside these is rejected before docker
// ever runs. This blocks shell-injection tricks like `; rm -rf /` smuggled
// in through env vars or caller options.
const NETWORK_MODE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const MEMORY_RE = /^\d+[mMgG]$/;
const CPU_RE = /^\d+(\.\d+)?$/;
const IMAGE_RE = /^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*(:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127})?$/;
const WORKTREE_PATH_RE = /^[A-Za-z0-9_.\/-]+$/;
const USER_RE = /^[a-z_][a-z0-9_-]*[$]?$|^\d+$/;

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

    // Never run the sandbox as root: a root process inside the container plus
    // docker access = easy host takeover. Default to the 'node' user.
    const sandboxUser =
      this.configService.get<string>('SANDBOX_USER', 'node').trim() || 'node';
    if (sandboxUser === 'root' || sandboxUser === '0') {
      throw new Error(
        'SANDBOX_USER must not be root/0. Use the unprivileged "node" user.',
      );
    }
    if (!USER_RE.test(sandboxUser)) {
      throw new Error(`Invalid SANDBOX_USER: ${sandboxUser}`);
    }

    // Kill the container if it runs too long (hanging npm install, etc).
    const rawTimeout = this.configService.get<string>(
      'SANDBOX_TIMEOUT_MS',
      String(DEFAULT_TIMEOUT_MS),
    );
    let timeoutMs = parseInt(rawTimeout, 10);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      timeoutMs = DEFAULT_TIMEOUT_MS;
    }

    // Validate every value that ends up on the docker command line.
    this.validateOption('networkMode', networkMode, NETWORK_MODE_RE);
    this.validateOption('memoryLimit', memoryLimit, MEMORY_RE);
    this.validateOption('cpuLimit', cpuLimit, CPU_RE);
    this.validateOption('image', image, IMAGE_RE);
    if (
      !command ||
      typeof command !== 'string' ||
      command.trim().length === 0 ||
      command.includes('\0') ||
      command.length > 8000
    ) {
      throw new Error('Invalid sandbox command: must be non-empty text.');
    }
    if (!WORKTREE_PATH_RE.test(worktreePath) || worktreePath.includes('..')) {
      throw new Error(`Invalid worktreePath: ${worktreePath}`);
    }
    if (!path.isAbsolute(worktreePath)) {
      throw new Error(`worktreePath must be absolute: ${worktreePath}`);
    }

    const isInsideDocker = fs.existsSync('/.dockerenv');

    // When running inside Docker, make sure the worktree lives under our
    // shared volume dir. This stops a caller from mounting any host path
    // (like /etc) into the sandbox container.
    if (isInsideDocker) {
      const base =
        this.configService.get<string>(
          'WORKTREE_BASE_PATH',
          '/app/worktrees',
        ) ?? '/app/worktrees';
      const resolvedBase = path.resolve(base);
      const resolvedWorktree = path.resolve(worktreePath);
      if (
        resolvedWorktree !== resolvedBase &&
        !resolvedWorktree.startsWith(resolvedBase + path.sep)
      ) {
        throw new Error(
          `worktreePath must be inside WORKTREE_BASE_PATH (${resolvedBase})`,
        );
      }
    }

    // Build the docker command as a list of separate words (argv). We run it
    // with shell:false so the OS never interprets special characters — a `;`
    // or `$()` in any value stays plain text instead of running extra commands.
    const argv: string[] = [
      'run',
      '--rm',
      `--network=${networkMode}`,
      `--memory=${memoryLimit}`,
      `--cpus=${cpuLimit}`,
      `--user=${sandboxUser}`,
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
    ];

    if (isInsideDocker) {
      const containerName = this.configService.get<string>(
        'LAZYDEV_CONTAINER_NAME',
        'lazydev-app',
      );
      if (!NETWORK_MODE_RE.test(containerName)) {
        throw new Error(`Invalid LAZYDEV_CONTAINER_NAME: ${containerName}`);
      }
      argv.push('--volumes-from', containerName);
    } else {
      // Local dev: bind-mount the worktree path directly into the container.
      argv.push('-v', `${worktreePath}:${worktreePath}`);
    }

    argv.push('-w', worktreePath, image, 'sh', '-c', command);

    this.logger.debug(
      `Executing sandbox command (argv form): docker ${argv.join(' ')}`,
    );

    const startTime = Date.now();

    return await new Promise<SandboxExecutionResult>((resolve, reject) => {
      const child = spawn('docker', argv, { shell: false });

      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdout = '';
      let stderr = '';
      let truncated = false;

      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        const err = new Error(
          `Sandbox execution timed out after ${timeoutMs}ms and was killed.`,
        );
        this.logger.error(err.message);
        reject(err);
      }, timeoutMs);
      // Don't let the timer alone keep the Node process alive.
      killTimer.unref?.();

      const append = (chunk: Buffer, kind: 'stdout' | 'stderr') => {
        const text = chunk.toString('utf8');
        if (kind === 'stdout') {
          if (stdoutBytes + text.length > MAX_OUTPUT_BYTES) {
            const room = MAX_OUTPUT_BYTES - stdoutBytes;
            if (room > 0) stdout += text.slice(0, room);
            stdoutBytes = MAX_OUTPUT_BYTES;
            truncated = true;
          } else {
            stdout += text;
            stdoutBytes += text.length;
          }
        } else {
          if (stderrBytes + text.length > MAX_OUTPUT_BYTES) {
            const room = MAX_OUTPUT_BYTES - stderrBytes;
            if (room > 0) stderr += text.slice(0, room);
            stderrBytes = MAX_OUTPUT_BYTES;
            truncated = true;
          } else {
            stderr += text;
            stderrBytes += text.length;
          }
        }
        // Output blew past the 5MB cap: stop the runaway container now.
        if (
          stdoutBytes >= MAX_OUTPUT_BYTES &&
          stderrBytes >= MAX_OUTPUT_BYTES
        ) {
          child.kill('SIGKILL');
        } else if (
          (kind === 'stdout' && stdoutBytes >= MAX_OUTPUT_BYTES) ||
          (kind === 'stderr' && stderrBytes >= MAX_OUTPUT_BYTES)
        ) {
          // Keep the process running but stop collecting — cap memory use.
        }
      };

      child.stdout?.on('data', (c: Buffer) => append(c, 'stdout'));
      child.stderr?.on('data', (c: Buffer) => append(c, 'stderr'));
      child.on('error', (err) => {
        clearTimeout(killTimer);
        this.logger.error(`Sandbox execution failed: ${err.message}`);
        reject(new Error(`Sandbox execution failed: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(killTimer);
        const durationMs = Date.now() - startTime;
        if (truncated) {
          stderr += '\n[truncated: output exceeded 5MB cap]';
        }
        if (code === 0) {
          resolve({ stdout, stderr, durationMs });
        } else {
          const msg = stderr || `docker exited with code ${code}`;
          this.logger.error(`Sandbox execution failed: ${msg}`);
          reject(new Error(`Sandbox execution failed: ${msg}`));
        }
      });
    });
  }

  private validateOption(name: string, value: string, re: RegExp): void {
    if (typeof value !== 'string' || !re.test(value)) {
      throw new Error(`Invalid sandbox ${name}: ${value}`);
    }
  }
}
