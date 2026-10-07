/** Errores de dominio con código estable (para la app) y mensaje en español (para la persona). */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const notFound = (what: string) =>
  new DomainError('not_found', `${what} no encontrado`, 404);
export const forbidden = (message = 'No tienes permiso para esta acción') =>
  new DomainError('forbidden', message, 403);
export const unauthorized = (message = 'Inicia sesión para continuar') =>
  new DomainError('unauthorized', message, 401);
export const conflict = (code: string, message: string, details?: unknown) =>
  new DomainError(code, message, 409, details);
export const invalid = (message: string, details?: unknown) =>
  new DomainError('validation', message, 400, details);
export const tooMany = (message = 'Demasiados intentos. Espera un momento.') =>
  new DomainError('rate_limited', message, 429);
