import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrationStep {
  /** Must be >= 1, strictly ascending across the steps array */
  version: number;
  /** Recorded in schema_migrations alongside the version */
  name: string;
  /** SQL DDL executed inside the step transaction */
  sql?: string;
  /** TypeScript function executed inside the step transaction (receives db + tx) */
  fn?: (db: Database, tx: Database) => void | Promise<void>;
  /** Runs outside a transaction (e.g. VACUUM). Ledger row inserted separately after. MUST be idempotent. */
  noTx?: (db: Database) => void | Promise<void>;
}

export interface MigrationOptions {
  /** Name of the ledger table. Default: "schema_migrations" */
  ledger?: string;
  /** Primary table name used for baseline adoption detection */
  primaryTable?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export class DeferredStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeferredStepError";
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateSteps(steps: MigrationStep[]): void {
  if (steps.length === 0) {
    throw new MigrationError("No migration steps provided");
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;

    if (step.version < 1) {
      throw new MigrationError(
        `Step "${step.name}" has version ${step.version}; versions must be >= 1`,
      );
    }

    if (step.name.trim() === "") {
      throw new MigrationError(
        `Step version ${step.version} has an empty name`,
      );
    }

    const actionCount = [step.sql, step.fn, step.noTx].filter(
      (v) => v !== undefined,
    ).length;

    if (actionCount === 0) {
      throw new MigrationError(
        `Step "${step.name}" (v${step.version}) has no action; set exactly one of sql, fn, or noTx`,
      );
    }

    if (actionCount > 1) {
      throw new MigrationError(
        `Step "${step.name}" (v${step.version}) has multiple actions; set exactly one of sql, fn, or noTx`,
      );
    }

    if (i > 0 && step.version <= steps[i - 1]!.version) {
      throw new MigrationError(
        `Step "${step.name}" (v${step.version}) is not strictly ascending after v${steps[i - 1]!.version}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Ledger helpers
// ---------------------------------------------------------------------------

function ensureLedger(db: Database, ledger: string): void {
  db.run(
    `CREATE TABLE IF NOT EXISTS ${ledger} (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`,
  );
}

function appliedVersions(db: Database, ledger: string): Set<number> {
  const rows = db
    .query(`SELECT version FROM ${ledger} ORDER BY version`)
    .all() as Array<{ version: number }>;
  return new Set(rows.map((r) => r.version));
}

function recordStep(
  db: Database,
  ledger: string,
  step: MigrationStep,
): void {
  db.prepare(
    `INSERT INTO ${ledger} (version, name, applied_at) VALUES (?, ?, ?)`,
  ).run(step.version, step.name, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Ahead-check
// ---------------------------------------------------------------------------

function checkNotAhead(applied: Set<number>, steps: MigrationStep[]): void {
  const knownVersions = new Set(steps.map((s) => s.version));
  for (const v of applied) {
    if (!knownVersions.has(v)) {
      throw new MigrationError(
        `Database has applied version ${v} which this build does not know; refusing to run`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Baseline adoption
// ---------------------------------------------------------------------------

function tryBaselineAdoption(
  db: Database,
  ledger: string,
  steps: MigrationStep[],
  applied: Set<number>,
  primaryTable?: string,
): Set<number> {
  if (applied.size > 0 || !primaryTable || steps.length === 0) {
    return applied;
  }

  const row = db
    .query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(primaryTable) as { name: string } | null;

  if (row !== null) {
    const first = steps[0]!;
    recordStep(db, ledger, first);
    return new Set([first.version]);
  }

  return applied;
}

// ---------------------------------------------------------------------------
// Step application
// ---------------------------------------------------------------------------

async function applyStep(
  db: Database,
  ledger: string,
  step: MigrationStep,
): Promise<boolean> {
  try {
    if (step.noTx) {
      await step.noTx(db);
      recordStep(db, ledger, step);
    } else if (step.sql) {
      db.transaction(() => {
        db.exec(step.sql!);
        recordStep(db, ledger, step);
      })();
    } else if (step.fn) {
      db.transaction(() => {
        const result = step.fn!(db, db);
        // bun:sqlite transactions are synchronous — async fn not supported
        // inside the transaction callback. Use noTx for async operations.
        if (result instanceof Promise) {
          throw new MigrationError(
            `Step "${step.name}" (v${step.version}): async fn is not supported inside a transaction; use noTx instead`,
          );
        }
        recordStep(db, ledger, step);
      })();
    }
  } catch (err) {
    if (err instanceof DeferredStepError) {
      return false;
    }
    if (err instanceof MigrationError) {
      throw err;
    }
    throw new MigrationError(
      `Migration step "${step.name}" (v${step.version}) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return true;
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

/**
 * Apply every step whose version is not yet recorded, in ascending order.
 * Safe to call on every process start.
 */
export async function runMigrations(
  db: Database,
  steps: MigrationStep[],
  options?: MigrationOptions,
): Promise<void> {
  const ledger = options?.ledger ?? "schema_migrations";

  validateSteps(steps);
  ensureLedger(db, ledger);

  let applied = appliedVersions(db, ledger);
  checkNotAhead(applied, steps);
  applied = tryBaselineAdoption(
    db,
    ledger,
    steps,
    applied,
    options?.primaryTable,
  );

  for (const step of steps) {
    if (applied.has(step.version)) {
      continue;
    }

    const recorded = await applyStep(db, ledger, step);
    if (recorded) {
      applied.add(step.version);
    }
  }
}
