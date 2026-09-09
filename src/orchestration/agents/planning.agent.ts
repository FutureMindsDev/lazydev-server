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
import { AgentState } from '../graph.state';
import { LlmService } from '../llm.service';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

@Injectable()
export class PlanningAgent {
  private readonly logger = new Logger(PlanningAgent.name);

  constructor(private readonly llmService: LlmService) {}

  async invoke(state: AgentState): Promise<Partial<AgentState>> {
    this.logger.log('Drafting implementation plan...');

    if (!state.researchContext) {
      this.logger.warn('No research context found.');
      return {};
    }

    const systemPrompt =
      new SystemMessage(`You are a senior software engineer planning a fix for an issue.
Review the provided codebase research context — a free-text summary written by a research agent that explored the codebase — alongside the original issue requirements. Use the symbol names and file contents it reports where available, but note that it is the research agent's best understanding at the time it wrote the summary, not guaranteed-verified fact: the engineer implementing this plan will re-read each file and confirm exact names before editing, and will use the real name if yours turns out to be wrong.

CRITICAL: All the context you need is already provided in the research results. Do NOT attempt to read files, call tools, or request more information. Output ONLY the implementation plan as plain text.

Draft a step-by-step implementation plan detailing which files and specific symbols/methods to modify and how. Use the EXACT file paths from the research context — do not invent paths.`);

    const userPrompt = new HumanMessage(`Issue Context:
${state.messages.map((m) => m.content).join('\n')}

Research Results:
${state.researchContext}`);

    const response = await this.llmService
      .getModel('planner')
      .invoke([systemPrompt, userPrompt]);

    let planContent = response.content as string;

    // DeepSeek thinking mode can leak internal tool-calling tokens (DSML)
    // into response.content when it wants to call tools but none are bound.
    // Strip them so the plan is clean.
    if (planContent.includes('\uFF5C\uFF5C')) {
      this.logger.warn(
        'Detected DSML tokens in planning response — stripping.',
      );
      planContent = planContent.replace(/<｜｜DSML｜｜[\s\S]*?<\/｜｜DSML｜｜>/g, '');
      planContent = planContent.replace(/<｜｜[^>]*>/g, '');
    }

    this.logger.log(
      `[PlanningAgent] LLM response:\n${'─'.repeat(60)}\n${planContent}\n${'─'.repeat(60)}`,
    );

    return {
      implementationPlan: planContent,
      messages: [new SystemMessage('Implementation plan drafted.')],
      // Explicitly reset the patcher's tool-loop message history so a fresh
      // plan always starts a fresh patch-generation attempt, never
      // continuing a previous attempt's (possibly stale) conversation.
      patchMessages: [],
    };
  }
}
