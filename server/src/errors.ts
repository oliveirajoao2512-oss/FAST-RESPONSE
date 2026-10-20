export class AppError extends Error {
  constructor(public status: number, message: string, public code = 'erro', public details?: unknown) {
    super(message);
  }
}
export const badRequest = (m: string, details?: unknown) => new AppError(400, m, 'requisicao_invalida', details);
export const unauthorized = (m = 'Faça login para continuar.') => new AppError(401, m, 'nao_autenticado');
export const forbidden = (m = 'Você não tem permissão para esta ação.') => new AppError(403, m, 'sem_permissao');
export const notFound = (m = 'Registro não encontrado.') => new AppError(404, m, 'nao_encontrado');
export const conflict = (m: string, code = 'conflito') => new AppError(409, m, code);
export const unprocessable = (m: string, details?: unknown) => new AppError(422, m, 'regra_de_negocio', details);

export function assert(cond: unknown, err: AppError): asserts cond {
  if (!cond) throw err;
}
