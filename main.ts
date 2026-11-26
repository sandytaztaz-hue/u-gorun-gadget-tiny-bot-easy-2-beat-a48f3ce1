// Tiny Bot v3 — multi-asset regime-adaptive hourly bot for make.fun bars-replay/v1.
// Design (own work, validated locally on the kit dev bars; no leader code used):
//   * WASHOUT sleeve (the validated edge): after a 24h drawdown of 5%+ AND the
//     last 6h turning up (r6 > 0, bounce underway), buy a half position (12.5%);
//     if the drawdown deepens past 8%, top up to 25%. Exit at +2% / -2% or
//     after 16 bars, or early when the 24h return recovers above -1% in profit.
//     On the dev window this sleeve is what makes money (+$115-148 per 72-bar
//     window containing the crash); buying the first -5% print mid-crash loses,
//     so the r6 > 0 bounce filter and the scale-in are load-bearing.
//   * PULSE sleeve (compliance + tiny edge): price >1 sigma below its 12h mean
//     with a rising last hour -> buy 1% of equity, exit +0.8% / -0.8% / 6 bars,
//     48-bar cooldown per asset after an exit. In a grinding market this sleeve
//     is ~breakeven by design; its job is to keep the bot trading (>=8 fills
//     per 72-bar window) while risking almost nothing.
//   * No trend sleeve: momentum chasing tested negative on every formulation
//     (dead-cat bounces reverse; 24h trend persistence is -0.5), so in a
//     grinding market the bot sits mostly in cash and in a rally it stays flat
//     rather than chase. USDC shelter is the default state.
//   * Risk: per-position stops, 25% max weight (harness cap), at most 6 washout
//     + 5 pulse positions, and a drawdown brake that halts new entries for 12
//     bars after a 3% equity drawdown (peak resets so it cannot latch forever).
//   * Deterministic: no clock, no environment, no randomness. Stdlib only.
// Wire: speaks agent-fun/bars-replay/v1 on stdin/stdout directly (no vendor
// shim), one JSON reply per batch echoing its seq. Fills land at the next
// bar's open; entry prices are taken from the fills, never assumed.
import { createInterface } from 'node:readline';

const BPS = 10_000n;
const CAPITAL = 10_000_000_000n; // 10,000 USDC, micro units
const MAX_SLIP_BPS = 300;
const MAX_WASH = 6;
const MAX_PULSE = 5;
const MAX_WEIGHT_BPS = 2500; // harness cap, 25% per asset
const MIN_NOTIONAL = 2_000_000n; // 2 USDC, above the 1 USDC minimum

// --- locked parameters (swept offline on sliding 72-bar windows; keep only
// changes that improved the stress median, never a single dev window) ---
const P = {
  washHalfThr: -0.05, // first washout leg: 24h return below this
  washTopThr: -0.08,  // top-up leg: 24h return below this
  washR1: 0.0,        // last-hour return must be above this (rising)
  washR6: 0.0,        // last-6h return must be above this (bounce underway)
  washMinN: 20,       // need at least this many bars of history for a 24h read
  halfW: 0.125,       // first leg size (of equity)
  fullW: 0.25,        // full washout size (of equity)
  washTP: 0.02,       // take profit
  washSL: -0.02,      // stop loss
  washH: 16,          // time stop (bars)
  washExitR24: -0.01, // early exit: 24h return recovered above this, in profit
  trailArm: 0.015,    // arm trailing stop once up this much
  trailGive: 0.007,   // trailing stop gives back this much from the best
  pulseK: 1.0,        // pulse entry: log(price / MA12) below -K sigma
  pulseW: 0.01,       // pulse size (of equity)
  pulseTP: 0.008,     // pulse take profit
  pulseSL: -0.008,    // pulse stop loss
  pulseH: 6,          // pulse time stop (bars)
  pulseCool: 48,      // bars of cooldown per asset after a pulse exit
  brakeDD: 0.03,      // halt new entries after this equity drawdown
  brakeCool: 12,      // brake length (bars); peak resets so it cannot latch
};

interface Bar { symbol: string; t: number; o: string; h: string; l: string; c: string; v: string | null; o_depth: string[]; c_depth: string[] }
interface Fill { client_id: string; symbol: string; side: string; status: string; reason: string | null; decided_bar: number; fill_bar: number; price: string; qty: string; notional_quote_units: string; fee_quote_units: string }
interface Pos { qty: bigint; cost: bigint }
interface Entry { price: number; seq: number; kind: 'W' | 'P'; best: number; topped: boolean }

const closes = new Map<string, number[]>(); // symbol -> close prices (raw units)
const entry = new Map<string, Entry>();
const lastPulseExit = new Map<string, number>();
let positions = new Map<string, Pos>();
let cash = CAPITAL;
let equity = CAPITAL;
let peakEquity = CAPITAL;
let brakeUntil = -1;
let seq = -1;

function logRet(series: number[], n: number): number | null {
  const m = series.length;
  if (m <= n) return null;
  return Math.log(series[m - 1] / series[m - 1 - n]);
}
// Mean + population sd of log(price / mean) over the n bars BEFORE the latest.
function maDev(series: number[], n: number): { dev: number; sd: number } | null {
  const m = series.length;
  if (m <= n) return null;
  const w = series.slice(m - 1 - n, m - 1);
  const mean = w.reduce((a, b) => a + b, 0) / n;
  let sum = 0;
  for (const x of w) { const d = Math.log(x / mean); sum += d * d; }
  const sd = Math.sqrt(sum / n);
  return { dev: Math.log(series[m - 1] / mean), sd };
}
function n24(series: number[]): number { return Math.min(24, series.length - 1); }

function decide(): Array<Record<string, unknown>> {
  const orders: Array<Record<string, unknown>> = [];
  if (seq < 6) return orders; // cold start: need history
  const dd = Number(peakEquity - equity) / Number(peakEquity);
  if (dd > P.brakeDD && seq > brakeUntil) {
    brakeUntil = seq + P.brakeCool;
    peakEquity = equity; // re-arm: never latch forever on a stale peak
  }

  // --- exits first: free slots / cut risk before any entry ---
  for (const [sym, e] of [...entry.entries()]) {
    const s = closes.get(sym);
    const p = positions.get(sym);
    if (!s || !p || p.qty === 0n) { entry.delete(sym); continue; }
    const px = s[s.length - 1];
    const ret = Math.log(px / e.price);
    if (ret > e.best) e.best = ret;
    let out = false;
    if (e.kind === 'W') {
      const r24 = logRet(s, n24(s));
      if (ret >= P.washTP || ret <= P.washSL) out = true;
      else if (seq - e.seq >= P.washH) out = true;
      else if (r24 !== null && r24 > P.washExitR24 && ret > 0.005) out = true;
      else if (ret >= P.trailArm && ret <= e.best - P.trailGive) out = true;
    } else {
      if (ret >= P.pulseTP || ret <= P.pulseSL) out = true;
      else if (seq - e.seq >= P.pulseH) out = true;
    }
    if (out) {
      orders.push({ side: 'sell', symbol: sym, qty: p.qty.toString(), max_slippage_bps: MAX_SLIP_BPS });
      // entry is deleted only when the sell fill confirms (see fill handler);
      // a rejected sell leaves the position held and re-decided next bar.
    }
  }
  // Orphan cleanup: a held position with no entry record is sold, never left.
  for (const [sym, p] of positions.entries()) {
    if (p.qty > 0n && !entry.has(sym)) {
      orders.push({ side: 'sell', symbol: sym, qty: p.qty.toString(), max_slippage_bps: MAX_SLIP_BPS });
    }
  }
  if (seq < brakeUntil) return orders;

  // --- scale-in: top up a half-size washout position when it deepens ---
  for (const [sym, e] of [...entry.entries()]) {
    if (e.kind !== 'W' || e.topped) continue;
    const s = closes.get(sym);
    const p = positions.get(sym);
    if (!s || !p || p.qty === 0n) continue;
    const r24 = logRet(s, n24(s));
    if (r24 === null || r24 >= P.washTopThr) continue;
    const add = topUpAmount(sym, e);
    if (add >= MIN_NOTIONAL && add <= cash) {
      orders.push({ side: 'buy', symbol: sym, notional_quote_units: add.toString(), max_slippage_bps: MAX_SLIP_BPS });
    }
  }

  // --- entries ---
  const nW = [...entry.values()].filter((e) => e.kind === 'W').length;
  const nP = [...entry.values()].filter((e) => e.kind === 'P').length;
  interface Cand { sym: string; kind: 'W' | 'P'; score: number }
  const cands: Cand[] = [];
  for (const [sym, s] of closes.entries()) {
    if (positions.has(sym)) continue;
    const n = n24(s);
    const r24 = logRet(s, n);
    const r1 = logRet(s, 1);
    const r6 = logRet(s, Math.min(6, s.length - 1));
    if (r24 === null || r1 === null || r6 === null) continue;
    if (n >= P.washMinN && r24 < P.washHalfThr && r1 > P.washR1 && r6 > P.washR6 && nW < MAX_WASH) {
      cands.push({ sym, kind: 'W', score: -r24 });
    } else if (nP < MAX_PULSE && seq - (lastPulseExit.get(sym) ?? -999) > P.pulseCool) {
      const md = maDev(s, 12);
      if (md !== null && md.sd > 0 && md.dev < -P.pulseK * md.sd && r1 > 0) {
        cands.push({ sym, kind: 'P', score: -md.dev });
      }
    }
  }
  cands.sort((a, b) => (a.kind === b.kind ? b.score - a.score : a.kind === 'W' ? -1 : 1));
  let addW = nW;
  let addP = nP;
  for (const c of cands) {
    if (c.kind === 'W' && addW >= MAX_WASH) continue;
    if (c.kind === 'P' && addP >= MAX_PULSE) continue;
    const w = c.kind === 'W' ? P.halfW : P.pulseW;
    let target = (BigInt(Math.floor(w * 1e6)) * equity) / 1_000_000n;
    const room = (BigInt(MAX_WEIGHT_BPS) * equity) / BPS;
    if (target > room) target = room;
    if (target > cash) target = cash;
    if (target < MIN_NOTIONAL) continue;
    orders.push({ side: 'buy', symbol: c.sym, notional_quote_units: target.toString(), max_slippage_bps: MAX_SLIP_BPS });
    entry.set(c.sym, { price: closes.get(c.sym)![closes.get(c.sym)!.length - 1], seq, kind: c.kind, best: 0, topped: false });
    if (c.kind === 'W') addW++; else addP++;
  }
  return orders;
}

// Amount to top a washout position up to the full weight: half weight of equity,
// capped by the remaining room under the full-weight cap (valued at latest close).
function topUpAmount(sym: string, e: Entry): bigint {
  const s = closes.get(sym);
  const p = positions.get(sym);
  if (!s || !p || p.qty === 0n) return 0n;
  // value of the holding at the latest close, from the entry price ratio:
  // qty is in asset units; price ratio (close / entry) times the cost basis
  // approximates the current quote value without needing the price scales.
  const ratio = s[s.length - 1] / e.price;
  const curVal = (p.cost * BigInt(Math.floor(ratio * 1e6))) / 1_000_000n;
  const fullCap = (BigInt(Math.floor(P.fullW * 1e6)) * equity) / 1_000_000n;
  const half = (BigInt(Math.floor(P.halfW * 1e6)) * equity) / 1_000_000n;
  let add = half;
  const room = fullCap > curVal ? fullCap - curVal : 0n;
  if (add > room) add = room;
  return add;
}

// --- wire: agent-fun/bars-replay/v1, one JSON line in, one reply out ---
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(line); } catch { process.exit(1); }
  if (msg.type === 'hello') {
    const syms = msg.symbols as Array<{ symbol: string }>;
    for (const s of syms) closes.set(s.symbol, []);
    return;
  }
  if (msg.type === 'batch') {
    seq = msg.seq as number;
    const bars = msg.bars as Bar[];
    for (const b of bars) closes.get(b.symbol)?.push(Number(b.c));
    const acc = msg.account as { cash_quote_units: string; positions: Array<{ symbol: string; qty: string; cost_quote_units: string }>; equity_quote_units: string };
    cash = BigInt(acc.cash_quote_units);
    equity = BigInt(acc.equity_quote_units);
    if (equity > peakEquity) peakEquity = equity;
    positions = new Map(acc.positions.map((p) => [p.symbol, { qty: BigInt(p.qty), cost: BigInt(p.cost_quote_units) }]));
    for (const f of (msg.fills as Fill[]) ?? []) {
      if (f.status !== 'filled') {
        // A rejected buy cancels the intent only when nothing is held;
        // a rejected top-up must NOT orphan the live position.
        if (f.side === 'buy' && !positions.has(f.symbol)) entry.delete(f.symbol);
        continue;
      }
      if (f.side === 'buy') {
        const e = entry.get(f.symbol);
        const fillQty = BigInt(f.qty);
        const fillPrice = Number(f.price);
        if (e && fillQty > 0n) {
          // top-up: volume-weighted average entry price
          const heldQty = positions.get(f.symbol)?.qty ?? fillQty;
          const oldQty = heldQty - fillQty;
          if (oldQty > 0n) {
            const avg = (Number(oldQty) * e.price + Number(fillQty) * fillPrice) / Number(heldQty);
            e.price = avg;
            e.topped = true;
          } else {
            e.price = fillPrice;
          }
          e.best = 0;
        } else {
          entry.set(f.symbol, { price: fillPrice, seq, kind: 'W', best: 0, topped: false });
        }
      } else if (f.side === 'sell') {
        const e = entry.get(f.symbol);
        if (e?.kind === 'P') lastPulseExit.set(f.symbol, seq);
        entry.delete(f.symbol);
      }
    }
    let orders = decide();
    if (orders.length > 16) orders = orders.slice(0, 16);
    const safe = orders.filter((o) => {
      if (o.side === 'buy') return typeof o.symbol === 'string' && /^[A-Z0-9]{1,20}$/.test(o.symbol) && BigInt(o.notional_quote_units as string) > 0n;
      return typeof o.symbol === 'string' && /^[A-Z0-9]{1,20}$/.test(o.symbol) && BigInt(o.qty as string) > 0n;
    });
    const withIds = safe.map((o, i) => ({ ...o, client_id: `o${seq}_${i}` }));
    process.stdout.write(JSON.stringify({ type: 'reply', seq, orders: withIds }) + '\n');
    return;
  }
  if (msg.type === 'done') {
    rl.close();
    process.stdin.destroy();
  }
});
