import type { Prisma } from "@prisma/client";

/** Money and rates leave the API as decimal strings, never as floats. */
export const decimalString = (value: Prisma.Decimal | null | undefined, places = 2): string | null =>
  value == null ? null : value.toFixed(places);
