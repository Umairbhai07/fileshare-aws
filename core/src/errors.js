export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (msg) => new HttpError(400, 'bad_request', msg);
export const unauthorized = (msg = 'Sign in required') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Not allowed') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'File not found') => new HttpError(404, 'not_found', msg);
export const gone = (msg = 'This link has expired') => new HttpError(410, 'gone', msg);
export const tooLarge = (msg) => new HttpError(413, 'too_large', msg);
