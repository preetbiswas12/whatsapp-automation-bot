import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { AiStoreService } from './ai-store.service';
import { AiLlmService } from './ai-llm.service';

/**
 * AI assistant module (formerly the standalone `ai-bot`, now part of OpenWA).
 *
 * Deliberately imports no feature module: SessionModule imports this one (the projector fires
 * inbound evaluation), so anything imported here must not lead back to SessionModule. The reply
 * dependency (MessageService) is resolved lazily via ModuleRef inside the service for exactly that
 * reason — the same pattern AutomationModule uses for its rules service.
 *
 * State lives in JSON files under `<dataDir>/ai/` (approvals, patterns, per-chat conversations),
 * keeping the AI feature out of the relational DB entirely.
 */
@Module({
  imports: [],
  controllers: [AiController],
  providers: [AiStoreService, AiLlmService, AiService],
  exports: [AiService],
})
export class AiModule {}