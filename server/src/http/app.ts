import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { SessionUser } from '../../../shared/api';
import { DEDUCTION_ACTIONS, DISPUTE_ACTIONS } from '../../../shared/domain';
import type { DB } from '../db/connection';
import { login, scopeFor, sessionInfo, userForToken } from '../domain/auth';
import { actorNow, DomainError, narrowScope, type Actor, type Scope } from '../domain/context';
import { getDataQuality } from '../domain/dataQuality';
import { getDashboard } from '../domain/metrics';
import { getDeductionDetail, getMeta, listDeductions, listDisputes, listFiltersSchema } from '../domain/queries';
import {
  addComment,
  applyDeductionAction,
  applyDisputeAction,
  assignCompany,
  assignDeduction,
  bulkApply,
  editDeduction,
  verifyIssue,
} from '../domain/workflow';
import { demoAccounts } from '../seed/users';

const COOKIE = 'recovery_session';

export interface AppOptions {
  today: () => string;
  showDemoAccounts?: boolean;
  /** Serve the built web app (production). */
  staticDir?: string;
  secureCookies?: boolean;
  /** Hosted demo with throwaway, per-instance data (Vercel). Shown as a banner in the UI. */
  sandbox?: boolean;
}

interface Ctx {
  user: SessionUser;
  scope: Scope;
  actor: Actor;
}

type Handler = (req: Request, res: Response, ctx: Ctx) => unknown;

const idParam = z.coerce.number().int().positive();
const companyQuery = z.object({ companyId: z.coerce.number().int().optional() });

export function createApp(db: DB, opts: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());

  // ------------------------------------------------------------ public
  app.post('/api/auth/login', (req, res) => {
    const body = z.object({ email: z.string(), password: z.string() }).safeParse(req.body);
    const session = body.success ? login(db, body.data.email, body.data.password) : null;
    if (!session) {
      res.status(401).json({ error: 'That email and password do not match.' });
      return;
    }
    res.cookie(COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: opts.secureCookies ?? false,
      maxAge: 7 * 86_400_000,
    });
    res.json(sessionInfo(db, session.user, scopeFor(db, session.user)));
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: opts.secureCookies ?? false });
    res.status(204).end();
  });

  app.get('/api/auth/demo-accounts', (_req, res) => {
    res.json(opts.showDemoAccounts ? demoAccounts(db) : []);
  });

  app.get('/api/config', (_req, res) => {
    res.json({ sandbox: opts.sandbox ?? false });
  });

  // ----------------------------------------------------------- private
  const authed =
    (handler: Handler) =>
    (req: Request, res: Response, next: NextFunction): void => {
      try {
        const token = req.cookies?.[COOKIE];
        const user = typeof token === 'string' ? userForToken(db, token) : null;
        if (!user) {
          res.status(401).json({ error: 'Please sign in.' });
          return;
        }
        const scope = scopeFor(db, user);
        const actor = { ...actorNow(user.id), today: opts.today() };
        const result = handler(req, res, { user, scope, actor });
        if (!res.headersSent) {
          if (result === undefined) res.status(204).end();
          else res.json(result);
        }
      } catch (err) {
        next(err);
      }
    };

  /** Writes return the fresh detail so the UI never shows stale state. */
  const detail = (ctx: Ctx, id: number) => getDeductionDetail(db, ctx.scope, id, opts.today());

  app.get(
    '/api/me',
    authed((_req, _res, ctx) => sessionInfo(db, ctx.user, ctx.scope)),
  );

  app.get(
    '/api/meta',
    authed((_req, _res, ctx) => getMeta(db, ctx.scope)),
  );

  app.get(
    '/api/deductions',
    authed((req, _res, ctx) => {
      const filters = listFiltersSchema.parse(req.query);
      return listDeductions(db, narrowScope(ctx.scope, filters.companyId), filters, opts.today());
    }),
  );

  app.post(
    '/api/deductions/bulk',
    authed((req, _res, ctx) => {
      const body = z
        .object({
          ids: z.array(z.number().int()).min(1).max(500),
          action: z.enum([...DEDUCTION_ACTIONS, 'assign']),
          payload: z.unknown().optional(),
        })
        .parse(req.body);
      return bulkApply(db, ctx.actor, ctx.scope, body.ids, body.action, body.payload);
    }),
  );

  app.get(
    '/api/deductions/:id',
    authed((req, _res, ctx) => detail(ctx, idParam.parse(req.params.id))),
  );

  app.patch(
    '/api/deductions/:id',
    authed((req, _res, ctx) => {
      const id = idParam.parse(req.params.id);
      editDeduction(db, ctx.actor, ctx.scope, id, req.body);
      return detail(ctx, id);
    }),
  );

  app.post(
    '/api/deductions/:id/actions/:action',
    authed((req, _res, ctx) => {
      const id = idParam.parse(req.params.id);
      const action = z.enum(DEDUCTION_ACTIONS).parse(req.params.action);
      applyDeductionAction(db, ctx.actor, ctx.scope, id, action, req.body);
      return detail(ctx, id);
    }),
  );

  app.post(
    '/api/deductions/:id/dispute/:action',
    authed((req, _res, ctx) => {
      const id = idParam.parse(req.params.id);
      const action = z.enum(DISPUTE_ACTIONS).parse(req.params.action);
      applyDisputeAction(db, ctx.actor, ctx.scope, id, action, req.body);
      return detail(ctx, id);
    }),
  );

  app.post(
    '/api/deductions/:id/assign',
    authed((req, _res, ctx) => {
      const id = idParam.parse(req.params.id);
      const body = z.object({ assigneeId: z.number().int().nullable() }).parse(req.body);
      assignDeduction(db, ctx.actor, ctx.scope, id, body.assigneeId);
      return detail(ctx, id);
    }),
  );

  app.post(
    '/api/deductions/:id/comments',
    authed((req, _res, ctx) => {
      const id = idParam.parse(req.params.id);
      addComment(db, ctx.actor, ctx.scope, id, req.body);
      return detail(ctx, id);
    }),
  );

  app.post(
    '/api/deductions/:id/issues/:issueId/verify',
    authed((req, _res, ctx) => {
      const id = idParam.parse(req.params.id);
      verifyIssue(db, ctx.actor, ctx.scope, id, idParam.parse(req.params.issueId), req.body);
      return detail(ctx, id);
    }),
  );

  app.post(
    '/api/deductions/:id/company',
    authed((req, _res, ctx) => {
      const id = idParam.parse(req.params.id);
      assignCompany(db, ctx.actor, ctx.scope, id, req.body);
      return detail(ctx, id);
    }),
  );

  app.get(
    '/api/disputes',
    authed((req, _res, ctx) => {
      const { companyId } = companyQuery.parse(req.query);
      return listDisputes(db, narrowScope(ctx.scope, companyId), opts.today());
    }),
  );

  app.get(
    '/api/dashboard',
    authed((req, _res, ctx) => {
      const { companyId } = companyQuery.parse(req.query);
      return getDashboard(db, narrowScope(ctx.scope, companyId), opts.today());
    }),
  );

  app.get(
    '/api/data-quality',
    authed((req, _res, ctx) => {
      const { companyId } = companyQuery.parse(req.query);
      const scope = narrowScope(ctx.scope, companyId);
      return getDataQuality(db, companyId === undefined ? scope : { ...scope, canSeeUnassigned: false });
    }),
  );

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  // ------------------------------------------------------------ static
  if (opts.staticDir && existsSync(join(opts.staticDir, 'index.html'))) {
    app.use(express.static(opts.staticDir));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(opts.staticDir!, 'index.html')));
  }

  // ------------------------------------------------------------ errors
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof DomainError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ') });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'Malformed JSON.' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side.' });
  });

  return app;
}
