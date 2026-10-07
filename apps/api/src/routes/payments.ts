import { MockGateway, type RedirectForm } from '@jellyfish/payments';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { notFound } from '../errors';
import {
  availableMethods,
  buildCheckout,
  cashReport,
  collectCash,
  handleCardCallback,
  listPayments,
  markPaid,
  markRefunded,
  settleCash,
  signRedirectToken,
  startCardPayment,
  submitTransferProof,
  verifyRedirectToken,
  type CallbackOutcome,
} from '../services/payments';
import { parse, positiveInt, uuid } from './validate';

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const PAGE_STYLE = `
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#050B1F;color:#EAF2FF;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px}
  .card{max-width:380px;background:#0A1633;border:1px solid #1B2B57;border-radius:24px;padding:32px}
  h1{font-size:22px;margin:0 0 8px} p{color:#93A4C3;margin:0 0 20px}
  a.btn,button{display:inline-block;background:#22D3EE;color:#050B1F;border:0;border-radius:999px;
       padding:12px 24px;font-weight:700;font-size:16px;text-decoration:none;cursor:pointer;margin:4px}
  a.alt{background:#1A3470;color:#EAF2FF}`;

function html(
  reply: FastifyReply,
  status: number,
  body: string,
  nonce?: string,
  formAction?: string,
) {
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    nonce ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
    formAction ? `form-action ${formAction}` : "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return reply
    .status(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('content-security-policy', csp)
    .header('x-content-type-options', 'nosniff')
    .send(
      `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JELLYFISH</title><style>${PAGE_STYLE}</style></head><body>${body}</body></html>`,
    );
}

const RESULT_COPY: Record<CallbackOutcome['status'], { title: string; text: string }> = {
  approved: {
    title: '¡Pago recibido!',
    text: 'Tu pedido está confirmado. Vuelve a la app para seguirlo.',
  },
  declined: {
    title: 'Pago rechazado',
    text: 'Tu banco no aprobó el pago. Puedes intentar con otra tarjeta.',
  },
  cancelled: {
    title: 'Pago cancelado',
    text: 'No se hizo ningún cobro. Vuelve a la app para intentarlo de nuevo.',
  },
  invalid: {
    title: 'No pudimos verificar este pago',
    text: 'Si te cobraron, no te preocupes: revisaremos tu pedido.',
  },
  unknown: { title: 'Pago no encontrado', text: 'No reconocimos este intento de pago.' },
};

export async function registerPaymentRoutes(app: FastifyInstance) {
  const { deps } = app;
  const { payments: cfg } = deps.config;
  const staff = { preHandler: app.requireRole('admin', 'staff') };
  const adminOnly = { preHandler: app.requireRole('admin') };
  const driver = { preHandler: app.requireRole('driver') };
  const idParams = z.object({ id: uuid });

  await app.register(import('@fastify/formbody'));

  app.get('/v1/payments/methods', async () => availableMethods(deps.config));

  app.get('/v1/payments/transfer-info', { preHandler: app.authenticate }, async () => {
    if (!cfg.transfer) throw notFound('Datos de transferencia');
    return cfg.transfer;
  });

  // ── Tarjeta ──
  app.post('/v1/orders/:id/pay', { preHandler: app.authenticate }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { payment, expiresAt } = await startCardPayment(app.paymentCtx, id, req.session!.id);
    const token = signRedirectToken(deps.config.jwtSecret, payment.id, expiresAt);
    return {
      paymentId: payment.id,
      amount: payment.amount,
      redirectUrl: `${cfg.publicBaseUrl}/v1/payments/${payment.id}/redirect?token=${encodeURIComponent(token)}`,
      expiresAt,
    };
  });

  // Página que envía (POST) al cliente a la pasarela. La app la abre en un navegador embebido.
  app.get('/v1/payments/:id/redirect', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { token } = parse(z.object({ token: z.string().min(10).max(300) }), req.query);
    const now = (deps.now ?? (() => new Date()))();
    if (verifyRedirectToken(deps.config.jwtSecret, token, now) !== id) {
      return html(
        reply,
        403,
        `<div class="card"><h1>Enlace vencido</h1><p>Vuelve a la app e inicia el pago de nuevo.</p></div>`,
      );
    }
    const form: RedirectForm = await buildCheckout(app.paymentCtx, id);
    const nonce = randomBytes(12).toString('base64');
    const inputs = Object.entries(form.fields)
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join('');
    const origin = new URL(form.url).origin;
    return html(
      reply,
      200,
      `<div class="card"><h1>Redirigiendo al pago seguro…</h1><p>No cierres esta ventana.</p>
       <form id="pay" method="POST" action="${esc(form.url)}">${inputs}<noscript><button type="submit">Continuar al pago</button></noscript></form>
       <script nonce="${nonce}">document.getElementById('pay').submit();</script></div>`,
      nonce,
      origin,
    );
  });

  // Callbacks de la pasarela (navegador → API). Aceptan GET (redirección) y POST (formulario).
  const gatewayName = cfg.cardProvider === 'azul' ? 'azul' : 'mock';
  const callback = async (
    req: { params: unknown; query: unknown; body: unknown },
    reply: FastifyReply,
  ) => {
    if (!cfg.cardProvider) throw notFound('Ruta');
    const { kind } = parse(
      z.object({ kind: z.enum(['approved', 'declined', 'cancel']) }),
      req.params,
    );
    const params = {
      ...(req.query as Record<string, string>),
      ...((req.body as Record<string, string> | null) ?? {}),
    };
    const outcome = await handleCardCallback(app.paymentCtx, kind, params);
    const copy = RESULT_COPY[outcome.status];
    const refundNote = outcome.refundDue
      ? ' Tu pedido ya no estaba activo, así que te devolveremos el dinero.'
      : '';
    const link =
      outcome.orderId && outcome.status !== 'invalid' && outcome.status !== 'unknown'
        ? `${cfg.appScheme}://orders/${outcome.orderId}?payment=${outcome.status}`
        : null;
    const nonce = randomBytes(12).toString('base64');
    return html(
      reply,
      outcome.status === 'invalid' ? 400 : 200,
      `<div class="card"><h1>${esc(copy.title)}</h1><p>${esc(copy.text + refundNote)}</p>
       ${link ? `<a class="btn" href="${esc(link)}">Volver a JELLYFISH</a><script nonce="${nonce}">setTimeout(function(){location.href=${JSON.stringify(link)}},300);</script>` : ''}
       </div>`,
      link ? nonce : undefined,
    );
  };
  app.get(`/v1/payments/${gatewayName}/:kind`, callback);
  app.post(`/v1/payments/${gatewayName}/:kind`, callback);

  // Página del simulador (solo desarrollo/demo): permite aprobar o rechazar sin tarjeta real.
  if (cfg.cardProvider === 'mock') {
    app.post('/v1/payments/mock/page', async (req, reply) => {
      const gw = app.paymentCtx.gateway as MockGateway;
      const { OrderNumber, Amount } = parse(
        z.object({
          OrderNumber: z.string().regex(/^[A-Za-z0-9]{1,15}$/),
          Amount: z.string().regex(/^\d{3,12}$/),
        }),
        req.body,
      );
      const base = `${cfg.publicBaseUrl}/v1/payments/mock`;
      const link = (kind: 'approved' | 'declined', outcome: 'approved' | 'declined') => {
        const q = new URLSearchParams(
          gw.buildCallback(outcome, { orderNumber: OrderNumber, amount: Amount }),
        );
        return `${base}/${kind}?${q.toString()}`;
      };
      const pesos = (Number(Amount) / 100).toFixed(2);
      return html(
        reply,
        200,
        `<div class="card"><h1>Pasarela simulada</h1>
         <p>Pedido ${esc(OrderNumber)} · RD$ ${esc(pesos)}<br><small>Solo desarrollo: no se cobra dinero real.</small></p>
         <a class="btn" href="${esc(link('approved', 'approved'))}">Aprobar pago</a>
         <a class="btn alt" href="${esc(link('declined', 'declined'))}">Rechazar</a>
         <a class="btn alt" href="${esc(`${base}/cancel`)}?OrderNumber=${esc(OrderNumber)}">Cancelar</a></div>`,
      );
    });
  }

  // ── Transferencia ──
  app.post('/v1/orders/:id/transfer-proof', { preHandler: app.authenticate }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({
        reference: z.string().trim().min(3).max(80),
        note: z.string().trim().max(300).optional(),
      }),
      req.body,
    );
    return submitTransferProof(app.orderCtx, id, req.session!.id, body);
  });

  // ── Panel admin ──
  app.get('/v1/admin/payments', staff, async (req) => {
    const q = parse(
      z.object({
        status: z
          .enum([
            'pending',
            'authorized',
            'captured',
            'failed',
            'voided',
            'refunded',
            'partially_refunded',
          ])
          .optional(),
        refundPending: z.enum(['0', '1']).optional(),
      }),
      req.query,
    );
    return listPayments(deps.db, { status: q.status, refundPending: q.refundPending === '1' });
  });

  app.post('/v1/admin/payments/:id/mark-paid', staff, async (req) => {
    const { id } = parse(idParams, req.params);
    const { reference } = parse(
      z.object({ reference: z.string().trim().min(3).max(80) }),
      req.body,
    );
    return markPaid(app.orderCtx, id, req.session!.id, reference);
  });

  app.post('/v1/admin/payments/:id/mark-refunded', adminOnly, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({ amount: positiveInt, reference: z.string().trim().min(3).max(80) }),
      req.body,
    );
    return markRefunded(app.orderCtx, id, req.session!.id, body);
  });

  app.get('/v1/admin/cash', adminOnly, async () => cashReport(deps.db));

  app.post('/v1/admin/cash/settle', adminOnly, async (req) => {
    const body = parse(
      z.object({ driverId: uuid, amount: positiveInt, note: z.string().max(200).optional() }),
      req.body,
    );
    return settleCash(deps.db, { ...body, actorId: req.session!.id });
  });

  // ── Repartidor ──
  app.post('/v1/driver/orders/:id/collect', driver, async (req) => {
    const { id } = parse(idParams, req.params);
    const { amount } = parse(z.object({ amount: positiveInt }), req.body);
    return collectCash(app.orderCtx, id, { id: req.session!.id, role: 'driver' }, amount);
  });
}
