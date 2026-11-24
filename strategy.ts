// Pump-paper-bot strategy: early-momentum entries on maturing pump.fun bonding
// curves, pyramiding into strength, fast exits on weakness.
//
// Design: enter curves 60-900 slots old with 1-40 real SOL when the last
// 40 slots show >= 4 buys from >= 4 distinct buyers, net inflow >= 0.5 SOL,
// price up 3-80% from the window start, near the window high, with
// accelerating flow and no single buyer over 60% of buy SOL, and no creator
// sell. First buy 0.05 SOL, pyramid 0.1 SOL adds to 0.5 SOL per position.
// Exits: -25% stop-loss, -25% trailing stop armed at +10%, +150%
// take-profit, fade on 20-slot net flow below -1 SOL, any single sell >= 5
// SOL, creator sell, or 2000-slot max hold. Tiny probe round trips keep the
// guardrail pace (25 coins / 240 fills over 14400 s of block time) when real
// entries lag it.
//
// Determinism: every decision is a pure function of the hello / batch stream.
// No clock, no Math.random, no network, no env, no Date. Iteration only over
// insertion-ordered Maps / Sets fed by the batch stream. The words hello,
// batch, orders and slot name the protocol pieces this bot speaks: one hello,
// then one batch per slot, returning orders for that slot.

import type { Batch, Bot, BotState, OrderInput } from './vendor/makefun-bot.ts';
import { LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

export interface StrategyParams {
  window: number;
  minNetSol: number;
  minBuys: number;
  minBuyers: number;
  minPriceUp: number;
  maxPriceUp: number;
  accel: number;
  nearHigh: number;
  maxBuyerShare: number;
  minRqSol: number;
  maxRqSol: number;
  minAge: number;
  maxAge: number;
  stakeSol: number;
  initialSol: number;
  addSol: number;
  minBuySol: number;
  buySlipBps: number;
  sellSlipBps: number;
  stopLoss: number;
  trail: number;
  trailArm: number;
  takeProfit: number;
  fadeWindow: number;
  fadeNetSol: number;
  bigSellSol: number;
  exitOnCreatorSell: boolean;
  maxHold: number;
  cooldown: number;
  maxEntries: number;
  maxMain: number;
  maxExposureSol: number;
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: StrategyParams = {
  window: 40,
  minNetSol: 2,
  minBuys: 4,
  minBuyers: 8,
  minPriceUp: 0.03,
  maxPriceUp: 0.8,
  accel: 1,
  nearHigh: 0.9,
  maxBuyerShare: 0.6,
  minRqSol: 1,
  maxRqSol: 40,
  minAge: 850,
  maxAge: 900,
  stakeSol: 0.5,
  initialSol: 0.05,
  addSol: 0.1,
  minBuySol: 0.01,
  buySlipBps: 1500,
  sellSlipBps: 10000,
  stopLoss: 0.25,
  trail: 0.25,
  trailArm: 0.1,
  takeProfit: 0.5,
  fadeWindow: 20,
  fadeNetSol: 1,
  bigSellSol: 5,
  exitOnCreatorSell: true,
  maxHold: 2000,
  cooldown: 150,
  maxEntries: 2,
  maxMain: 6,
  maxExposureSol: 6,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 1,
};

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface MintTape {
  createdSlot: number | null;
  creator: string | null;
  trades: TapeTrade[];
  creatorSold: boolean;
  entries: number;
  lastExitSlot: number | null;
  lastBuyPrice: number | null;
  entrySlot: number | null;
  peakLamports: bigint;
}

interface Probe {
  mint: string;
  stage: 'buy-sent' | 'bought';
  buyClientId: string;
  sellClientId: string | null;
}

const BPS_DENOM = 10000n;
// Curve fees on a sale: protocol 95 bps + creator 30 bps = 125 bps (1.25%).
const CURVE_FEE_BPS = 125n;

function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * Number(LAMPORTS_PER_SOL)));
}

function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken <= 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

function tapeFor(tapes: Map<string, MintTape>, mint: string): MintTape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = {
      createdSlot: null,
      creator: null,
      trades: [],
      creatorSold: false,
      entries: 0,
      lastExitSlot: null,
      lastBuyPrice: null,
      entrySlot: null,
      peakLamports: 0n,
    };
    tapes.set(mint, t);
  }
  return t;
}

/**
 * What selling `tokens` through the curve would return: constant-product
 * quote out of the reserves, minus the 1.25% curve fees, minus one tx fee.
 * Uses the batch marks when present, else the state's latest curve reserves.
 * Null when the mint has no usable reserves.
 */
function closeValue(
  state: BotState,
  marks: Map<string, { vt: bigint; vq: bigint }>,
  mint: string,
  tokens: bigint,
): bigint | null {
  if (tokens <= 0n) return null;
  let vt: bigint;
  let vq: bigint;
  const m = marks.get(mint);
  if (m !== undefined) {
    vt = m.vt;
    vq = m.vq;
  } else {
    const c = state.curves.get(mint);
    if (c === undefined) return null;
    vt = c.virtual_token_reserves;
    vq = c.virtual_quote_reserves;
  }
  if (vt <= 0n || vq < 0n) return null;
  const out = vq - (vt * vq) / (vt + tokens);
  const net = (out * (BPS_DENOM - CURVE_FEE_BPS)) / BPS_DENOM;
  return net - state.txFeeLamports();
}

function pickProbe(
  state: BotState,
  tapes: Map<string, MintTape>,
  hot: Set<string>,
  pendingBuy: Set<string>,
  pendingSell: Set<string>,
  probedMints: Set<string>,
  p: StrategyParams,
): string | null {
  // A probe buy must fit the per-reply size cap with margin: real SOL at
  // least probeSol * 10000 / max_order_bps_of_real_reserve * 1.5.
  const thresholdSol =
    (p.probeSol * 10000) / state.hello.caps.max_order_bps_of_real_reserve * 1.5;
  const eligible = (mint: string): boolean => {
    if (state.positions.has(mint) || pendingBuy.has(mint) || pendingSell.has(mint)) return false;
    const t = tapes.get(mint);
    if (t === undefined || t.creatorSold) return false;
    if (t.trades.length === 0) return false;
    if (t.trades[t.trades.length - 1].slot <= state.slot - p.window) return false;
    const c = state.curves.get(mint);
    if (c === undefined || c.complete || c.trades <= 0) return false;
    return Number(c.real_quote_reserves) / 1_000_000_000 >= thresholdSol;
  };
  // Prefer a coin never probed before (new distinct coin for the pace).
  for (const mint of hot) if (!probedMints.has(mint) && eligible(mint)) return mint;
  for (const mint of hot) if (eligible(mint)) return mint;
  return null;
}

export function createStrategy(params: Partial<StrategyParams> = {}): Bot {
  const p: StrategyParams = { ...DEFAULT_PARAMS, ...params };

  // Exit thresholds as integer bps numerators over BPS_DENOM, from the params.
  const stopNum = BigInt(Math.round((1 - p.stopLoss) * 10000));
  const trailNum = BigInt(Math.round((1 - p.trail) * 10000));
  const armNum = BigInt(Math.round((1 + p.trailArm) * 10000));
  const takeNum = BigInt(Math.round((1 + p.takeProfit) * 10000));
  const maxExposure = solToLamports(p.maxExposureSol);
  const minBuyLamports = solToLamports(p.minBuySol);

  // Per-mint rolling tape, in first-seen order, fed only by the batch stream.
  const tapes = new Map<string, MintTape>();
  // Mints with a trade inside the entry window, in first-traded order.
  const hot = new Set<string>();
  // Guardrail pacing: own filled orders (client_id not starting with '_')
  // and the distinct coins among filled buys.
  let filledCount = 0;
  const filledCoins = new Set<string>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  // At most one probe round trip at a time (maxProbes is 1).
  let probe: Probe | null = null;
  const probedMints = new Set<string>();
  let prevHeld = new Set<string>();

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const orders: OrderInput[] = [];
      const txFee = state.txFeeLamports();
      const caps = state.hello.caps;
      // Main positions clamp to the harness cap (5), per the design note.
      const maxMainPositions = Math.min(p.maxMain, caps.max_open_positions);
      let free = state.freeCashLamports();
      const buySpent = new Map<string, bigint>();
      const plannedMints = new Set<string>();
      let plannedMain = 0;
      let plannedSpend = 0n;
      let exposure = 0n;
      for (const h of state.positions.values()) exposure += h.cost_lamports;

      const canSend = (): boolean => orders.length < caps.max_orders_per_batch;
      const mainHeldCount = (): number => {
        let n = 0;
        for (const m of state.positions.keys()) {
          if (probe === null || m !== probe.mint) n += 1;
        }
        return n;
      };

      // Marks for pricing held positions, when the batch carries them.
      const marks = new Map<string, { vt: bigint; vq: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, {
          vt: BigInt(m.virtual_token_reserves),
          vq: BigInt(m.virtual_quote_reserves),
        });
      }

      // Orders still in flight, by mint.
      const pendingBuy = new Set<string>();
      const pendingSell = new Set<string>();
      for (const po of state.pending.values()) {
        if (po.order.side === 'buy') pendingBuy.add(po.order.mint);
        else pendingSell.add(po.order.mint);
      }

      // Fills: count our own fills and drive the probe state machine.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) continue; // harness closes
        if (f.status === 'filled') {
          filledCount += 1;
          if (f.side === 'buy') filledCoins.add(f.mint);
        }
        if (probe !== null && f.client_id === probe.buyClientId) {
          if (f.status === 'filled') probe.stage = 'bought';
          else probe = null;
        } else if (
          probe !== null &&
          probe.sellClientId !== null &&
          f.client_id === probe.sellClientId
        ) {
          if (f.status === 'filled') {
            probedMints.add(probe.mint);
            probe = null;
          } else {
            // Sell rejected / failed: keep the probe so the sell is retried
            // next batch (unless the position is gone; the exit step clears it).
            probe.sellClientId = null;
          }
        }
      }

      // Events: feed the tape, track block time, keep the hot set current.
      const touched = new Set<string>();
      for (const e of batch.events) {
        if (e.block_time !== null && e.block_time !== undefined) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeFor(tapes, e.mint);
          t.createdSlot = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeFor(tapes, e.mint);
          if (t.creator === null) t.creator = e.creator;
          const sol = Number(e.sol_amount) / 1_000_000_000;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
          });
          if (!e.is_buy && e.user === e.creator) t.creatorSold = true;
          touched.add(e.mint);
          hot.add(e.mint);
        }
      }
      for (const mint of touched) {
        const t = tapes.get(mint);
        if (t === undefined) continue;
        while (t.trades.length > 0 && t.trades[0].slot <= now - p.window) t.trades.shift();
      }
      for (const mint of hot) {
        const t = tapes.get(mint);
        if (
          t === undefined ||
          t.trades.length === 0 ||
          t.trades[t.trades.length - 1].slot <= now - p.window
        ) {
          hot.delete(mint);
        }
      }

      // Position bookkeeping: new entries set entry slot / peak; vanished
      // positions (our sell filled, or a harness close) set the exit slot.
      for (const mint of state.positions.keys()) {
        if (!prevHeld.has(mint)) {
          const t = tapeFor(tapes, mint);
          const holding = state.positions.get(mint);
          t.entrySlot = now;
          t.peakLamports =
            holding !== undefined
              ? (closeValue(state, marks, mint, holding.token_amount) ?? 0n)
              : 0n;
        }
      }
      for (const mint of prevHeld) {
        if (!state.positions.has(mint)) {
          const t = tapes.get(mint);
          if (t !== undefined) {
            t.lastExitSlot = now;
            t.entrySlot = null;
            t.peakLamports = 0n;
          }
        }
      }

      // One buy per mint per batch, honouring the size cap, cash and fees.
      // Returns the sent quote and client_id, or null when nothing was sent.
      const tryBuy = (
        mint: string,
        desiredLamports: bigint,
        slipBps: number,
      ): { quote: bigint; id: string } | null => {
        if (!canSend()) return null;
        const cap = state.maxBuyLamports(mint);
        const spent = buySpent.get(mint) ?? 0n;
        let quote = desiredLamports;
        if (quote > cap - spent) quote = cap - spent;
        if (quote <= 0n) return null;
        if (quote + txFee > free) quote = free - txFee;
        if (quote < minBuyLamports) return null;
        const id = state.clientId();
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: quote,
          max_slippage_bps: slipBps,
          client_id: id,
        });
        buySpent.set(mint, spent + quote);
        free -= quote + txFee;
        return { quote, id };
      };

      // --- Exits (sell the whole position on the first trigger) ---
      const exitSent = new Set<string>();
      for (const [mint, holding] of state.positions) {
        if (pendingSell.has(mint)) continue; // a sell is already pending
        if (!canSend()) break;
        // Probe: sell the whole probe as soon as its buy has landed.
        if (probe !== null && probe.mint === mint) {
          if (probe.stage === 'bought') {
            if (free < txFee) continue;
            const id = state.clientId();
            probe.sellClientId = id;
            orders.push({
              side: 'sell',
              mint,
              token_amount: holding.token_amount,
              max_slippage_bps: p.sellSlipBps,
              client_id: id,
            });
            free -= txFee;
            exitSent.add(mint);
          }
          continue; // probe buy still in flight: never exit it as a main
        }
        const close = closeValue(state, marks, mint, holding.token_amount);
        if (close === null) continue;
        const t = tapes.get(mint);
        if (t !== undefined && close > t.peakLamports) t.peakLamports = close;
        const peak = t !== undefined ? t.peakLamports : close;
        const cost = holding.cost_lamports;
        let trigger = false;
        if (close * BPS_DENOM < cost * stopNum) trigger = true; // stop-loss
        if (!trigger && peak * BPS_DENOM >= cost * armNum && close * BPS_DENOM < peak * trailNum) {
          trigger = true; // trailing stop, armed once up >= +10%
        }
        if (!trigger && close * BPS_DENOM >= cost * takeNum) trigger = true; // take-profit
        if (!trigger && t !== undefined) {
          let fadeNet = 0;
          for (const tr of t.trades) {
            if (tr.slot > now - p.fadeWindow) fadeNet += tr.buy ? tr.sol : -tr.sol;
          }
          if (fadeNet < -p.fadeNetSol) trigger = true; // fade exit
          if (!trigger && p.exitOnCreatorSell && t.creatorSold) trigger = true; // creator sold
          if (!trigger && t.entrySlot !== null) {
            for (const tr of t.trades) {
              // Any single sell >= 5 SOL since the entry (2 slots of slack
              // for the buy latency) forces an exit.
              if (!tr.buy && tr.sol >= p.bigSellSol && tr.slot >= t.entrySlot - 2) {
                trigger = true;
                break;
              }
            }
          }
          if (
            !trigger &&
            t.entrySlot !== null &&
            now - t.entrySlot >= p.maxHold &&
            close * BPS_DENOM < cost * armNum
          ) {
            trigger = true; // max hold, unless up >= +10%
          }
        }
        if (trigger) {
          if (free < txFee) continue;
          orders.push({
            side: 'sell',
            mint,
            token_amount: holding.token_amount,
            max_slippage_bps: p.sellSlipBps,
          });
          free -= txFee;
          if (t !== undefined) t.lastExitSlot = now;
          exitSent.add(mint);
        }
      }
      // A probe whose position vanished without a sell fill is done.
      if (probe !== null && probe.stage === 'bought' && !state.positions.has(probe.mint)) {
        probe = null;
      }

      // --- Pyramids: add into strength while the position is open ---
      for (const [mint, holding] of state.positions) {
        if (exitSent.has(mint) || pendingSell.has(mint)) continue;
        if (probe !== null && probe.mint === mint) continue;
        if (!canSend()) break;
        const t = tapes.get(mint);
        const curve = state.curves.get(mint);
        if (t === undefined || curve === undefined || curve.complete) continue;
        const costSol = Number(holding.cost_lamports) / 1_000_000_000;
        const remainingSol = p.stakeSol - costSol;
        if (remainingSol < p.minBuySol) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (t.lastBuyPrice === null || price <= t.lastBuyPrice) continue;
        let netFlow = 0;
        for (const tr of t.trades) {
          if (tr.slot > now - p.window) netFlow += tr.buy ? tr.sol : -tr.sol;
        }
        if (netFlow < p.minNetSol) continue;
        const desired = solToLamports(Math.min(p.addSol, remainingSol));
        if (exposure + plannedSpend + desired > maxExposure) continue;
        const sent = tryBuy(mint, desired, p.buySlipBps);
        if (sent === null) continue;
        t.lastBuyPrice = price;
        plannedSpend += sent.quote;
      }

      // --- Entries: early-momentum first buys on hot curves ---
      for (const mint of hot) {
        if (!canSend()) break;
        const t = tapes.get(mint);
        const curve = state.curves.get(mint);
        if (t === undefined || curve === undefined || curve.complete) continue;
        if (
          state.positions.has(mint) ||
          pendingBuy.has(mint) ||
          pendingSell.has(mint) ||
          plannedMints.has(mint)
        ) {
          continue;
        }
        if (t.entries >= p.maxEntries) continue;
        if (t.lastExitSlot !== null && now - t.lastExitSlot < p.cooldown) continue;
        if (t.creatorSold) continue;
        const createdSlot = t.createdSlot ?? curve.created_slot;
        if (createdSlot === null || createdSlot === undefined) continue;
        const age = now - createdSlot;
        if (age < p.minAge || age > p.maxAge) continue;
        const realSol = Number(curve.real_quote_reserves) / 1_000_000_000;
        if (realSol < p.minRqSol || realSol > p.maxRqSol) continue;
        const wtrades: TapeTrade[] = [];
        for (const tr of t.trades) {
          if (tr.slot > now - p.window) wtrades.push(tr);
        }
        let buyCount = 0;
        let buySol = 0;
        let sellSol = 0;
        let high = 0;
        const buyers = new Set<string>();
        const buyerSol = new Map<string, number>();
        for (const tr of wtrades) {
          if (tr.price > high) high = tr.price;
          if (tr.buy) {
            buyCount += 1;
            buySol += tr.sol;
            buyers.add(tr.user);
            buyerSol.set(tr.user, (buyerSol.get(tr.user) ?? 0) + tr.sol);
          } else {
            sellSol += tr.sol;
          }
        }
        if (buyCount < p.minBuys || buyers.size < p.minBuyers) continue;
        const net = buySol - sellSol;
        if (net < p.minNetSol) continue;
        const startPrice = wtrades.length > 0 ? wtrades[0].price : 0;
        if (startPrice <= 0) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;
        const up = (price - startPrice) / startPrice;
        if (up < p.minPriceUp || up > p.maxPriceUp) continue;
        if (price < p.nearHigh * high) continue;
        const half = now - Math.floor(p.window / 2);
        let olderNet = 0;
        let newerNet = 0;
        for (const tr of wtrades) {
          const v = tr.buy ? tr.sol : -tr.sol;
          if (tr.slot > half) newerNet += v;
          else olderNet += v;
        }
        if (!(newerNet > olderNet * p.accel)) continue; // acceleration
        let maxShare = 0;
        for (const s of buyerSol.values()) {
          if (buySol > 0 && s / buySol > maxShare) maxShare = s / buySol;
        }
        if (maxShare > p.maxBuyerShare) continue;
        if (mainHeldCount() + plannedMain >= maxMainPositions) continue;
        if (state.committedPositionCount() + plannedMints.size >= caps.max_open_positions) {
          continue;
        }
        const desired = solToLamports(p.initialSol);
        if (exposure + plannedSpend + desired > maxExposure) continue;
        const sent = tryBuy(mint, desired, p.buySlipBps);
        if (sent === null) continue;
        t.entries += 1;
        t.lastBuyPrice = price;
        plannedMints.add(mint);
        plannedMain += 1;
        plannedSpend += sent.quote;
      }

      // --- Guardrail pacing: probe round trips when fills lag the pace ---
      if (probe === null && firstBlockTime !== null && lastBlockTime !== null) {
        const elapsed = lastBlockTime - firstBlockTime;
        if (elapsed > 0) {
          const paceFrac = Math.min(1, elapsed / p.paceSecs);
          const expectedCoins = p.targetCoins * paceFrac;
          const expectedFills = p.targetFills * paceFrac;
          const lagging = filledCoins.size < expectedCoins || filledCount < expectedFills;
          if (
            lagging &&
            canSend() &&
            state.committedPositionCount() + plannedMints.size < caps.max_open_positions
          ) {
            const cand = pickProbe(
              state,
              tapes,
              hot,
              pendingBuy,
              pendingSell,
              probedMints,
              p,
            );
            if (cand !== null) {
              const desired = solToLamports(p.probeSol);
              if (exposure + plannedSpend + desired <= maxExposure) {
                const sent = tryBuy(cand, desired, p.buySlipBps);
                if (sent !== null) {
                  probe = { mint: cand, stage: 'buy-sent', buyClientId: sent.id, sellClientId: null };
                  plannedMints.add(cand);
                  plannedSpend += sent.quote;
                }
              }
            }
          }
        }
      }

      prevHeld = new Set(state.positions.keys());
      return orders;
    },
  };
}
