import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";

/** RFC 9457 problem details with a machine-readable `code` (docs repo: api-specification.md). */
export class ProblemException extends HttpException {
  constructor(status: number, code: string, title: string, detail?: string, extra?: Record<string, unknown>) {
    super({ code, title, detail, ...extra }, status);
  }
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger("Problem");

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<{ url: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = { code: "INTERNAL", title: "Something went wrong on our side" };

    if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST;
      body = {
        code: "REQUEST_INVALID",
        title: "The request is not valid",
        errors: exception.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      body =
        typeof res === "object" && res && "code" in res
          ? (res as Record<string, unknown>)
          : { code: HttpStatus[status] ?? "ERROR", title: typeof res === "string" ? res : exception.message };
    } else {
      // Never leak internals to the client; log them for the server.
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    response
      .status(status)
      .type("application/problem+json")
      .json({ type: "about:blank", status, instance: request.url, ...body });
  }
}
