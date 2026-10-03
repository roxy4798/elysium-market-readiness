/**
 * CLI entry point.
 *   run      — start the indexer (default)
 *   doctor   — environment / connectivity diagnostics
 *   migrate  — apply database/schema.sql (idempotent)
 */
import { fileURLToPath } from 'node:url';
import { createElysiumClient, isTransientError, withRetry } from './client.js';
import { ConfigError, ELYSIUM_TESTNET_CHAIN_ID, loadConfig, redactUrl, type IndexerConfig } from './config.js';
import { readCheckpoint } from './checkpoint.js';
import { PgStore } from './database.js';
import { RULE, logger } from './logger.js';
import { Scanner, runIndexer, viemChainReader, type IdleReport, type RangeReport } from './scanner.js';
import { TokenValidator, viemContractReader } from './token-validator.js';
import { TRANSFER_TOPIC } from './abi/erc20.js';
import {
  calculateAndStoreDailyMetrics,
  generateDateSequence,
  getIndexedDataBounds,
  loadTokens,
  validateDateString,
} from './metrics/daily-metrics.js';
import { runAssessmentsForDate } from './assessment/assessment-engine.js';
import { startApiServer } from './api/server.js';

const SCHEMA_PATH = fileURLToPath(new URL('../../database/schema.sql', import.meta.url));

function banner(rows: ReadonlyArray<readonly [string, unknown]>): void {
  logger.block('ELYSIUM INDEXER', rows);
}

async function connectDatabase(config: IndexerConfig): Promise<PgStore> {
  const store = new PgStore(config.databaseUrl);
  await withRetry(() => store.ping(), {
    maxRetries: 10,
    baseDelayMs: 1000,
    maxDelayMs: 15_000,
    label: `database ${redactUrl(config.databaseUrl)}`,
  });
  return store;
}

async function cmdRun(config: IndexerConfig): Promise<number> {
  const client = createElysiumClient(config);
  const chain = viemChainReader(client);
  const retry = { maxRetries: config.rpcMaxRetries, baseDelayMs: config.rpcRetryBaseDelayMs };

  const chainId = await withRetry(() => chain.getChainId(), { ...retry, label: 'eth_chainId' });
  if (chainId !== config.chainId) {
    logger.error('chain id mismatch — refusing to index', { expected: config.chainId, actual: chainId, rpc: config.rpcUrl });
    return 2;
  }

  const store = await connectDatabase(config);
  try {
    const missing = await store.missingTables();
    if (missing.length > 0) {
      logger.error('database schema missing — run `npm run migrate`', { missing: missing.join(',') });
      return 2;
    }

    const validator = new TokenValidator(viemContractReader(client), retry);
    const scanner = new Scanner(chain, store, validator, config);
    const latest = await scanner.latestBlock();
    const checkpoint = await store.getCheckpoint();
    const target = latest - BigInt(config.confirmationBlocks);

    banner([
      ['Chain ID', chainId],
      ['RPC', config.rpcUrl],
      ['Database', redactUrl(config.databaseUrl)],
      ['Latest Block', latest],
      ['Checkpoint', checkpoint ?? `none (start at ${config.startBlock})`],
      ['Resume From', checkpoint === null ? config.startBlock : checkpoint + 1n],
      ['Target', config.stopBlock !== null && config.stopBlock < target ? config.stopBlock : target],
      ['Stop Block', config.stopBlock ?? 'none (follow chain head)'],
      ['Batch Size', config.blockBatchSize],
      ['Confirmations', config.confirmationBlocks],
      ['Status', 'RUNNING'],
    ]);

    let stopping = false;
    const onSignal = (sig: string) => {
      if (stopping) process.exit(130);
      stopping = true;
      logger.info(`${sig} received — finishing current range then exiting (press again to force)`);
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));

    let wasIdle = false;
    const summary = await runIndexer(scanner, {
      pollIntervalMs: config.pollIntervalMs,
      maxPermanentFailures: Math.max(1, config.rpcMaxRetries),
      shouldStop: () => stopping,
      onRange: (r: RangeReport) => {
        wasIdle = false;
        logger.block('RANGE COMMITTED', [
          ['Block Range', `${r.fromBlock} → ${r.toBlock}`],
          ['Transfer Logs', r.transferLogs],
          ['New Tokens', r.newTokens],
          ['Updated Holders', r.updatedHolders],
          ['Checkpoint', r.checkpoint],
        ]);
        logger.debug('range detail', {
          rawTransferTopicLogs: r.rawLogs, nonErc20Logs: r.nonErc20Logs, candidates: r.candidates,
          rejectedCandidates: r.rejectedCandidates, inserted: r.insertedTransfers, duplicates: r.duplicateTransfers,
          anomalies: r.anomalies, batchSize: r.batchSize, behindHead: r.targetBlock - r.toBlock,
        });
      },
      onIdle: (r: IdleReport) => {
        if (r.status === 'stopped') logger.info('STOP_BLOCK reached', { checkpoint: r.checkpoint });
        else if (!wasIdle) logger.info('caught up with confirmed head; polling', { latest: r.latestBlock, checkpoint: r.checkpoint });
        wasIdle = true;
      },
    });

    banner([
      ['Ranges', summary.ranges],
      ['Blocks', summary.blocks],
      ['Transfer Logs', summary.transferLogs],
      ['Inserted', summary.insertedTransfers],
      ['New Tokens', summary.newTokens],
      ['Holder Updates', summary.updatedHolders],
      ['Checkpoint', summary.lastCheckpoint ?? 'none'],
      ['Status', 'STOPPED'],
    ]);
    return 0;
  } finally {
    await store.close();
  }
}

async function cmdDoctor(config: IndexerConfig): Promise<number> {
  const results: Array<[string, boolean, string]> = [];
  const check = async (name: string, fn: () => Promise<string>): Promise<boolean> => {
    try {
      const detail = await fn();
      results.push([name, true, detail]);
      return true;
    } catch (err) {
      results.push([name, false, err instanceof Error ? err.message.split('\n')[0] ?? '' : String(err)]);
      return false;
    }
  };

  const client = createElysiumClient(config);
  const chain = viemChainReader(client);
  let latest: bigint | null = null;

  await check('RPC reachable', async () => {
    latest = await chain.getBlockNumber();
    return config.rpcUrl;
  });
  await check('Chain ID correct', async () => {
    const id = await chain.getChainId();
    if (id !== ELYSIUM_TESTNET_CHAIN_ID) throw new Error(`expected ${ELYSIUM_TESTNET_CHAIN_ID}, got ${id}`);
    return String(id);
  });
  await check('Latest block readable', async () => {
    const block = await client.getBlock({ blockTag: 'latest' });
    return `#${block.number} @ ${new Date(Number(block.timestamp) * 1000).toISOString()}`;
  });
  await check('eth_getLogs (Transfer topic)', async () => {
    if (latest === null) throw new Error('latest block unknown');
    const to = latest - BigInt(config.confirmationBlocks);
    const from = to - 99n;
    const logs = await chain.getTransferLogs(from, to);
    return `${logs.length} Transfer-topic logs in ${from}-${to} (topic ${TRANSFER_TOPIC.slice(0, 10)}…)`;
  });

  const store = new PgStore(config.databaseUrl);
  try {
    const dbOk = await check('Database reachable', async () => {
      const { version } = await store.ping();
      return `${redactUrl(config.databaseUrl)} (${version.split(' ').slice(0, 2).join(' ')})`;
    });
    if (dbOk) {
      const tablesOk = await check('Required tables exist', async () => {
        const missing = await store.missingTables();
        if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')} — run npm run migrate`);
        return 'tokens, transfers, balances, indexer_state, daily_metrics, market_assessments, assessment_attestations';
      });
      if (tablesOk) {
        await check('Checkpoint', async () => {
          const cp = await readCheckpoint(store.pool);
          return cp === null ? 'none yet' : `last_processed_block = ${cp}`;
        });
      }
    } else {
      results.push(['Required tables exist', false, 'skipped (database unreachable)']);
    }
  } finally {
    await store.close();
  }

  const width = Math.max(...results.map(([n]) => n.length));
  console.log([RULE, 'ELYSIUM INDEXER — DOCTOR', RULE].join('\n'));
  for (const [name, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(width)} : ${detail}`);
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(RULE);
  console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
  console.log(RULE);
  return failed === 0 ? 0 : 1;
}

async function cmdMigrate(config: IndexerConfig): Promise<number> {
  const store = await connectDatabase(config);
  try {
    await store.applySchema(SCHEMA_PATH);
    const missing = await store.missingTables();
    if (missing.length > 0) throw new Error(`tables still missing after migrate: ${missing.join(', ')}`);
    logger.info('schema applied', { schema: SCHEMA_PATH, database: redactUrl(config.databaseUrl) });
    return 0;
  } finally {
    await store.close();
  }
}

async function cmdMetrics(config: IndexerConfig): Promise<number> {
  const argv = process.argv.slice(3);
  let targetDate: string | undefined;
  let fromDate: string | undefined;
  let toDate: string | undefined;
  let tokenFilter: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date' && argv[i + 1]) targetDate = argv[++i];
    else if (a === '--from' && argv[i + 1]) fromDate = argv[++i];
    else if (a === '--to' && argv[i + 1]) toDate = argv[++i];
    else if (a === '--token' && argv[i + 1]) tokenFilter = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`
Usage: npm run metrics [options]

Options:
  --date <YYYY-MM-DD>             Calculate raw metrics for a single UTC calendar date
  --from <YYYY-MM-DD> --to <date> Calculate raw metrics for an inclusive date range
  --token <address>               Filter calculation to a specific token address
  --help, -h                      Show this help message
`);
      return 0;
    }
  }

  const store = await connectDatabase(config);
  try {
    const bounds = await getIndexedDataBounds(store.pool);
    if (!bounds.minDate || !bounds.maxDate || bounds.transferCount === 0) {
      console.log([
        RULE,
        'ELYSIUM DAILY METRICS — NOTICE',
        RULE,
        '',
        'Status:',
        'INSUFFICIENT_INDEXED_DATA',
        '',
        'Reason:',
        'No indexed ERC-20 transfer logs found in PostgreSQL.',
        'Run the indexer first to populate onchain data: npm run dev',
        '',
        RULE,
      ].join('\n'));
      return 0;
    }

    let datesToProcess: string[] = [];

    if (targetDate) {
      const v = validateDateString(targetDate);
      if (!v.valid) {
        logger.error(`invalid date: ${v.error}`);
        return 2;
      }
      datesToProcess = [v.normalized];
    } else if (fromDate || toDate) {
      if (!fromDate || !toDate) {
        logger.error('both --from and --to must be provided when specifying a date range');
        return 2;
      }
      const vFrom = validateDateString(fromDate);
      const vTo = validateDateString(toDate);
      if (!vFrom.valid || !vTo.valid) {
        logger.error(`invalid date range: ${vFrom.error ?? vTo.error}`);
        return 2;
      }
      try {
        datesToProcess = generateDateSequence(vFrom.normalized, vTo.normalized);
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err));
        return 2;
      }
    } else {
      // Default: process all dates available in indexed transfers
      datesToProcess = generateDateSequence(bounds.minDate, bounds.maxDate);
    }

    // Check if requested dates fall within the indexed range
    const validIndexedDates: string[] = [];
    const outOfBoundsDates: string[] = [];

    for (const d of datesToProcess) {
      if (d < bounds.minDate || d > bounds.maxDate) {
        outOfBoundsDates.push(d);
      } else {
        validIndexedDates.push(d);
      }
    }

    if (outOfBoundsDates.length > 0 && validIndexedDates.length === 0) {
      console.log([
        RULE,
        'ELYSIUM DAILY METRICS — NOTICE',
        RULE,
        '',
        'Date(s):',
        outOfBoundsDates.join(', '),
        '',
        'Status:',
        'INSUFFICIENT_INDEXED_DATA',
        '',
        'Reason:',
        `Requested date(s) fall outside the indexed block data range (${bounds.minDate} to ${bounds.maxDate}).`,
        `Earliest indexed transfer: ${bounds.minDate}. Checkpoint reached: block #${bounds.lastProcessedBlock ?? 'unknown'}.`,
        'Phase 1 indexer only stores verified onchain blocks up to the checkpoint.',
        '',
        RULE,
      ].join('\n'));
      return 0;
    }

    const tokens = await loadTokens(store.pool, tokenFilter);
    const tokenMap = new Map(tokens.map((t) => [t.address.toLowerCase(), t]));

    const computed = await calculateAndStoreDailyMetrics(store.pool, validIndexedDates, tokenFilter);

    for (const m of computed) {
      const tok = tokenMap.get(m.tokenAddress.toLowerCase());
      const symbol = tok?.symbol ?? tok?.name ?? m.tokenAddress;

      console.log([
        RULE,
        'ELYSIUM DAILY METRICS',
        RULE,
        '',
        'Date:',
        m.date,
        '',
        'Token:',
        symbol,
        '',
        'Holders:',
        m.holderCount,
        '',
        'New Holders:',
        m.newHolders,
        '',
        'Active Holders:',
        m.activeHolders,
        '',
        'Transfers:',
        m.transferCount,
        '',
        'Unique Senders:',
        m.uniqueSenders,
        '',
        'Unique Receivers:',
        m.uniqueReceivers,
        '',
        'Top 1:',
        m.top1Concentration !== null ? m.top1Concentration.toFixed(2) : 'N/A',
        '',
        'Top 5:',
        m.top5Concentration !== null ? m.top5Concentration.toFixed(2) : 'N/A',
        '',
        'Top 10:',
        m.top10Concentration !== null ? m.top10Concentration.toFixed(2) : 'N/A',
        '',
        'Status:',
        'CALCULATED',
        '',
        RULE,
      ].join('\n'));
    }

    if (outOfBoundsDates.length > 0) {
      console.log(`Notice: skipped ${outOfBoundsDates.length} date(s) outside indexed range: ${outOfBoundsDates.join(', ')}`);
    }

    logger.info('metrics calculation completed', {
      dates: validIndexedDates.length,
      records: computed.length,
      tokens: tokens.length,
    });
    return 0;
  } finally {
    await store.close();
  }
}

async function cmdAssess(config: IndexerConfig): Promise<number> {
  const argv = process.argv.slice(3);
  let targetDate: string | undefined;
  let tokenFilter: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date' && argv[i + 1]) targetDate = argv[++i];
    else if (a === '--token' && argv[i + 1]) tokenFilter = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`
Usage: npm run assess [options]

Options:
  --date <YYYY-MM-DD>             Assessment date (UTC calendar date, default: latest indexed date)
  --token <address>               Filter assessment to a specific token address
  --help, -h                      Show this help message
`);
      return 0;
    }
  }

  const store = await connectDatabase(config);
  try {
    const bounds = await getIndexedDataBounds(store.pool);
    if (!targetDate) {
      if (!bounds.maxDate) {
        logger.error('no indexed daily metrics found — run npm run metrics first');
        return 2;
      }
      targetDate = bounds.maxDate;
    }

    const v = validateDateString(targetDate);
    if (!v.valid) {
      logger.error(`invalid date: ${v.error}`);
      return 2;
    }

    const tokens = await loadTokens(store.pool, tokenFilter);
    const tokenMap = new Map(tokens.map((t) => [t.address.toLowerCase(), t]));

    const assessments = await runAssessmentsForDate(store.pool, v.normalized, tokenFilter);

    const DIVIDER = '────────────────────────';

    for (const a of assessments) {
      const tok = tokenMap.get(a.tokenAddress.toLowerCase());
      const tokenDisplay = tok?.symbol ? `${tok.symbol} (${a.tokenAddress})` : a.tokenAddress;

      console.log(['', 'ASSET ASSESSMENT', DIVIDER].join('\n'));
      console.log(`Token: ${tokenDisplay}`);
      console.log(`Date: ${a.assessmentDate}\n`);

      if (a.status === 'INSUFFICIENT_DATA') {
        console.log('Status: INSUFFICIENT_DATA');
        console.log(`Reason: ${a.reason ?? 'INSUFFICIENT_HISTORICAL_WINDOW'}`);
        console.log(`Data Window: ${a.dataWindowDays} days (minimum 7 required)`);
      } else {
        const healthStr = a.healthScore !== null ? a.healthScore.toFixed(1) : 'N/A';
        const momStr =
          a.momentum !== null ? (a.momentum >= 0 ? `+${a.momentum.toFixed(1)}` : a.momentum.toFixed(1)) : 'N/A';

        console.log(`Market Health: ${healthStr} / 100`);
        console.log(`Status: ${a.status}`);
        console.log(`Market Momentum: ${momStr}\n`);

        if (a.components) {
          console.log('Components:');
          console.log(`Holder Health: ${a.components.holderHealth.toFixed(1)}`);
          console.log(`Transfer Activity: ${a.components.transferActivity.toFixed(1)}`);
          console.log(`Address Activity: ${a.components.addressActivity.toFixed(1)}`);
          console.log(`Concentration: ${a.components.concentrationScore.toFixed(1)}`);
          console.log(`Consistency: ${a.components.consistencyScore.toFixed(1)}\n`);
        }

        console.log(`Data Window: ${a.dataWindowDays} days`);
      }
      console.log(DIVIDER);
    }

    logger.info('assessments completed', {
      date: v.normalized,
      count: assessments.length,
    });
    return 0;
  } finally {
    await store.close();
  }
}

async function cmdServe(config: IndexerConfig): Promise<number> {
  const argv = process.argv.slice(3);
  let port = Number(process.env['PORT'] ?? 3000);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--port' || a === '-p') && argv[i + 1]) port = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(`
Usage: npm run serve [options]

Options:
  --port, -p <number>  Port to listen on (default: 3000)
  --help, -h           Show this help message
`);
      return 0;
    }
  }

  const store = await connectDatabase(config);
  try {
    const { port: actualPort } = await startApiServer(store.pool, { port });
    console.log(`API server listening at http://localhost:${actualPort}`);
    console.log('Endpoints:');
    console.log('  GET /v1/tokens/:address/assessment?date=YYYY-MM-DD');
    console.log('  POST /v1/assessments/:assessmentId/attest');
    console.log('  GET /v1/assessments/:assessmentId/verify');
    console.log('  GET /health');

    await new Promise<void>((resolve) => {
      const shutdown = () => {
        logger.info('shutting down api server');
        resolve();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });

    return 0;
  } finally {
    await store.close();
  }
}

async function cmdAttest(config: IndexerConfig): Promise<number> {
  const argv = process.argv.slice(3);
  let assessmentId: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--id' || a === '-i') && argv[i + 1]) assessmentId = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`
Usage: npm run attest [options]

Options:
  --id, -i <assessmentId>  Assessment ID (0x followed by 64 hex characters)
  --help, -h               Show this help message
`);
      return 0;
    }
  }

  if (!assessmentId) {
    logger.error('missing required --id parameter');
    return 2;
  }

  const store = await connectDatabase(config);
  try {
    const { attestAssessment } = await import('./attestation/attestation-service.js');
    const res = await attestAssessment(store.pool, assessmentId);
    console.log([
      RULE,
      'ASSESSMENT ONCHAIN ATTESTATION',
      RULE,
      `Assessment ID:    ${res.assessment_id}`,
      `Contract Address: ${res.contract_address}`,
      `Chain ID:         ${res.chain_id}`,
      `Tx Hash:          ${res.transaction_hash}`,
      `Block Number:     ${res.block_number}`,
      `Attester:         ${res.attester}`,
      `Assessment Hash:  ${res.assessment_hash}`,
      RULE,
    ].join('\n'));
    return 0;
  } catch (err: unknown) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    await store.close();
  }
}

async function main(): Promise<number> {
  const cmd = process.argv[2] ?? 'run';
  let config: IndexerConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(`configuration error: ${err.message}`);
      return 2;
    }
    throw err;
  }
  logger.setLevel(config.logLevel);

  switch (cmd) {
    case 'run':
      return cmdRun(config);
    case 'doctor':
      return cmdDoctor(config);
    case 'migrate':
      return cmdMigrate(config);
    case 'metrics':
      return cmdMetrics(config);
    case 'assess':
      return cmdAssess(config);
    case 'serve':
      return cmdServe(config);
    case 'attest':
      return cmdAttest(config);
    default:
      logger.error(`unknown command "${cmd}" (expected run | doctor | migrate | metrics | assess | serve | attest)`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    logger.error('fatal', { error: err, transient: isTransientError(err) });
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  },
);
