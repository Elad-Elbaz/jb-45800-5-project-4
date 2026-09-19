import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Forwards a rejected promise from an async route handler into Express'
 * error pipeline.
 *
 * Express 4 only catches errors thrown *synchronously*. An `async` handler
 * that rejects produces an unhandled rejection and a request that hangs until
 * the client times out -- the failure mode is a silent one, which is the worst
 * kind. Wrapping every async route removes the possibility entirely.
 *
 * (Express 5 does this natively. This project stays on 4 because that is what
 * the ecosystem's middleware is tested against today.)
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
