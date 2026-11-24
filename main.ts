// Pump-paper-bot: early-momentum paper trading bot for make.fun's
// "Pump.fun Replay Sprint — Paper Bot, Real Ranking"
// (u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122).
// Buys maturing bonding curves showing accelerating buy flow, pyramids into
// strength, and exits on stop-loss / trailing stop / take-profit / fade.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
