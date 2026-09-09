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
