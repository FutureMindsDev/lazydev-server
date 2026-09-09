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
export class IssueAnalyzerAgent {
  private readonly logger = new Logger(IssueAnalyzerAgent.name);

  constructor(private readonly llmService: LlmService) {}

  async invoke(state: AgentState): Promise<Partial<AgentState>> {
    this.logger.log('Analyzing issue payload...');
    const { issuePayload } = state;

    if (!issuePayload) {
      this.logger.warn('No issue payload found in state.');
      return {};
    }

    const title =
      issuePayload.issue?.title || issuePayload.title || 'Unknown Issue';
    const body = issuePayload.issue?.body || issuePayload.body || '';

    const systemPrompt =
      new SystemMessage(`You are an expert software architect.
Analyze the following GitHub issue and extract the core technical requirements.
Provide a concise summary of what needs to be changed in the codebase.

Also suggest:
- 2-4 search terms the research agent should use to find relevant files
- 1-3 likely directories where the fix might live

Format your response as:
SUMMARY: <concise technical summary>

SEARCH TERMS: <comma-separated list>
LIKELY DIRECTORIES: <comma-separated list>`);

    const userPrompt = new HumanMessage(
      `Issue Title: ${title}\nIssue Body: ${body}`,
    );

    const response = await this.llmService
      .getModel('analyzer')
      .invoke([systemPrompt, userPrompt]);

    this.logger.log(
      `[IssueAnalyzer] LLM response:\n${'─'.repeat(60)}\n${response.content}\n${'─'.repeat(60)}`,
    );

    // Parse triage context (search terms + likely directories) from the
    // LLM response so the ResearchAgent's ReAct loop has a starting point.
    const responseText = response.content as string;
    let triageContext: any = undefined;
    try {
      const searchTermsMatch = responseText.match(
        /SEARCH TERMS:\s*(.+)/i,
      );
      const likelyDirsMatch = responseText.match(
        /LIKELY DIRECTORIES:\s*(.+)/i,
      );
      if (searchTermsMatch || likelyDirsMatch) {
        triageContext = {
          searchTerms: searchTermsMatch
            ? searchTermsMatch[1]
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
          likelyDirectories: likelyDirsMatch
            ? likelyDirsMatch[1]
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
        };
      }
    } catch {
      // Non-fatal — research agent works without triageContext.
    }

    return {
      triageContext,
      messages: [systemPrompt, userPrompt, response],
    };
  }
}
