import { BadRequestException, ConflictException, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Body } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { AiService } from './ai.service';
import { AiApprovalItemDto, AiModuleStatusDto, AiPatternDto } from './dto/ai-response.dto';

/**
 * AI assistant REST surface, mounted under the global `/api` prefix. Everything here requires an
 * API key (global guard) and at least the OPERATOR role — approvals are exactly the human-in-the-
 * loop gate, so a viewer key must not be able to release a draft. There is no session dimension on
 * these routes: approvals/patterns are gateway-wide.
 */
@ApiTags('ai')
@Controller('ai')
// Deployment-global (no :sessionId route param), so the guard's route-param session fence can never
// bite — reject session-scoped keys outright at class level. Each handler still needs OPERATOR.
@RequireUnscopedKey()
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Get('status')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'AI assistant status: gate config, LLM reachability, queue shape' })
  @ApiResponse({ status: 200, description: 'AI module status.', type: AiModuleStatusDto })
  async status(): Promise<AiModuleStatusDto> {
    return this.aiService.getStatus();
  }

  @Get('approvals')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List all approvals, newest first (pending and resolved)' })
  @ApiResponse({ status: 200, description: 'Approval queue.', type: AiApprovalItemDto, isArray: true })
  async listApprovals(): Promise<AiApprovalItemDto[]> {
    return this.aiService.listApprovals();
  }

  @Get('approvals/pending')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List pending approvals, newest first' })
  @ApiResponse({ status: 200, description: 'Pending approvals.', type: AiApprovalItemDto, isArray: true })
  async listPending(): Promise<AiApprovalItemDto[]> {
    return this.aiService.listPendingApprovals();
  }

  @Get('approvals/resolved')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List resolved approvals (approved / rejected / expired)' })
  @ApiResponse({ status: 200, description: 'Resolved approvals.', type: AiApprovalItemDto, isArray: true })
  async listResolved(): Promise<AiApprovalItemDto[]> {
    return this.aiService.listResolvedApprovals();
  }

  @Post('approvals/:id/approve')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve an AI draft: send the reply and learn the pattern' })
  @ApiResponse({ status: 200, description: 'Reply sent.', type: AiApprovalItemDto })
  @ApiResponse({ status: 404, description: 'No such approval.' })
  @ApiResponse({ status: 409, description: 'Approval already resolved.' })
  async approve(@Param('id', ParseUUIDPipe) id: string): Promise<AiApprovalItemDto> {
    return this.aiService.approve(id);
  }

  @Post('approvals/:id/reject')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject an AI draft: discard without sending' })
  @ApiResponse({ status: 200, description: 'Draft rejected.', type: AiApprovalItemDto })
  @ApiResponse({ status: 404, description: 'No such approval.' })
  @ApiResponse({ status: 409, description: 'Approval already resolved.' })
  async reject(@Param('id', ParseUUIDPipe) id: string): Promise<AiApprovalItemDto> {
    return this.aiService.reject(id);
  }

  @Post('approvals/:id/edit')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Edit the draft reply before approving' })
  @ApiResponse({ status: 200, description: 'Draft updated.', type: AiApprovalItemDto })
  @ApiResponse({ status: 404, description: 'No such approval.' })
  @ApiResponse({ status: 409, description: 'Approval already resolved.' })
  async editApproval(@Param('id', ParseUUIDPipe) id: string, @Body() body: { customReply: string }): Promise<AiApprovalItemDto> {
    if (!body.customReply?.trim()) throw new BadRequestException('customReply must not be empty');
    return this.aiService.editApproval(id, body.customReply.trim());
  }

  @Post('agent')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a message via the AI agent: provide a prompt and target phone' })
  @ApiResponse({ status: 200, description: 'Agent draft queued for approval.', type: AiApprovalItemDto })
  @ApiResponse({ status: 400, description: 'Invalid prompt or phone.' })
  async sendAgent(@Body() body: { prompt: string; targetPhone: string }): Promise<AiApprovalItemDto> {
    if (!body.prompt?.trim()) throw new BadRequestException('prompt must not be empty');
    if (!body.targetPhone?.trim()) throw new BadRequestException('targetPhone must not be empty');
    return this.aiService.sendAgentMessage(body.prompt.trim(), body.targetPhone.trim());
  }

  @Get('patterns')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'List learned reply patterns' })
  @ApiResponse({ status: 200, description: 'Learned patterns.', type: AiPatternDto, isArray: true })
  async listPatterns(): Promise<AiPatternDto[]> {
    return this.aiService.listPatterns();
  }

  @Delete('patterns/:id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a learned pattern' })
  @ApiResponse({ status: 204, description: 'Pattern deleted.' })
  @ApiResponse({ status: 404, description: 'No such pattern.' })
  async deletePattern(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    const removed = await this.aiService.deletePattern(id);
    if (!removed) throw new NotFoundException('Pattern not found');
  }
}