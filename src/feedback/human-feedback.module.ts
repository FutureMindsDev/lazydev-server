import { Module } from '@nestjs/common';
import { HumanFeedbackService } from './human-feedback.service';

@Module({
  providers: [HumanFeedbackService],
  exports: [HumanFeedbackService],
})
export class HumanFeedbackModule {}
