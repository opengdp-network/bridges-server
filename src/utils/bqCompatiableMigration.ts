/**
 * Exports `bridges.transactions` as newline-delimited JSON (NDJSON) compatible with a
 * BigQuery `bq load --source_format=NEWLINE_DELIMITED_JSON` job. Read-only: does not
 * alter the source table.
 *
 * Progress (last completed id) is checkpointed to `<outputFile>.progress` after every
 * batch, so a crashed/killed run can be resumed by re-running with the same outputFile.
 *
 * Usage: tsx ./src/utils/bqCompatiableMigration.ts <outputFile> [startId]
 * startId defaults to 0, or to the checkpointed id if a progress file already exists.
 */
import fs from "fs";
import { toHex } from "tron-format-address";
import { sql as writeSql, querySql } from "./db";

const BATCH_SIZE = 5000;

// Matches the chain-id convention used by the Across adapter (src/adapters/across/index.ts),
// the only adapter currently populating origin_chain_id/destination_chain_id.
const TRON_CHAIN_ID = "728126428";
const SOLANA_CHAIN_ID = "34268394551451";

// Target BigQuery column types for reference when creating the destination table.
// origin_amount/destination_amount stay STRING: raw token amounts can exceed INT64/FLOAT64 precision.
export const BQ_SCHEMA = {
  id: "INTEGER",
  bridge_id: "STRING",
  bridge_name: "STRING",
  origin_tx_hash: "STRING",
  origin_block_ts: "TIMESTAMP",
  origin_tx_block: "INTEGER",
  tx_from: "STRING",
  tx_to: "STRING",
  origin_token: "STRING",
  destination_token: "STRING",
  origin_amount: "STRING",
  destination_amount: "STRING",
  is_usd_volume: "BOOLEAN",
  txs_counted_as: "INTEGER",
  origin_chain_id: "STRING",
  destination_chain_id: "STRING",
  destination_tx_hash: "STRING",
  destination_block_ts: "TIMESTAMP",
  destination_tx_block: "INTEGER",
  transfer_id: "STRING",
} as const;

interface TransactionRow {
  id: number;
  bridge_id: string;
  bridge_name: string;
  origin_tx_hash: string | null;
  origin_block_ts: Date;
  origin_tx_block: number | null;
  tx_from: string | null;
  tx_to: string | null;
  origin_token: string;
  destination_token: string;
  origin_amount: string;
  destination_amount: string;
  is_usd_volume: boolean | null;
  txs_counted_as: number | null;
  origin_chain_id: string | null;
  destination_chain_id: string | null;
  destination_tx_hash: string | null;
  destination_block_ts: Date;
  destination_tx_block: number | null;
  transfer_id: string | null;
}

const progressFilePath = (outputPath: string): string => `${outputPath}.progress`;

const readCheckpoint = (outputPath: string): number | null => {
  const progressPath = progressFilePath(outputPath);
  if (!fs.existsSync(progressPath)) return null;
  const raw = fs.readFileSync(progressPath, "utf-8").trim();
  const lastId = Number(raw);
  return Number.isFinite(lastId) ? lastId : null;
};

const writeCheckpoint = (outputPath: string, lastId: number): void => {
  fs.writeFileSync(progressFilePath(outputPath), String(lastId));
};

// postgres.js returns timestamptz columns as JS Date objects; BigQuery's JSON loader
// expects TIMESTAMP fields as ISO 8601 strings.
export const transformRowForBigQuery = (row: TransactionRow): Record<string, unknown> => ({
  ...row,
  origin_block_ts: row.origin_block_ts.toISOString(),
  destination_block_ts: row.destination_block_ts.toISOString(),
});

const applyModification = (row: TransactionRow): TransactionRow => {
  const modified = { ...row };

  try {
    if (modified.origin_chain_id === TRON_CHAIN_ID) {
      // make the process idempotent by check if already in base16 then ignore
      if (!/^0x[0-9a-fA-F]+$/.test(modified.origin_token)) {
        modified.origin_token = toHex(modified.origin_token);
      }
      modified.origin_token = modified.origin_token.toLowerCase();
    } else if (modified.origin_chain_id !== SOLANA_CHAIN_ID) {
      modified.origin_token = modified.origin_token.toLowerCase();
      if (modified.tx_from) modified.tx_from = modified.tx_from.toLowerCase();
    }
  
    if (modified.destination_chain_id === TRON_CHAIN_ID) {
      if (!/^0x[0-9a-fA-F]+$/.test(modified.destination_token)) {
        modified.destination_token = toHex(modified.destination_token);
      }
      modified.destination_token = modified.destination_token.toLowerCase();
    } else if (modified.destination_chain_id !== SOLANA_CHAIN_ID) {
      modified.destination_token = modified.destination_token.toLowerCase();
      if (modified.tx_to) modified.tx_to = modified.tx_to.toLowerCase();
    }
  
    return modified;
  } catch (error) {
    console.log("failed for row", row);
    console.log(error)
    throw error
  }
};

const UPDATE_COLUMNS = ["id", "tx_from", "tx_to", "origin_token", "destination_token"] as const;

// One UPDATE statement per page: joins the modified rows in via VALUES, keyed on id.
const updateModifiedRows = async (rows: TransactionRow[]): Promise<void> => {
  if (rows.length === 0) return;
  // postgres.js's array-of-arrays VALUES helper types values as `string | number` only;
  // our rows legitimately contain null/boolean/Date, which it handles fine at runtime.
  const values = rows.map((row) => UPDATE_COLUMNS.map((col) => row[col])) as unknown as (string | number)[][];

  await writeSql`
    UPDATE bridges.transactions AS t
    SET
      tx_from = v.tx_from,
      tx_to = v.tx_to,
      origin_token = v.origin_token,
      destination_token = v.destination_token
    FROM (values ${writeSql(values)}) AS v(id, tx_from, tx_to, origin_token, destination_token)
    WHERE t.id = (v.id)::integer
  `;
};

export const exportTransactionsToBigQueryFormat = async (outputPath: string, startId: number): Promise<number> => {
  const resuming = startId > 0;
  const out = fs.createWriteStream(outputPath, { flags: resuming ? "a" : "w" });
  let lastId = startId;
  let total = 0;

  try {
    while (true) {
      const rows: TransactionRow[] = await querySql`
        SELECT *
        FROM bridges.transactions
        WHERE id >= ${lastId}
        ORDER BY id ASC
        LIMIT ${BATCH_SIZE}
      `;

      if (rows.length === 0) break;

      const modifiedRows = rows.map(applyModification);

      await updateModifiedRows(modifiedRows);

      total += rows.length;
      lastId = rows[rows.length - 1].id;
      writeCheckpoint(outputPath, lastId);
      console.log(`[bq-migration] wrote ${total} rows this run (last id ${lastId})`);

      if (rows.length < BATCH_SIZE) break;
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }

  return total;
};

const outputPath = process.argv[2];
const startIdArg = process.argv[3] ? Number(process.argv[3]) : undefined;

if (!outputPath) {
  console.error("Usage: tsx ./src/utils/bqCompatiableMigration.ts <outputFile> [startId]");
  process.exit(1);
}

(async () => {
  try {
    const startId = startIdArg ?? readCheckpoint(outputPath) ?? 0;
    if (startId > 0) {
      console.log(`[bq-migration] resuming from id ${startId}`);
    }
    const total = await exportTransactionsToBigQueryFormat(outputPath, startId);
    console.log(`[bq-migration] done — ${total} rows written to ${outputPath}`);
  } catch (e: any) {
    console.error("Fatal error:", e.message);
  } finally {
    try {
      await Promise.all([writeSql.end({ timeout: 5 }), querySql.end({ timeout: 5 })]);
    } catch {}
    process.exit(0);
  }
})();