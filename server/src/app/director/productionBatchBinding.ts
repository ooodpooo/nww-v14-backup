import type { Prisma } from "@prisma/client";
import type { RunContract } from "../../modules/director";

/** Which implementation owned a director-next chapter batch when the run started. */
export type ProductionBatchImplementation = "legacy" | "kernel";

const TYPE = "production_batch_implementation";

interface Binding {
  version: 1;
  implementation: ProductionBatchImplementation;
  novelId: string;
  scope: string;
  from: number;
  to: number;
}

/**
 * Reads the implementation binding saved before a chapter batch starts.
 *
 * The TS production kernel V2 has been removed; the reader is kept so historical runs
 * can still be recognised and degraded to the legacy batch/projection paths.
 *
 * Missing row => `null`; duplicate rows or a binding that does not match the contract scope => throw.
 */
export async function readProductionBatchImplementation(
  db: Pick<Prisma.TransactionClient, "directorNextEvent">,
  contract: RunContract,
): Promise<ProductionBatchImplementation | null> {
  const rows = await db.directorNextEvent.findMany({
    where: { runId: contract.runId, type: TYPE },
    select: { payloadJson: true },
    take: 2,
  });
  if (!rows.length) return null;
  if (rows.length !== 1) throw new Error("Production implementation binding is ambiguous");
  const value = JSON.parse(rows[0].payloadJson) as Binding;
  const range = contract.chapterRange;
  if (
    value.version !== 1
    || !["legacy", "kernel"].includes(value.implementation)
    || value.novelId !== contract.novelId
    || value.scope !== contract.scope
    || value.from !== range?.from
    || value.to !== range?.to
  ) {
    throw new Error("Production implementation binding has an invalid contract scope");
  }
  return value.implementation;
}