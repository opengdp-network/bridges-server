import postgres from "postgres";
import { sql } from "../../db";
import { NonRetryableError } from "../../errors";

const PG_INT_MAX = 2147483647;

const normalizeBlockNumber = (block: number | null): number | null => {
  if (block == null) return block;
  if (block > PG_INT_MAX) {
    console.warn(`tx_block ${block} is out of INTEGER range; setting to 0`);
    return 0;
  }
  return block;
};

const txTypes = {
  bridge_id: "string",
  bridge_name: "string",
  origin_tx_hash: "string",
  origin_block_ts: "number",
  origin_tx_block: "number",
  tx_from: "string",
  tx_to: "string",
  origin_token: "string",
  destination_token: "string",
  origin_amount: "string",
  destination_amount: "string",
  is_usd_volume: "boolean",
  txs_counted_as: "number",
  origin_chain_id: "string",
  destination_chain_id: "string",
  destination_tx_hash: "string",
  destination_block_ts: "number",
  destination_tx_block: "number",
  transfer_id: "string",
} as { [key: string]: string };

export type TransactionInsertParams = {
  bridge_id: string;
  bridge_name: string;
  origin_tx_hash: string | null;
  origin_block_ts: number;
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
  destination_block_ts: number;
  destination_tx_block: number | null;
  transfer_id: string;
};

const requiredTransactionFields = new Set([
  "bridge_id",
  "bridge_name",
  "origin_block_ts",
  "origin_token",
  "destination_token",
  "origin_amount",
  "destination_amount",
  "destination_block_ts",
  "transfer_id",
]);

export const sanitizeTransactionParams = (
  params: TransactionInsertParams,
  allowNullTxValues: boolean
): TransactionInsertParams => {
  const sanitized = {
    ...params,
    origin_tx_block: normalizeBlockNumber(params.origin_tx_block),
    destination_tx_block: normalizeBlockNumber(params.destination_tx_block),
  } as Record<string, any>;
  const bridgeId = typeof params?.bridge_id === "string" ? params.bridge_id : "unknown";

  for (const [key, expectedType] of Object.entries(txTypes)) {
    const value = sanitized[key];
    if (value === undefined) {
      if (allowNullTxValues && !requiredTransactionFields.has(key)) {
        sanitized[key] = null;
        continue;
      }
      throw new NonRetryableError(`Transaction for bridgeID ${bridgeId} is missing required field ${key}.`);
    }
    if (value === null) {
      if (requiredTransactionFields.has(key) || !allowNullTxValues) {
        throw new NonRetryableError(`Transaction for bridgeID ${bridgeId} has a null value for ${key}.`);
      }
      continue;
    }
    if (typeof value !== expectedType) {
      throw new NonRetryableError(
        `Transaction for bridgeID ${bridgeId} has ${typeof value} for ${key} when it must be ${expectedType}.`
      );
    }
  }

  for (const key of [
    "bridge_id",
    "bridge_name",
    "origin_token",
    "destination_token",
    "origin_amount",
    "destination_amount",
  ]) {
    if (sanitized[key].length === 0) {
      throw new NonRetryableError(`Transaction for bridgeID ${bridgeId} has an empty value for ${key}.`);
    }
  }
  if (!Number.isFinite(sanitized.origin_block_ts)) {
    throw new NonRetryableError(
      `Transaction for bridgeID ${bridgeId} has an invalid origin timestamp ${sanitized.origin_block_ts}.`
    );
  }
  if (!Number.isFinite(sanitized.destination_block_ts)) {
    throw new NonRetryableError(
      `Transaction for bridgeID ${bridgeId} has an invalid destination timestamp ${sanitized.destination_block_ts}.`
    );
  }

  return sanitized as TransactionInsertParams;
};

export const insertTransactionRow = async (
  sql: postgres.TransactionSql<{}>,
  allowNullTxValues: boolean,
  params: TransactionInsertParams,
  onConflict: "ignore" | "error" | "upsert" = "error"
) => {
  const safeParams = sanitizeTransactionParams(params, allowNullTxValues);
  let sqlCommand = sql`
  insert into bridges.transactions ${sql(safeParams)}
`;
  if (onConflict === "ignore") {
    sqlCommand = sql`
      insert into bridges.transactions ${sql(safeParams)}
      ON CONFLICT DO NOTHING
    `;
  } else if (onConflict === "upsert") {
    sqlCommand = sql`
      insert into bridges.transactions ${sql(safeParams)}
      ON CONFLICT (bridge_name, transfer_id)
      DO UPDATE SET ${sql(safeParams)}
    `;
  }

  for (let i = 0; i < 5; i++) {
    try {
      await sqlCommand;
      return;
    } catch (e) {
      if (i >= 4) {
        throw new Error(`Could not insert transaction row for bridge ${safeParams.bridge_id}.`);
      } else {
        console.error(`id: ${safeParams.bridge_id}, txHash: ${safeParams.origin_tx_hash}`, e);
        continue;
      }
    }
  }
};

export const insertConfigRow = async (
  sql: postgres.TransactionSql<{}>,
  params: {
    id?: string;
    bridge_name: string;
    chain: string;
    destination_chain?: string;
  }
) => {
  Object.entries(params).map(([key, val]) => {
    if (key !== "id" && key !== "destination_chain") {
      if (typeof val !== "string") {
        throw new Error(`Config for bridge ${params.bridge_name} has a null value or wrong type for ${key}.`);
      }
    }
  });
  let paramsToAvoidTsError = { bridge_name: params.bridge_name, chain: params.chain } as any;
  if (params.id) {
    paramsToAvoidTsError = {
      ...paramsToAvoidTsError,
      id: params.id,
    };
  }
  if (params.destination_chain) {
    paramsToAvoidTsError = {
      ...paramsToAvoidTsError,
      destination_chain: params.destination_chain,
    };
  }
  for (let i = 0; i < 5; i++) {
    try {
      await sql`
        INSERT INTO bridges.config ${sql(paramsToAvoidTsError)}
        ON CONFLICT (bridge_name, chain) DO NOTHING;
      `;
      return;
    } catch (e) {
      if (i >= 4) {
        throw new Error(`Could not insert config row for ${params.bridge_name} on ${params.chain}`);
      } else {
        console.error(params.bridge_name, e);
        continue;
      }
    }
  }
};

export const insertHourlyAggregatedRow = async (
  sql: postgres.TransactionSql<{}>,
  allowNullTxValues: boolean,
  params: {
    bridge_id: string;
    ts: number;
    total_tokens_deposited: string[] | null;
    total_tokens_withdrawn: string[] | null;
    total_deposited_usd: number | null;
    total_withdrawn_usd: number | null;
    total_deposit_txs: number | null;
    total_withdrawal_txs: number | null;
    total_address_deposited: string[] | null;
    total_address_withdrawn: string[] | null;
  }
) => {
  Object.entries(params).map(([key, val]) => {
    if (val == null) {
      if (allowNullTxValues) {
        console.info(`Transaction for bridgeID ${params.bridge_id} has a null value for ${key}.`);
      } else {
        throw new Error(`Transaction for bridgeID ${params.bridge_id} has a null value for ${key}.`);
      }
    }
  });
  for (let i = 0; i < 5; i++) {
    try {
      await sql`
        insert into bridges.hourly_aggregated ${sql(params)}
        ON CONFLICT (bridge_id, ts)
        DO UPDATE SET ${sql(params)}
      `;
      return;
    } catch (e) {
      if (i >= 4) {
        throw new Error(
          `Could not insert hourly aggregated row for bridge ${params.bridge_id} at timestamp ${params.ts}.`
        );
      } else {
        console.error(params.bridge_id, e);
        continue;
      }
    }
  }
};

// can combine with insertHourly
export const insertDailyAggregatedRow = async (
  sql: postgres.TransactionSql<{}>,
  allowNullTxValues: boolean,
  params: {
    bridge_id: string;
    ts: number;
    total_tokens_deposited: string[] | null;
    total_tokens_withdrawn: string[] | null;
    total_deposited_usd: number | null;
    total_withdrawn_usd: number | null;
    total_deposit_txs: number | null;
    total_withdrawal_txs: number | null;
    total_address_deposited: string[] | null;
    total_address_withdrawn: string[] | null;
  }
) => {
  Object.entries(params).map(([key, val]) => {
    if (val == null) {
      if (allowNullTxValues) {
        console.info(`Transaction for bridgeID ${params.bridge_id} has a null value for ${key}.`);
      } else {
        throw new Error(`Transaction for bridgeID ${params.bridge_id} has a null value for ${key}.`);
      }
    }
  });
  for (let i = 0; i < 5; i++) {
    try {
      await sql`
          insert into bridges.daily_aggregated ${sql(params)}
          ON CONFLICT (bridge_id, ts)
          DO UPDATE SET ${sql(params)}
        `;
      return;
    } catch (e) {
      if (i >= 4) {
        throw new Error(
          `Could not insert daily aggregated row for bridge ${params.bridge_id} at timestamp ${params.ts}.`
        );
      } else {
        console.error(params.bridge_id, e);
        continue;
      }
    }
  }
};

export const insertLargeTransactionRow = async (
  sql: postgres.TransactionSql<{}>,
  params: {
    tx_pk: number;
    ts: number;
    usd_value: number;
  }
) => {
  for (let i = 0; i < 5; i++) {
    try {
      await sql`
          insert into bridges.large_transactions ${sql(params)}
          ON CONFLICT (tx_pk)
          DO UPDATE SET ${sql(params)}
        `;
      return;
    } catch (e) {
      if (i >= 4) {
        throw new Error(
          `Could not insert large transaction row for tx with pk ${params.tx_pk} and timestamp ${params.ts}.`
        );
      } else {
        console.error(params.tx_pk, e);
        continue;
      }
    }
  }
};

export const insertErrorRow = async (params: {
  ts: number | null;
  target_table: string;
  keyword: string | null; // 'data', 'critical', 'missingBlocks'
  error: string | null;
}) => {
  for (let i = 0; i < 5; i++) {
    try {
      await sql`
          insert into bridges.errors ${sql(params)}
          ON CONFLICT (ts,error)
          DO UPDATE SET ${sql(params)}
        `;
      return;
    } catch (e) {
      if (i >= 4) {
        throw new Error(`Could not insert error row at timestamp ${params.ts} with error ${params.error}.`);
      } else {
        console.error(params.error, e);
        continue;
      }
    }
  }
};

export const insertOrUpdateTokenWithoutPrice = async (token: string, symbol: string) => {
  try {
    await sql`
        INSERT INTO bridges.tokens_without_price ${sql({ token, occurrence_count: 1, symbol })}
        ON CONFLICT (token)
        DO UPDATE SET occurrence_count = bridges.tokens_without_price.occurrence_count + 1, symbol = ${symbol};
      `;
  } catch (e) {
    console.error(`Could not insert or update token without price: ${token}`, e);
  }
};

export const insertTransactionRows = async (
  sql: postgres.TransactionSql<{}>,
  allowNullTxValues: boolean,
  transactions: TransactionInsertParams[],
  onConflict: "ignore" | "error" | "upsert" = "error",
  rejectInvalid: boolean = false
) => {
  const validTransactions = transactions.flatMap((tx) => {
    let sanitized: TransactionInsertParams;
    try {
      sanitized = sanitizeTransactionParams(tx, allowNullTxValues);
    } catch (error) {
      if (rejectInvalid) throw error;
      console.error(`[VALIDATION] Skipping invalid transaction: ${(error as Error).message}`);
      return [];
    }
    for (const tsField of ["origin_block_ts", "destination_block_ts"] as const) {
      const tsValue = sanitized[tsField];
      const isValidTimestamp = Number.isFinite(tsValue) && tsValue > 0 && tsValue < 2147483647000;
      if (!isValidTimestamp) {
        if (rejectInvalid) {
          throw new NonRetryableError(
            `Invalid ${tsField} value ${tsValue} for transaction ${sanitized.origin_tx_hash ?? "without hash"}.`
          );
        }
        console.error(
          `Invalid ${tsField} value ${tsValue} for transaction: bridge_id=${sanitized.bridge_id}, origin_tx_hash=${sanitized.origin_tx_hash}`
        );
        return [];
      }
    }
    return [sanitized];
  });

  const uniqueTransactions = validTransactions.reduce((acc, tx) => {
    const key = `${tx.bridge_id}-${tx.transfer_id}`;
    if (!acc.has(key)) {
      acc.set(key, tx);
    }
    return acc;
  }, new Map());

  const dedupedTransactions = Array.from(uniqueTransactions.values());

  if (dedupedTransactions.length === 0) {
    console.warn("No valid transactions to insert after validation and deduplication");
    return;
  }

  const sanitizedTransactions = dedupedTransactions;

  let sqlCommand;
  if (onConflict === "ignore") {
    sqlCommand = sql`
      INSERT INTO bridges.transactions ${sql(sanitizedTransactions)}
      ON CONFLICT DO NOTHING
    `;
  } else if (onConflict === "upsert") {
    sqlCommand = sql`
      INSERT INTO bridges.transactions ${sql(sanitizedTransactions)}
      ON CONFLICT (bridge_name, transfer_id)
      DO UPDATE SET
        bridge_name = EXCLUDED.bridge_name,
        origin_tx_hash = EXCLUDED.origin_tx_hash,
        origin_block_ts = EXCLUDED.origin_block_ts,
        origin_tx_block = EXCLUDED.origin_tx_block,
        tx_from = EXCLUDED.tx_from,
        tx_to = EXCLUDED.tx_to,
        origin_token = EXCLUDED.origin_token,
        destination_token = EXCLUDED.destination_token,
        origin_amount = EXCLUDED.origin_amount,
        destination_amount = EXCLUDED.destination_amount,
        is_usd_volume = EXCLUDED.is_usd_volume,
        txs_counted_as = EXCLUDED.txs_counted_as,
        origin_chain_id = EXCLUDED.origin_chain_id,
        destination_chain_id = EXCLUDED.destination_chain_id,
        destination_tx_hash = EXCLUDED.destination_tx_hash,
        destination_block_ts = EXCLUDED.destination_block_ts,
        destination_tx_block = EXCLUDED.destination_tx_block
    `;
  } else {
    sqlCommand = sql`
      INSERT INTO bridges.transactions ${sql(sanitizedTransactions)}
    `;
  }

  for (let i = 0; i < 5; i++) {
    try {
      await sqlCommand;
      return;
    } catch (e) {
      if (i >= 4) {
        throw new Error(`Could not insert transaction rows in batch.`);
      } else {
        console.error(`Failed batch insert attempt ${i + 1}:`, e);
        continue;
      }
    }
  }
};
