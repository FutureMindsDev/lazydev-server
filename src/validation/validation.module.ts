import { Module } from '@nestjs/common';
import { ValidationService } from './validation.service';
import { SandboxModule } from '../sandbox/sandbox.module';

@Module({
  imports: [SandboxModule],
  providers: [ValidationService],
  exports: [ValidationService],
})
export class ValidationModule {}
