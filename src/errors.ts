export class ApiError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export function assertExists<T>(value: T | undefined, message = 'Data tidak ditemukan.'): T {
  if (!value) throw new ApiError(404, 'NOT_FOUND', message);
  return value;
}
