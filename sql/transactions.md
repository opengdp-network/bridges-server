# `bridges.transactions` — schema summary

One row = one complete cross-chain transfer (both origin and destination legs), not one on-chain event. This is a deliberate change from the older model where a row represented a single deposit *or* withdrawal event.

## Columns

| Column | Type | Nullable | Meaning |
|---|---|---|---|
| `id` | INT identity | no | PK |
| `bridge_id` | uuid | no | FK → `bridges.config.id` |
| `bridge_name` | varchar | **no** | Denormalized adapter key (e.g. `"across"`), matching `bridges.config.bridge_name` for `bridge_id`. Lets consumers query/dedupe without joining `bridges.config` |
| `origin_tx_hash` | varchar | yes | Tx hash on the origin (source) chain |
| `origin_block_ts` | timestamptz | **no** | Block time of the origin-side tx |
| `origin_tx_block` | integer | yes | Block number of the origin-side tx |
| `tx_from` | varchar | yes | Sender address |
| `tx_to` | varchar | yes | Recipient address |
| `origin_token` | varchar | **no** | Token sent on the origin chain |
| `destination_token` | varchar | **no** | Token received on the destination chain (may differ from `origin_token`, e.g. swap-bridges) |
| `origin_amount` | varchar | **no** | Amount sent, in `origin_token` units (stringified, not USD) |
| `destination_amount` | varchar | **no** | Amount received, in `destination_token` units — can differ from `origin_amount` due to fees/slippage |
| `is_usd_volume` | boolean | yes | If set, amounts should be treated as USD values directly rather than token units |
| `txs_counted_as` | integer | yes | Overrides how many txs this row counts as in hourly/daily tx-count aggregation |
| `origin_chain_id` | bigint | yes | Numeric chain ID of the origin chain |
| `destination_chain_id` | bigint | yes | Numeric chain ID of the destination chain |
| `destination_tx_hash` | varchar | yes | Tx hash on the destination chain (e.g. the relayer fill tx) |
| `destination_block_ts` | timestamptz | **no** | Block time of the destination-side tx |
| `destination_tx_block` | integer | yes | Block number of the destination-side tx |
| `transfer_id` | varchar | yes at DB level, **required by app validation** | Adapter-supplied unique transfer identifier (e.g. Across `depositId`) — see below |

## Key convention: fields are absolute, not relative to deposit/withdrawal

`origin_*` always means the source-chain leg and `destination_*` always means the destination-chain leg, regardless of which side an adapter's on-chain event was detected on. There is no `is_deposit` column — that distinction from the old schema is gone.

## Uniqueness

Only one constraint governs deduplication: **`UNIQUE (bridge_name, transfer_id)`**. The older composite constraint on `(bridge_id, origin_tx_hash, destination_tx_hash, tx_from, tx_to)` has been removed. This means:

- `transfer_id` (scoped per `bridge_name`) is the sole thing preventing duplicate rows.
- Two rows with the same `bridge_name` but no `transfer_id` collision will NOT be deduplicated by the DB — the app-level validation in `write.ts` (`sanitizeTransactionParams`) makes `transfer_id` a required field precisely to close this gap.
- `transfer_id` exists because a single on-chain tx can contain multiple distinct transfers (batched deposits, multicalls, batched relayer fills) that would otherwise share the same tx hash / from / to.
- Both `insertTransactionRow`'s and `insertTransactionRows`' `ON CONFLICT`/`DO UPDATE SET` clauses target `(bridge_name, transfer_id)`, matching the DB constraint.
- **Known inconsistency:** `insertTransactionRows`' in-memory dedup step (before the SQL insert) still keys on `` `${tx.bridge_id}-${tx.transfer_id}` ``, not `bridge_name`. Since `bridge_id` and `bridge_name` should always correspond 1:1 for a given adapter/chain pair, this is likely harmless in practice, but it no longer matches the actual DB constraint — worth fixing for consistency.

## What's actually wired up today

Only the **Across** adapter (`src/adapters/across/index.ts`) populates the full row: it derives `transfer_id` from Across's own `depositId`, and fills in `destination_token`/`destination_amount`/`destination_tx_block`/`destination_block_ts` directly from the Across API response (which already knows both legs of the transfer).

Every other adapter still produces the older, single-sided `EventData` shape (`src/utils/types.ts`) — `token`/`amount`/`txHash`/`blockNumber`/`chain`/`timestamp` map to the `origin_*` columns, and the `destination_*` counterparts (`destinationToken`, `destinationAmount`, `destinationBlock`, `destinationBlockTs`, `destinationChainId`, `destinationTxHash`) are optional on `EventData` and left `undefined` unless an adapter sets them.

`bridge_name` is the one column that works for every adapter without any per-adapter change: `adapter.ts` populates it directly from `bridgeDbName`, the adapter registry key already in scope at the insert call — it doesn't come through `EventData` at all.

**Consequence:** because `destination_token`, `destination_amount`, `destination_block_ts`, and `transfer_id` are required by `write.ts`'s validation, any adapter that doesn't populate them will fail every insert with `is missing required field <x>` until it's migrated to supply them. This is intentional (fail loud rather than insert incomplete/fabricated data) but means most of the ~100 adapters are currently non-functional against this schema.

## Relevant files

- `sql/data.sql` — schema source of truth
- `src/utils/types.ts` — `EventData`, the shape adapters return
- `src/utils/adapter.ts` — maps `EventData` → insert params (see the block starting around the `groupedEvents` loop)
- `src/utils/wrappa/postgres/write.ts` — `TransactionInsertParams`, validation (`sanitizeTransactionParams`), and the actual `INSERT`/`ON CONFLICT` logic (conflict target is `(bridge_name, transfer_id)`)
- `src/adapters/across/index.ts` — the only adapter currently populating the full row; use as the reference implementation for migrating others
