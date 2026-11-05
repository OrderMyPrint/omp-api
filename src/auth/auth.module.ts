import { Module } from "@nestjs/common";
import { AdminAuthController, AdminStaffController } from "./admin.controllers";
import { AuditService } from "./audit.service";
import { AuthService } from "./auth.service";
import { StaffGuard } from "./staff.guard";
import { StaffService } from "./staff.service";

@Module({
  controllers: [AdminAuthController, AdminStaffController],
  providers: [AuditService, AuthService, StaffService, StaffGuard],
  exports: [AuditService, AuthService, StaffGuard],
})
export class AuthModule {}
