import { Body, Controller, Get, Headers, Inject, Param, Post, Req } from '@nestjs/common';
import type { SessionService } from '../auth/session.service.js';
import { JobsService } from './jobs.service.js';

type RequestLike = { headers: Record<string, string | string[] | undefined> };
function cookie(request: RequestLike): string | undefined { const value = request.headers.cookie; return Array.isArray(value) ? value[0] : value; }

@Controller('build-jobs')
export class JobsController {
  constructor(@Inject('SESSION_SERVICE') private readonly sessions: SessionService, private readonly jobs: JobsService) {}
  @Post(':id/cancel') async cancel(@Param('id') id: string, @Req() request: RequestLike, @Headers('x-csrf-token') csrf: string | undefined) { const actor = await this.sessions.authenticate(cookie(request)); this.sessions.assertCsrf(actor, csrf); return this.jobs.cancel(actor, id); }
  @Post(':id/retry') async retry(@Param('id') id: string, @Body() body: { riskConfirmed?: unknown }, @Req() request: RequestLike, @Headers('x-csrf-token') csrf: string | undefined) { const actor = await this.sessions.authenticate(cookie(request)); this.sessions.assertCsrf(actor, csrf); return this.jobs.retry(actor, id, body?.riskConfirmed === true); }
  @Post(':id/reconcile') async reconcile(@Param('id') id: string, @Body() body: unknown, @Req() request: RequestLike, @Headers('x-csrf-token') csrf: string | undefined) { const actor = await this.sessions.authenticate(cookie(request)); this.sessions.assertCsrf(actor, csrf); return this.jobs.reconcile(actor, id, body); }
  @Get(':id/external-links') async externalLinks(@Param('id') id: string, @Req() request: RequestLike) { const actor = await this.sessions.authenticate(cookie(request)); return this.jobs.externalLinks(actor, id); }
}
