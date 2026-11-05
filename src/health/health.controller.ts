import { Controller, Get, Header, HttpStatus, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { PrismaService } from "../prisma/prisma.service";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Liveness and database reachability" })
  async health(@Res({ passthrough: true }) res: Response) {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: "ok", database: "ok" };
    } catch {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: "degraded", database: "unreachable" };
    }
  }
}
