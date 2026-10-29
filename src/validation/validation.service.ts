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
import { SandboxService } from '../sandbox/sandbox.service';
import { LanguageDetector, ProjectLanguage } from './language-detector';

export interface ValidationResult {
  success: boolean;
  language: ProjectLanguage;
  stdout: string;
  stderr: string;
  durationMs: number;
}

@Injectable()
export class ValidationService {
  private readonly logger = new Logger(ValidationService.name);

  constructor(private readonly sandboxService: SandboxService) {}

  async validateWorktree(worktreePath: string): Promise<ValidationResult> {
    this.logger.debug(`Detecting language for worktree at ${worktreePath}`);
    const language = await LanguageDetector.detectLanguage(worktreePath);
    this.logger.debug(`Detected language: ${language}`);

    let command = '';
    let image = 'node:22-alpine';

    switch (language) {
      case ProjectLanguage.NODEJS:
        // Install deps, then run the test script if it exists, else the build
        // script. Script PRESENCE is checked explicitly instead of chaining
        // `npm test || npm run build || echo pass`: the old chain swallowed a
        // real build failure (its `|| echo` made the command exit 0), so a
        // broken patch could be reported as validated. If neither script
        // exists, install-only success is the best signal available.
        command =
          'npm install --legacy-peer-deps --no-audit --no-fund && ' +
          'if node -e "process.exit(require(\'./package.json\').scripts?.test ? 0 : 1)"; then npm test; ' +
          'elif node -e "process.exit(require(\'./package.json\').scripts?.build ? 0 : 1)"; then npm run build; ' +
          "else echo 'No test or build script — install-only validation passed'; fi";
        // Use full Debian image — alpine lacks Python/make/g++ needed by
        // native modules (kerberos, bcrypt, canvas, etc.). Node 22 is the
        // current LTS; modern packages (Next 16, AI SDK) require >=22.
        image = 'node:22';
        break;
      case ProjectLanguage.PYTHON:
        command = 'pip install -r requirements.txt && pytest';
        image = 'python:3.11-alpine';
        break;
      case ProjectLanguage.GO:
        command = 'go test ./...';
        image = 'golang:1.21-alpine';
        break;
      case ProjectLanguage.RUST:
        command = 'cargo test';
        image = 'rust:1.75-alpine';
        break;
      case ProjectLanguage.PHP:
        command = 'composer install && vendor/bin/phpunit';
        image = 'php:8.2-cli-alpine';
        break;
      case ProjectLanguage.JAVA:
        // Use maven wrapper if exists, else fallback to generic command
        command = 'if [ -f "mvnw" ]; then ./mvnw test; else mvn test; fi';
        image = 'maven:3.9-eclipse-temurin-17-alpine';
        break;
      case ProjectLanguage.CSHARP:
        command = 'dotnet test';
        image = 'mcr.microsoft.com/dotnet/sdk:8.0-alpine';
        break;
      case ProjectLanguage.UNKNOWN:
      default:
        // Be honest: we have no idea how to test this repo, so say so and
        // fail the job. Auto-passing would let untested code reach a PR.
        this.logger.warn(
          `Unknown language for worktree ${worktreePath}. Failing validation — needs human test.`,
        );
        return {
          success: false,
          language,
          stdout: '',
          stderr:
            'Unknown project language — automatic validation is not possible. Needs human test.',
          durationMs: 0,
        };
    }

    this.logger.log(
      `Starting validation for ${language} using command: ${command}`,
    );

    try {
      const result = await this.sandboxService.executeCommand({
        worktreePath,
        command,
        image,
      });

      return {
        success: true,
        language,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
      };
    } catch (error: any) {
      this.logger.warn(`Validation failed: ${error.message}`);
      return {
        success: false,
        language,
        stdout: '',
        stderr: error.message,
        durationMs: 0,
      };
    }
  }
}
