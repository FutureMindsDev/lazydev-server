/* eslint-disable */
import * as fs from 'fs';
import * as path from 'path';

export enum ProjectLanguage {
  NODEJS = 'NODEJS',
  PYTHON = 'PYTHON',
  GO = 'GO',
  RUST = 'RUST',
  PHP = 'PHP',
  JAVA = 'JAVA',
  CSHARP = 'CSHARP',
  UNKNOWN = 'UNKNOWN',
}

export class LanguageDetector {
  static async detectLanguage(worktreePath: string): Promise<ProjectLanguage> {
    const checks = [
      { file: 'package.json', lang: ProjectLanguage.NODEJS },
      { file: 'requirements.txt', lang: ProjectLanguage.PYTHON },
      { file: 'setup.py', lang: ProjectLanguage.PYTHON },
      { file: 'pyproject.toml', lang: ProjectLanguage.PYTHON },
      { file: 'go.mod', lang: ProjectLanguage.GO },
      { file: 'Cargo.toml', lang: ProjectLanguage.RUST },
      { file: 'composer.json', lang: ProjectLanguage.PHP },
      { file: 'pom.xml', lang: ProjectLanguage.JAVA },
      { file: 'build.gradle', lang: ProjectLanguage.JAVA },
      { file: '*.sln', lang: ProjectLanguage.CSHARP, isPattern: true },
      { file: '*.csproj', lang: ProjectLanguage.CSHARP, isPattern: true },
    ];

    try {
      const files = await fs.promises.readdir(worktreePath);

      for (const check of checks) {
        if (check.isPattern) {
          const regex = new RegExp('^' + check.file.replace('*', '.*') + '$');
          if (files.some((f) => regex.test(f))) {
            return check.lang;
          }
        } else {
          if (files.includes(check.file)) {
            return check.lang;
          }
        }
      }
    } catch (e) {
      // Ignore error and return UNKNOWN
    }

    return ProjectLanguage.UNKNOWN;
  }
}
