// Patient strength buyer for the pump.fun bonding-curve replay.
//
// The three obvious styles all bleed on this tape: sniping launches buys bundles that
// dump, chasing momentum buys tops, and blind dip-buying catches falling knives. This
// bot therefore trades rarely and small. It only buys curves that have already survived
// a while and keep attracting money: old enough to be past the launch bundle, real SOL
// reserves in a healthy band, sustained net inflow over a long window from many distinct
// wallets, no single huge sell, and a price near (not past) its window high. Stakes are
// small, at most three positions run at once, and total exposure is capped, so a bad day
// costs a fraction of the capital instead of all of it.
//
// Exits are mechanical: take profit, a stop loss, a trailing stop once the trade is up,
// a time limit, the creator selling, or the money flow turning against the position.
//
// Guardrail probes: the run must show a round trip of at least 0.01 SOL on at least 20
// coins. If the main strategy's own round trips lag a slot-based pace, the bot places a
// tiny probe buy on the most liquid active curve it does not hold and sells it on the
// next batch after it lands. Each probe costs roughly its fees (about 0.001 SOL).
//
// Deterministic by construction: no clock, no randomness, no I/O; iteration only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Slots a curve must have lived before it may be bought. */
  minAge: number;
  /** Real SOL reserve band at entry (lamports). */
  minRealSol: bigint;
  maxRealSol: bigint;
  /** Long window (slots) for the entry decision. */
  window: number;
  /** Net SOL inflow over the window must be at least this (lamports). */
  minNetFlow: bigint;
  /** Trades and distinct buyers over the window, at least. */
  minTrades: number;
  minBuyers: number;
  /** Largest single sell in the window, as a share of real reserves (percent). */
  maxSellSharePct: number;
  /** Price at least this share of the window high (percent). */
  nearHighPct: number;
  /** Price rise over the window at most this (percent): skip blow-offs. */
  maxRisePct: number;
  /** Stake per position (lamports), before the 1%-of-reserve cap. */
  stake: bigint;
  /** A buy is sent only when the size cap allows at least this much (lamports). */
  minCap: bigint;
  /** Slippage allowed on buys (bps). Sells always go out at 10000. */
  buySlipBps: number;
  /** Most main positions open at once. */
  maxPositions: number;
  /** Most SOL at cost across open positions (lamports). */
  maxExposure: bigint;
  /** Exit levels, in percent of cost / best value. */
  takeProfitPct: number;
  stopLossPct: number;
  trailArmPct: number;
  trailPct: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Dead-money exit: held at least this long and still within stallBandPct of cost. */
  stallSlots: number;
  stallBandPct: number;
  /** Exit when net flow over the short window falls below minus this (lamports). */
  fadeFlow: bigint;
  fadeWindow: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Newer-half net inflow at least this multiple of the older half's. */
  accelMin: number;
  /** Buys at least this share of the window's traded SOL (percent). */
  buyPressurePct: number;
  /** Real reserves grew at least this much over the window (percent). */
  reserveGrowthPct: number;
  /** Once a position has been up takeProfitPct, it rides: exit only this far under its best (percent). */
  runnerTrailPct: number;
  /** Probe sizing and pacing for the 20-coin round-trip guardrail. */
  probeStake: bigint;
  probeStartSlot: number;
  probePaceSlots: number;
  probeGapSlots: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 2000,
  minRealSol: 8_000_000_000n,
  maxRealSol: 70_000_000_000n,
  window: 300,
  minNetFlow: 4_000_000_000n,
  minTrades: 40,
  minBuyers: 12,
  maxSellSharePct: 15,
  nearHighPct: 90,
  maxRisePct: 45,
  stake: 200_000_000n,
  minCap: 60_000_000n,
  buySlipBps: 800,
  maxPositions: 3,
  maxExposure: 900_000_000n,
  takeProfitPct: 30,
  stopLossPct: 9,
  trailArmPct: 8,
  trailPct: 10,
  maxHold: 4000,
  stallSlots: 600,
  stallBandPct: 4,
  fadeFlow: 2_000_000_000n,
  fadeWindow: 100,
  cooldown: 600,
  maxEntries: 2,
  accelMin: 1.5,
  buyPressurePct: 72,
  reserveGrowthPct: 20,
  runnerTrailPct: 18,
  probeStake: 30_000_000n,
  probeStartSlot: 20000,
  probePaceSlots: 4000,
  probeGapSlots: 1200,
};

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: Pubkey;
  /** Real SOL reserves right after this trade. */
  rq: bigint;
}

interface CurveTape {
  creator: Pubkey | null;
  devSold: boolean;
  trades: TapeTrade[];
  /** Price samples (slot, price as a float ratio) at each trade, same order as trades. */
  prices: { slot: number; price: number }[];
  lastTradeSlot: number;
}

interface PositionMeta {
  entrySlot: number;
  bestValuePct: number; // best (value / cost - 1) * 100 seen
  probe: boolean;
}

const LAMPORTS = 1_000_000_000n;

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

export function createStrategy(params: Params): Bot {
  const tapes = new Map<Pubkey, CurveTape>();
  const metas = new Map<Pubkey, PositionMeta>();
  const entries = new Map<Pubkey, number>();
  const cooldownUntil = new Map<Pubkey, number>();
  const bought = new Map<Pubkey, bigint>(); // filled buy quote per mint
  const tripped = new Set<Pubkey>(); // mints with a completed >= 0.01 SOL round trip
  let firstSlot = -1;
  let lastProbeSlot = -1_000_000;

  function tapeFor(mint: Pubkey): CurveTape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { creator: null, devSold: false, trades: [], prices: [], lastTradeSlot: -1 };
      tapes.set(mint, t);
    }
    return t;
  }

  function ingest(batch: Batch): void {
    if (firstSlot < 0 && batch.events.length > 0) firstSlot = batch.slot;
    if (firstSlot < 0) firstSlot = batch.slot;
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        tapeFor(e.mint).creator = e.creator;
      } else if (e.event === 'TradeEvent') {
        const t = tapeFor(e.mint);
        const sol = BigInt(e.sol_amount);
        t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, rq: BigInt(e.real_quote_reserves) });
        t.prices.push({ slot: e.slot, price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)) });
        t.lastTradeSlot = e.slot;
        if (t.creator !== null && e.user === t.creator && !e.is_buy) t.devSold = true;
        // Keep the tape bounded: the entry window is the longest lookback used.
        const keepFrom = e.slot - Math.max(params.window, params.fadeWindow) - 50;
        while (t.trades.length > 0 && t.trades[0].slot < keepFrom) {
          t.trades.shift();
          t.prices.shift();
        }
      }
    }
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.side === 'buy') {
        bought.set(f.mint, (bought.get(f.mint) ?? 0n) + BigInt(f.quote_lamports));
      } else {
        const b = bought.get(f.mint) ?? 0n;
        if (b >= 10_000_000n) tripped.add(f.mint);
      }
    }
  }

  function windowStats(mint: Pubkey, slot: number, window: number) {
    const t = tapes.get(mint);
    if (t === undefined) return null;
    const from = slot - window;
    let net = 0n;
    let trades = 0;
    let biggestSell = 0n;
    const buyers = new Set<Pubkey>();
    let high = 0;
    let firstPrice = 0;
    let lastPrice = 0;
    let buySol = 0n;
    let totalSol = 0n;
    let netOlder = 0n;
    let netNewer = 0n;
    let firstRq = 0n;
    let lastRq = 0n;
    const mid = from + window / 2;
    for (let i = 0; i < t.trades.length; i += 1) {
      const tr = t.trades[i];
      if (tr.slot < from) continue;
      trades += 1;
      totalSol += tr.sol;
      if (firstRq === 0n) firstRq = tr.rq;
      lastRq = tr.rq;
      if (tr.buy) {
        net += tr.sol;
        buySol += tr.sol;
        buyers.add(tr.user);
        if (tr.slot >= mid) netNewer += tr.sol; else netOlder += tr.sol;
      } else {
        net -= tr.sol;
        if (tr.sol > biggestSell) biggestSell = tr.sol;
        if (tr.slot >= mid) netNewer -= tr.sol; else netOlder -= tr.sol;
      }
      const p = t.prices[i].price;
      if (firstPrice === 0) firstPrice = p;
      lastPrice = p;
      if (p > high) high = p;
    }
    if (trades === 0) return null;
    return { net, trades, buyers: buyers.size, biggestSell, high, firstPrice, lastPrice, buySol, totalSol, netOlder, netNewer, firstRq, lastRq };
  }

  function hasPending(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint) return true;
    return false;
  }

  function positionValue(state: BotState, mint: Pubkey): bigint | null {
    const pos = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (pos === undefined || curve === undefined || curve.virtual_token_reserves === 0n) return null;
    return (pos.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    ingest(batch);
    const orders: OrderInput[] = [];
    const slot = batch.slot;
    const maxOrders = state.hello.caps.max_orders_per_batch;

    // ---- exits first ------------------------------------------------------
    for (const [mint, pos] of state.positions) {
      if (orders.length >= maxOrders) break;
      if (hasPending(state, mint)) continue;
      const meta = metas.get(mint);
      const value = positionValue(state, mint);
      if (value === null || pos.cost_lamports === 0n) continue;
      const pct = (Number(value) / Number(pos.cost_lamports) - 1) * 100;
      if (meta !== undefined && pct > meta.bestValuePct) meta.bestValuePct = pct;
      const curve = state.curves.get(mint);
      const t = tapes.get(mint);
      let exit = false;
      if (meta?.probe) {
        exit = true; // probes are round trips, not investments: sell on sight
      } else if (pct >= params.takeProfitPct) exit = true;
      else if (pct <= -params.stopLossPct) exit = true;
      else if (meta !== undefined && meta.bestValuePct >= params.trailArmPct && pct <= meta.bestValuePct - params.trailPct) exit = true;
      else if (meta !== undefined && slot - meta.entrySlot >= params.maxHold) exit = true;
      else if (meta !== undefined && slot - meta.entrySlot >= params.stallSlots && Math.abs(pct) < params.stallBandPct) exit = true;
      else if (t?.devSold) exit = true;
      else if (curve?.complete) exit = true;
      else {
        const fade = windowStats(mint, slot, params.fadeWindow);
        if (fade !== null && fade.net <= -params.fadeFlow) exit = true;
      }
      if (exit) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        cooldownUntil.set(mint, slot + params.cooldown);
        metas.delete(mint);
      }
    }

    // ---- entries ----------------------------------------------------------
    const openCount = state.committedPositionCount();
    let exposure = 0n;
    for (const pos of state.positions.values()) exposure += pos.cost_lamports;

    if (openCount < params.maxPositions && exposure < params.maxExposure) {
      for (const [mint, curve] of state.curves) {
        if (orders.length >= maxOrders) break;
        if (state.committedPositionCount() >= params.maxPositions) break;
        if (state.positions.has(mint) || hasPending(state, mint)) continue;
        if (curve.complete || curve.created_slot === null) continue;
        if (slot - curve.created_slot < params.minAge) continue;
        if ((cooldownUntil.get(mint) ?? -1) > slot) continue;
        if ((entries.get(mint) ?? 0) >= params.maxEntries) continue;
        const rq = curve.real_quote_reserves;
        if (rq < params.minRealSol || rq > params.maxRealSol) continue;
        const t = tapes.get(mint);
        if (t === undefined || t.devSold) continue;
        const s = windowStats(mint, slot, params.window);
        if (s === null) continue;
        if (s.net < params.minNetFlow) continue;
        if (s.trades < params.minTrades || s.buyers < params.minBuyers) continue;
        if (s.biggestSell * 100n > rq * BigInt(params.maxSellSharePct)) continue;
        if (s.high === 0 || s.lastPrice < (s.high * params.nearHighPct) / 100) continue;
        if (s.firstPrice > 0 && s.lastPrice > s.firstPrice * (1 + params.maxRisePct / 100)) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < params.minCap) continue;
        const size = params.stake < cap ? params.stake : cap;
        if (size > state.freeCashLamports() - state.txFeeLamports()) continue;
        if (exposure + size > params.maxExposure) continue;
        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: params.buySlipBps });
        entries.set(mint, (entries.get(mint) ?? 0) + 1);
        metas.set(mint, { entrySlot: slot, bestValuePct: 0, probe: false });
        exposure += size;
      }
    }

    // ---- guardrail probes ---------------------------------------------------
    if (
      tripped.size < 20 &&
      firstSlot >= 0 &&
      slot - firstSlot > params.probeStartSlot &&
      slot - firstSlot > params.probePaceSlots * (tripped.size + 1) &&
      slot - lastProbeSlot >= params.probeGapSlots &&
      state.committedPositionCount() < state.hello.caps.max_open_positions &&
      orders.length < maxOrders
    ) {
      // Most liquid active curve we do not hold and have not tripped on yet.
      let best: Pubkey | null = null;
      let bestRq = 0n;
      for (const [mint, curve] of state.curves) {
        if (curve.complete || state.positions.has(mint) || hasPending(state, mint)) continue;
        if (tripped.has(mint)) continue;
        const t = tapes.get(mint);
        if (t === undefined || slot - t.lastTradeSlot > 300) continue;
        if (curve.real_quote_reserves > bestRq && state.maxBuyLamports(mint) >= params.probeStake) {
          best = mint;
          bestRq = curve.real_quote_reserves;
        }
      }
      if (best !== null && params.probeStake <= state.freeCashLamports() - state.txFeeLamports()) {
        orders.push({ side: 'buy', mint: best, quote_lamports: params.probeStake, max_slippage_bps: params.buySlipBps });
        metas.set(best, { entrySlot: slot, bestValuePct: 0, probe: true });
        lastProbeSlot = slot;
      }
    }

    return orders;
  }

  return { onBatch };
}
