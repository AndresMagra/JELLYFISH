import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addresses, users } from '../db/schema';
import { notFound } from '../errors';
import { deleteAccount, requestOtp, verifyOtp } from '../services/auth';
import { addressInputSchema, parse, uuid } from './validate';

export async function registerAuthRoutes(app: FastifyInstance) {
  const { deps } = app;
  const authCtx = () => ({
    db: deps.db,
    config: deps.config,
    sender: deps.otpSender,
    now: deps.now,
  });

  // Límite estricto en los endpoints de código para frenar abuso de SMS.
  const strict = { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } };

  app.post('/v1/auth/otp/request', strict, async (req) => {
    const { phone } = parse(z.object({ phone: z.string().min(7).max(30) }), req.body);
    return requestOtp(authCtx(), phone);
  });

  app.post('/v1/auth/otp/verify', strict, async (req) => {
    const { phone, code } = parse(
      z.object({
        phone: z.string().min(7).max(30),
        code: z.string().regex(/^\d{6}$/, 'El código tiene 6 dígitos'),
      }),
      req.body,
    );
    const user = await verifyOtp(authCtx(), phone, code);
    const token = app.jwt.sign({ sub: user.id, role: user.role });
    return { token, user: publicUser(user) };
  });

  app.get('/v1/me', { preHandler: app.authenticate }, async (req) => {
    const [user] = await deps.db.select().from(users).where(eq(users.id, req.session!.id));
    return publicUser(user!);
  });

  app.patch('/v1/me', { preHandler: app.authenticate }, async (req) => {
    const body = parse(
      z.object({
        name: z.string().trim().max(80).optional(),
        email: z.string().trim().email('Correo inválido').max(120).nullable().optional(),
        pushToken: z.string().max(300).nullable().optional(),
      }),
      req.body,
    );
    const [user] = await deps.db
      .update(users)
      .set(body)
      .where(eq(users.id, req.session!.id))
      .returning();
    return publicUser(user!);
  });

  app.delete('/v1/me', { preHandler: app.authenticate }, async (req, reply) => {
    await deleteAccount(deps.db, req.session!.id);
    return reply.status(204).send();
  });

  // ── Direcciones ──
  app.get('/v1/me/addresses', { preHandler: app.authenticate }, async (req) =>
    deps.db
      .select()
      .from(addresses)
      .where(eq(addresses.userId, req.session!.id))
      .orderBy(desc(addresses.isDefault), desc(addresses.createdAt)),
  );

  app.post('/v1/me/addresses', { preHandler: app.authenticate }, async (req, reply) => {
    const body = parse(
      addressInputSchema.extend({ isDefault: z.boolean().default(false) }),
      req.body,
    );
    const userId = req.session!.id;
    const created = await deps.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: addresses.id })
        .from(addresses)
        .where(eq(addresses.userId, userId));
      const makeDefault = body.isDefault || existing.length === 0;
      if (makeDefault) {
        await tx.update(addresses).set({ isDefault: false }).where(eq(addresses.userId, userId));
      }
      const [row] = await tx
        .insert(addresses)
        .values({ ...body, userId, isDefault: makeDefault })
        .returning();
      return row!;
    });
    return reply.status(201).send(created);
  });

  app.put('/v1/me/addresses/:id', { preHandler: app.authenticate }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(
      addressInputSchema.extend({ isDefault: z.boolean().default(false) }),
      req.body,
    );
    const userId = req.session!.id;
    return deps.db.transaction(async (tx) => {
      if (body.isDefault) {
        await tx.update(addresses).set({ isDefault: false }).where(eq(addresses.userId, userId));
      }
      const [row] = await tx
        .update(addresses)
        .set(body)
        .where(and(eq(addresses.id, id), eq(addresses.userId, userId)))
        .returning();
      if (!row) throw notFound('Dirección');
      return row;
    });
  });

  app.delete('/v1/me/addresses/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const rows = await deps.db
      .delete(addresses)
      .where(and(eq(addresses.id, id), eq(addresses.userId, req.session!.id)))
      .returning({ id: addresses.id });
    if (rows.length === 0) throw notFound('Dirección');
    return reply.status(204).send();
  });
}

function publicUser(u: typeof users.$inferSelect) {
  return { id: u.id, phone: u.phone, name: u.name, email: u.email, role: u.role };
}
