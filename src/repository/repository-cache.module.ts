import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RepositoryCache } from './entities/repository-cache.entity';
import { RepositoryCacheService } from './repository-cache.service';
import { BranchResolverService } from './branch-resolver.service';
import { GithubModule } from '../github/github.module';

@Module({
  imports: [TypeOrmModule.forFeature([RepositoryCache]), GithubModule],
  providers: [RepositoryCacheService, BranchResolverService],
  exports: [RepositoryCacheService, BranchResolverService],
})
export class RepositoryCacheModule {}
