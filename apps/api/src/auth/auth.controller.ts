import { BadRequestException, Body, Controller, Get, Headers, Inject, Post, Req, Res } from '@nestjs/common';
import type { SessionActor, SessionService } from './session.service.js';

type RequestLike = { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } };
type ResponseLike = { setHeader(name: string, value: string | string[]): void };

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function actorResponse(actor: SessionActor, csrfToken: string) {
  return { user: { id: actor.userId, email: actor.email, role: actor.role }, csrfToken };
}

@Controller()
export class AuthController {
  constructor(@Inject('SESSION_SERVICE') private readonly sessions: SessionService) {}

  @Post('auth/login')
  async login(@Body() body: unknown, @Req() request: RequestLike, @Res({ passthrough: true }) response: ResponseLike) {
    if (!body || typeof body !== 'object') throw new BadRequestException('Email and password are required.');
    const { email, password } = body as Record<string, unknown>;
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) throw new BadRequestException('Email and password are required.');
    const result = await this.sessions.login(email, password, request.socket?.remoteAddress ?? 'unknown', singleHeader(request.headers.cookie));
    response.setHeader('Set-Cookie', this.sessions.cookiesForLogin(result.sessionToken, result.csrfToken));
    return actorResponse(result.actor, result.csrfToken);
  }

  @Post('auth/logout')
  async logout(@Req() request: RequestLike, @Headers('x-csrf-token') csrfToken: string | undefined, @Res({ passthrough: true }) response: ResponseLike) {
    const actor = await this.sessions.authenticate(singleHeader(request.headers.cookie));
    this.sessions.assertCsrf(actor, csrfToken);
    await this.sessions.logout(actor);
    response.setHeader('Set-Cookie', this.sessions.cookiesForLogout());
    return { ok: true };
  }

  @Get('me')
  async currentUser(@Req() request: RequestLike) {
    const actor = await this.sessions.authenticate(singleHeader(request.headers.cookie));
    return { user: { id: actor.userId, email: actor.email, role: actor.role } };
  }
}
