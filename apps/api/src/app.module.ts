import { Controller, Get, Module } from '@nestjs/common';
import type { AppEnvironment } from '@rdgen/domain';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { EncryptionService } from '@rdgen/domain';
import { HealthService } from './health.service.js';
import { AuditService } from './audit.service.js';
import { SessionService } from './auth/session.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AdminUsersController } from './admin/users.controller.js';
import { ResourcesController } from './resources/resources.controller.js';
import { AdminConfigurationController } from './admin/configuration.controller.js';
import { RequestsController } from './requests/requests.controller.js';
import { RequestsService } from './requests/requests.service.js';
import { JobsController } from './jobs/jobs.controller.js';
import { JobsService } from './jobs/jobs.service.js';

export function createAppModule(environment: AppEnvironment, pool: Pool, redis: Redis, encryption: EncryptionService) {
  const health = new HealthService(environment, pool, redis, encryption);
  const audit = new AuditService(pool);
  const sessions = new SessionService(pool, redis, environment);
  @Controller('health')
  class HealthController {
    @Get()
    check() { return health.check(); }
  }
  @Module({
    controllers: [HealthController, AuthController, AdminUsersController, AdminConfigurationController, RequestsController, ResourcesController, JobsController],
    providers: [
      { provide: 'DATABASE_POOL', useValue: pool },
      { provide: 'APP_ENVIRONMENT', useValue: environment },
      { provide: 'AUDIT_SERVICE', useValue: audit },
      { provide: 'SESSION_SERVICE', useValue: sessions },
      { provide: 'ENCRYPTION_SERVICE', useValue: encryption },
      RequestsService, JobsService
    ]
  })
  class AppModule {}
  return AppModule;
}
