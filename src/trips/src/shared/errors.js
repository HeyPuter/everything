export class DomainError extends Error {
  constructor(code, status = 400, issues = []) {
    super(code);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.issues = issues;
  }
}

export function invariant(condition, code = 'invalid', status = 400) {
  if (!condition) throw new DomainError(code, status);
}
