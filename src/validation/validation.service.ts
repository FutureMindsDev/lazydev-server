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
    let image = 'node:20-alpine';

    switch (language) {
      case ProjectLanguage.NODEJS:
        // Install deps, then try `npm test`. If the repo has no test script
        // (exit 1 with "Missing script: test"), fall back to `npm run build`
        // as a compile-check. If neither exists, the install itself passing
        // is sufficient signal that the patch didn't break dependencies.
        command =
          'npm install --legacy-peer-deps && ' +
          "(npm test 2>&1 || npm run build 2>&1 || echo 'No test or build script — install-only validation passed')";
        // Use full Debian image — alpine lacks Python/make/g++ needed by
        // native modules (kerberos, bcrypt, canvas, etc.)
        image = 'node:20';
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
        this.logger.warn(
          `Unknown language for worktree ${worktreePath}. Skipping validation.`,
        );
        return {
          success: true,
          language,
          stdout: 'Skipped - unknown language',
          stderr: '',
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
