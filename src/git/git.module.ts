import { Module } from '@nestjs/common';
import { GitService } from './git.service';
import { WorktreeManagerService } from './worktree-manager.service';

@Module({
  providers: [GitService, WorktreeManagerService],
  exports: [GitService, WorktreeManagerService],
})
export class GitModule {}
