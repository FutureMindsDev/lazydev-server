/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(@InjectQueue('issue-processing') private issueQueue: Queue) {}

  async queueIssueEvent(eventPayload: any, deliveryId?: string) {
    this.logger.log(
      `Queueing issue event for processing... ID: ${eventPayload.issue?.number}`,
    );

    // Use a stable, idempotent job ID so that GitHub retries (same delivery)
    // are deduplicated by BullMQ and not processed twice.
    const stableJobId = deliveryId
      ? `gh-delivery-${deliveryId}`
      : `issue-${eventPayload.repository?.id}-${eventPayload.issue?.number}-${Date.now()}`;

    await this.issueQueue.add(
      'process-issue',
      {
        repository: eventPayload.repository?.full_name,
        issueNumber: eventPayload.issue?.number,
        title: eventPayload.issue?.title,
        body: eventPayload.issue?.body,
        action: eventPayload.action,
        installationId: eventPayload.installation?.id,
        labels:
          eventPayload.issue?.labels?.map((label: any) => label.name) || [],
      },
      {
        jobId: stableJobId,
        // Keep completed jobs in the queue briefly so duplicate webhook
        // deliveries (GitHub retries) are rejected by BullMQ's jobId check
        // even if the first job already finished.
        removeOnComplete: { age: 3600 }, // keep for 1 hour
        removeOnFail: { age: 86400 },    // keep failed jobs for 24 hours
      },
    );

    this.logger.log(`Job queued: ${stableJobId}`);
  }
}
