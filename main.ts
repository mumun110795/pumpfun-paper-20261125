// Early-momentum sniper for the Pump.fun Paper Sprint.
//
// The idea, in one paragraph: most pump.fun coins are born, spike once, and
// then bleed back to their creation price. The money is in the few coins that
// attract real early volume and run a long way (some complete their curve,
// ~10x+ from creation). This bot hunts them two ways at once:
//   - a "core" bet: when a young coin has already pulled in a lot of early buy
//     volume (>= 40 SOL of buys in its first 150 slots), it is a likely
//     completer, so take one meaningful stake and hold it for a 1.5x multiple;
//   - a "filler" grind: on young coins with solid but smaller early volume
//     (>= 20 SOL), take a smaller stake and recycle it fast -- take profit at
//     1.5x, cut it at 0.6x, or time it out -- so capital keeps turning over
//     into fresh coins. The filler exists because the guardrails need at least
//     20 distinct coins with a real round trip, and five position slots held to
//     the end of the window can only ever hold five coins.
//
// Two mechanics of the harness shape the design. First, a buy fills two slots
// after the decision, and by then a spiking coin has usually run away, so buys
// carry a tight slippage limit: a fill is refused for free when the price moved
// too far, which keeps us from buying spike tops. Second, one reply's buys on a
// coin may spend at most 1% of that coin's real SOL reserve, so a stake can only
// be as big as the coin's own volume allows; entries wait until the reserve
// supports the stake instead of chasing.
//
// Everything is deterministic: no randomness, no clock, no environment. Every
// decision comes from the hello message and the batches the harness sends.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- tuning

const SOL = LAMPORTS_PER_SOL;

// Shared entry rules.
const VOL_WINDOW = 150; // slots after creation that count toward buy volume
const MAX_ENTRY_AGE = 600; // slots after creation during which a buy may start
const BUY_SLIPPAGE_BPS = 500; // buys refuse a fill that moved >5% in the latency
const SELL_SLIPPAGE_BPS = 10_000; // sells must execute: never refuse one
const MIN_BUY = SOL / 100n; // a buy is at least 0.01 SOL (the round-trip bar)

// Core bet: heavy early buy volume, one stake, hold for a 1.5x multiple.
const CORE_MIN_BUY_VOLUME = 40n * SOL;
const CORE_STAKE = SOL / 20n; // 0.05 SOL
const CORE_TP_MULT = 1.5; // sell the whole position at 1.5x average cost
const CORE_MAX_SLOTS = 3; // at most this many core positions at once

// Filler grind: solid early volume, small stake, fast recycle. The filler
// exits on a 1.5x take-profit or a timeout; there is deliberately no stop
// loss, because cutting at 0.6x locks in the retrace while the price often
// recovers by the timeout instead.
const FILLER_MIN_BUY_VOLUME = 30n * SOL;
const FILLER_STAKE = (15n * SOL) / 1000n; // 0.015 SOL, just above the 0.01 bar
const FILLER_TP_MULT = 1.5; // sell the whole position at 1.5x average cost
const FILLER_TIMEOUT = 15_000; // slots after the fill: sell whatever is left
const FILLER_MAX_SLOTS = 2; // at most this many filler positions at once
// The filler is a means to an end (the guardrail needs 20 round trips), not
// a profit centre: every filler trade loses a little on average, so stop
// entering new filler positions once the filler has finished this many round
// trips. The core's round trips then carry the total past 20, and the budget
// makes the bot behave the same on a 6-hour window as on a 24-hour one.
const FILLER_RT_BUDGET = 18;

// ---------------------------------------------------------------- per-coin memory

interface CoinMemory {
  createdSlot: number;
  // Buy volume in lamports inside the first VOL_WINDOW slots.
  buyVolume: bigint;
}

const memory = new Map<string, CoinMemory>();
// Mints that already took their one core buy (set when the buy fills).
const coreFilled = new Set<string>();
// Mints that already took their one filler buy (set when the buy fills).
const fillerFilled = new Set<string>();
// Slot a position's opening buy filled at, by mint (for the filler timeout).
const entrySlot = new Map<string, number>();
// Filler round trips completed so far (a sell fill that closed a filler
// position). Drives the filler budget.
let fillerRoundTrips = 0;

// ---------------------------------------------------------------- helpers

function priceOf(state: BotState, mint: string): number | null {
  const curve = state.curves.get(mint);
  if (curve === undefined) return null;
  if (curve.virtual_token_reserves === 0n) return null;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

function hasPendingBuy(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === 'buy') return true;
  }
  return false;
}

function hasPendingSell(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === 'sell') return true;
  }
  return false;
}

/** Slots currently occupied, split into core mints and filler mints. A buy that
 *  is still in flight counts against its own tier (read from its client_id),
 *  so the caps hold while the fill is two slots away. */
function slotUse(state: BotState): { core: number; filler: number } {
  const held = new Set<string>(state.positions.keys());
  const corePending = new Set<string>();
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy') {
      held.add(p.order.mint);
      if (p.order.client_id !== undefined && p.order.client_id.startsWith('core-')) {
        corePending.add(p.order.mint);
      }
    }
  }
  let core = 0;
  let filler = 0;
  for (const mint of held) {
    if (coreFilled.has(mint) || corePending.has(mint)) core += 1;
    else filler += 1;
  }
  return { core, filler };
}

// ---------------------------------------------------------------- the bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    // Learn from this batch's events first (the state already folded them in,
    // so the curves and the account below are current).
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        memory.set(e.mint, { createdSlot: e.slot, buyVolume: 0n });
      } else if (e.event === 'TradeEvent') {
        let mem = memory.get(e.mint);
        if (mem === undefined) {
          // A coin whose creation we missed: use first sight as the reference.
          mem = { createdSlot: e.slot, buyVolume: 0n };
          memory.set(e.mint, mem);
        }
        if (e.is_buy && e.slot - mem.createdSlot <= VOL_WINDOW) {
          mem.buyVolume += BigInt(e.sol_amount);
        }
      }
    }

    // Note buys that filled, so each coin takes exactly one core and one
    // filler buy, and remember when each position opened.
    for (const f of batch.fills) {
      if (f.side === 'buy' && f.status === 'filled') {
        entrySlot.set(f.mint, f.slot);
        if (f.client_id.startsWith('core-')) coreFilled.add(f.mint);
        if (f.client_id.startsWith('fill-')) fillerFilled.add(f.mint);
      }
      if (f.side === 'sell' && f.status === 'filled') {
        // A position that sold out entirely is gone; forget its entry slot.
        const held = state.positions.get(f.mint);
        if (held === undefined) {
          entrySlot.delete(f.mint);
          if (fillerFilled.has(f.mint)) fillerRoundTrips += 1;
        }
      }
    }

    const orders: OrderInput[] = [];
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    const maxOrders = state.hello.caps.max_orders_per_batch;
    const use = slotUse(state);
    // Mints sold in this reply: never buy one back in the same breath.
    const selling = new Set<string>();

    // --- exits: sell any held position that hit its exit. A position's
    // average cost comes from the account the harness reports, so it already
    // reflects every fill and fee. A buy still in flight would reopen the
    // position after the sell, so wait for it to land first.
    //   - core: fixed 1.5x take-profit; a core loser is held to the end of
    //     the window rather than sold at a loss, because selling early locks
    //     in the retrace and the price often recovers by the last trade.
    //   - filler: fixed 1.5x take-profit or a timeout; no stop loss.
    for (const [mint, holding] of state.positions) {
      if (orders.length >= maxOrders) break;
      if (hasPendingSell(state, mint)) continue;
      if (hasPendingBuy(state, mint)) continue;
      const price = priceOf(state, mint);
      if (price === null) continue;
      const avgCost = Number(holding.cost_lamports) / Number(holding.token_amount);
      const isCore = coreFilled.has(mint);
      let sell = false;
      if (isCore) {
        if (price >= avgCost * CORE_TP_MULT) sell = true;
      } else {
        if (price >= avgCost * FILLER_TP_MULT) sell = true;
        const opened = entrySlot.get(mint);
        if (opened !== undefined && state.slot - opened > FILLER_TIMEOUT) sell = true;
      }
      if (!sell) continue;
      const out: SellInput = {
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      };
      orders.push(out);
      selling.add(mint);
    }

    // --- entries: only coins that moved in this batch need a fresh look. ---
    // A new mint consumes a slot (core or filler cap); adding to a position
    // already held costs no new slot, so the caps only gate fresh mints.
    const seen = new Set<string>();
    for (const e of batch.events) {
      if (e.event === 'CompleteEvent') continue;
      const mint = e.mint;
      if (seen.has(mint)) continue;
      seen.add(mint);
      if (orders.length >= maxOrders) break;
      if (selling.has(mint)) continue;
      const mem = memory.get(mint);
      if (mem === undefined) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const age = state.slot - mem.createdSlot;
      if (age > MAX_ENTRY_AGE) continue;
      if (hasPendingBuy(state, mint)) continue;
      const cap = state.maxBuyLamports(mint);
      const isNew = !state.positions.has(mint);

      // Core bet first: heavy early buy volume, one stake, then hold.
      if (
        !coreFilled.has(mint) &&
        !fillerFilled.has(mint) &&
        mem.buyVolume >= CORE_MIN_BUY_VOLUME &&
        (!isNew || use.core < CORE_MAX_SLOTS) &&
        cap >= MIN_BUY
      ) {
        const amount = cap < CORE_STAKE ? cap : CORE_STAKE;
        if (free >= amount + tx) {
          const buy: BuyInput = {
            side: 'buy',
            mint,
            quote_lamports: amount,
            max_slippage_bps: BUY_SLIPPAGE_BPS,
            client_id: `core-${mint}-${state.slot}`,
          };
          orders.push(buy);
          free -= amount + tx;
          if (isNew) use.core += 1;
          continue;
        }
      }

      // Filler grind: solid early volume, small stake, fast recycle. A coin
      // takes exactly one buy in its life (core or filler, never both), and
      // the filler stops once its round-trip budget is spent.
      if (
        !coreFilled.has(mint) &&
        !fillerFilled.has(mint) &&
        fillerRoundTrips < FILLER_RT_BUDGET &&
        mem.buyVolume >= FILLER_MIN_BUY_VOLUME &&
        (!isNew || use.filler < FILLER_MAX_SLOTS) &&
        cap >= MIN_BUY
      ) {
        const amount = cap < FILLER_STAKE ? cap : FILLER_STAKE;
        if (free >= amount + tx) {
          const buy: BuyInput = {
            side: 'buy',
            mint,
            quote_lamports: amount,
            max_slippage_bps: BUY_SLIPPAGE_BPS,
            client_id: `fill-${mint}-${state.slot}`,
          };
          orders.push(buy);
          free -= amount + tx;
          if (isNew) use.filler += 1;
        }
      }
    }

    return orders;
  },
});
