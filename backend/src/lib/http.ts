import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  status: number;
  /*
   * Machine-readable detail beside the human message.
   *
   * For the cases where a client has to BRANCH, not just display: the
   * checkout needs to tell "this email already has an account, ask for its
   * password" from "that password was wrong", and matching on message text
   * is how a client breaks the first time the wording is improved or
   * translated.
   *
   * Flags only. Never put anything here that the message would not already
   * have said — it goes to the browser.
   */
  details?: Record<string, unknown>;
  constructor(status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as Req, res, next).catch(next);
  };
}

export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (!value || Array.isArray(value)) throw new HttpError(400, `Missing route parameter: ${name}`);
  return value;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, ...(err.details ?? {}) });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: err.issues.map((issue) => issue.message).join(", ") });
    return;
  }
  // Multer rejects oversize/extra files with its own error class. These are
  // client mistakes, not server faults — a 500 here would tell an organiser
  // the service is broken when their poster is simply too big.
  if (typeof err === "object" && err !== null && (err as { name?: string }).name === "MulterError") {
    const code = (err as { code?: string }).code;
    const message =
      code === "LIMIT_FILE_SIZE"
        ? "Image is too large (maximum 5 MB)"
        : code === "LIMIT_FILE_COUNT" || code === "LIMIT_UNEXPECTED_FILE"
          ? "Upload one image at a time"
          : "Upload rejected";
    res.status(413).json({ error: message });
    return;
  }
  req.log?.error({ err }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
}
