import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ApprovalStatus } from '../ai-store.service';

/**
 * Response shapes for the AI assistant REST surface. Defined as classes (not interfaces) because
 * `@ApiResponse({ type })` needs a runtime value for the OpenAPI schema — the same reason every
 * other module ships DTO classes. The service/store return plain objects that match these shapes
 * structurally, so no mapping is needed.
 */

export class AiApprovalItemDto {
  @ApiProperty({ description: 'Approval id (uuid)' })
  id!: string;

  @ApiProperty({ description: 'Session the inbound message arrived on' })
  sessionId!: string;

  @ApiProperty({ description: 'Sender of the original message (push name or contact id)' })
  sender!: string;

  @ApiProperty({ description: 'Chat the reply belongs to' })
  chatId!: string;

  @ApiProperty({ description: 'The inbound message that produced the draft' })
  originalMessage!: string;

  @ApiProperty({ description: 'The drafted reply awaiting approval' })
  draftReply!: string;

  @ApiProperty({ description: 'Short summary of the conversation context' })
  summary!: string;

  @ApiProperty({ description: 'Running conversation summary for this chat' })
  chatSummary!: string;

  @ApiProperty({ enum: ['pending', 'approved', 'rejected', 'expired'], description: 'Approval state' })
  status!: ApprovalStatus;

  @ApiProperty({ enum: ['draft', 'pattern', 'agent'], description: 'Draft origin: fresh LLM draft, pattern match, or agent prompt' })
  kind!: 'draft' | 'pattern' | 'agent';

  @ApiPropertyOptional({ description: 'Pattern id, present only for pattern-match drafts' })
  patternId?: string;

  @ApiPropertyOptional({ description: 'Pattern match confidence (0..1), pattern drafts only' })
  confidence?: number;

  @ApiPropertyOptional({ description: 'Target phone number, present only for agent drafts' })
  targetPhone?: string;

  @ApiPropertyOptional({ description: 'Operator prompt, present only for agent drafts' })
  agentPrompt?: string;

  @ApiProperty({ description: 'When the draft was queued (ISO 8601)' })
  createdAt!: string;

  @ApiPropertyOptional({ description: 'Operator-edited reply, set before approval' })
  customReply?: string | null;

  @ApiPropertyOptional({ description: 'When the draft was resolved (ISO 8601)' })
  resolvedAt?: string;
}

export class AiPatternDto {
  @ApiProperty({ description: 'Pattern id (uuid)' })
  id!: string;

  @ApiProperty({ description: 'Trigger keywords learned from the approved message', type: [String] })
  keywords!: string[];

  @ApiProperty({ description: 'The original message the pattern came from' })
  originalMessage!: string;

  @ApiProperty({ description: 'The reply the pattern produces' })
  reply!: string;

  @ApiProperty({ description: 'Short summary of what this pattern replies to' })
  summary!: string;

  @ApiProperty({ description: 'How many times the pattern has been used' })
  uses!: number;

  @ApiProperty({ description: 'When the pattern was created (ISO 8601)' })
  createdAt!: string;

  @ApiProperty({ description: 'When the pattern was last used (ISO 8601)' })
  lastUsed!: string;
}

export class AiModuleStatusDto {
  @ApiProperty({ description: 'Whether the AI bot is enabled' })
  enabled!: boolean;

  @ApiProperty({ description: 'Whether the human approval gate is enforced' })
  approvalEnabled!: boolean;

  @ApiProperty({ description: 'Pattern match threshold (0..1)' })
  matchThreshold!: number;

  @ApiProperty({ description: 'Whether the LLM endpoint was reachable at last probe' })
  llmReachable!: boolean;

  @ApiProperty({ description: 'Configured LLM model id' })
  llmModel!: string;

  @ApiProperty({ description: 'Number of drafts awaiting approval' })
  pendingApprovals!: number;

  @ApiProperty({ description: 'Number of learned patterns' })
  patternCount!: number;
}