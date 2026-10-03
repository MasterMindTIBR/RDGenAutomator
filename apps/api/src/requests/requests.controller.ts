import { BadRequestException, Body, Controller, Headers, Inject, Post, Req } from '@nestjs/common';
import type { SessionService } from '../auth/session.service.js';
import { RequestsService } from './requests.service.js';

type RequestLike = { headers: Record<string, string | string[] | undefined> };
function cookie(request: RequestLike): string | undefined { const value = request.headers.cookie; return Array.isArray(value) ? value[0] : value; }

@Controller('build-requests')
export class RequestsController {
  constructor(@Inject('SESSION_SERVICE') private readonly sessions: SessionService, @Inject(RequestsService) private readonly requests: RequestsService) {}

  @Post()
  async create(@Body() body: unknown, @Req() request: RequestLike, @Headers('x-csrf-token') csrf: string | undefined, @Headers('idempotency-key') idempotencyKey: string | undefined) {
    const actor = await this.sessions.authenticate(cookie(request));
    this.sessions.assertCsrf(actor, csrf);
    if (!idempotencyKey || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(idempotencyKey)) throw new BadRequestException('A valid Idempotency-Key header is required.');
    return this.requests.create(actor.userId, idempotencyKey, body);
  }
}
