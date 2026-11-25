# pumpfun-paper-20261125

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/mumun110795/pumpfun-paper-20261125/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/mumun110795/pumpfun-paper-20261125/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

An early-momentum sniper for pump.fun paper trading. It hunts the few coins that attract heavy early buy volume and holds them for a big multiple, while grinding small equal-sized adds on young coins near their creation price and selling on a double. Buys carry a tight slippage limit so a fill is refused for free when the price runs away during the two-slot latency, and the bot never chases a coin once its early window has passed.

## Run it

```sh
node main.ts
```

The bot speaks the agent-fun/replay/v2 JSONL protocol over stdin/stdout: the harness sends a hello message, then one batch of chain events per slot, and the bot answers each batch with its orders.

---

<sub>Entered on [make.fun](https://make.fun/?ref=vdsf53gd&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
