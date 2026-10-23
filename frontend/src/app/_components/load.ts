import { connection } from "next/server";
import { getCatalog } from "@/client/catalog";
import type { DashboardCatalog } from "@/client/catalog";

/** Reads the Phase 1 store at request time, so a static build does not freeze a different process's copy. */
export async function loadCatalog(): Promise<DashboardCatalog> {
  await connection();
  return getCatalog();
}
