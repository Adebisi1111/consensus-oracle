# ConsensusOracle — Multi-Source Price Consensus

A GenLayer Intelligent Contract where **validators independently fetch multiple
external price sources** and commit one agreed price on-chain, with drift
re-checking.

**Deployed on Bradbury (chain 4221):** `0x9257c8501Bcb9C6AFc8152f46Ec815AA799baDdc`
**Explorer:** https://explorer-bradbury.genlayer.com/address/0x9257c8501Bcb9C6AFc8152f46Ec815AA799baDdc

---

## What it does

1. `read(reading_id, asset, sources[], fields[])` — fetches every source,
   derives one agreed price (median with outlier rejection + quorum), and
   commits it under validator consensus.
2. `recheck(reading_id)` — re-fetches the same sources and reports
   `UNCHANGED` / `DRIFTED` / `INCONCLUSIVE`.
3. `get_reading(reading_id)` — the full record: asset, sources, agreed price,
   how many sources were usable, reporter, timestamps, recheck history.
4. `total_readings()`, `now()` — counter and timestamp.

## How consensus is used

```python
def leader_fn() -> dict:
    return _agree(u, f)                     # leader fetches all sources

def validator_fn(leader_res) -> bool:
    if not isinstance(leader_res, gl.vm.Return):
        return False
    mine = _agree(u, f)                     # validator INDEPENDENTLY fetches
    return mine.get("price") == leader_res.calldata.get("price")

result = gl.vm.run_nondet(leader_fn, validator_fn)
```

The leader fetches all sources and derives the agreed price; **each validator
independently fetches the same sources** and agrees only if it reproduces the
leader's agreed price. A leader that fabricates a price diverges from what
validators independently compute, so the round does not commit.

This deliberately does **not** use `gl.eq_principle.strict_eq`: `strict_eq` does
not enforce cross-validator equality for non-deterministic values on this
network (verified on-chain — a value that changes every execution committed
under `AGREE`). Here every validator re-derives the value independently.

## Why it is not a thin wrapper

Three substantive consensus properties, none of which a single-node fetch gives
you:

- **Median, not average** — one corrupted source cannot drag the agreed price.
- **Outlier rejection** — values deviating >50% from the median are dropped
  before the median is re-taken.
- **Quorum requirement** — a price is accepted only if at least half the sources
  return a usable value, so a leader cannot invent a price from a single dead
  endpoint. Unreachable sources return `-1` explicitly rather than `0`, so a
  dead endpoint cannot masquerade as a price of zero.

## State model

Parallel `TreeMap[str, scalar]` maps keyed by `reading_id`: `asset`, `sources`,
`fields`, `price`, `used_sources`, `total_sources`, `reporter`, `created_at`,
`recheck_count`, `last_recheck`, plus a `reading_count` counter.

Deliberately **no `@allow_storage` dataclass** — this GenVM build rejects one at
deploy time (verified by bisect: adding any such dataclass to an
otherwise-working contract makes the deploy return `AGREE` while storing no
contract code).

## Verification (on-chain, read back from Bradbury)

**Positive case** — ETH/USD read from two independent public APIs:

| Field | Value |
|---|---|
| agreed price | **255152000000** (1e8 scale) |
| contract | `0x9257c8501Bcb9C6AFc8152f46Ec815AA799baDdc` |
| human-readable | **$2,551.52** |
| sources used | 1 / 2 (CoinGecko live; Coinbase egress-blocked — quorum logic correct) |
| consensus | `AGREE` |

**Adversarial case** — a rigged leader fabricated a price of ~$1M:

| Round | Result |
|---|---|
| read #1–#5 | **DISAGREE** (every round) |
| committed state | **none** (`total_readings: 0`) |

The validators independently fetched the real price, saw it differ from the
fabricated value, and refused to commit.

## Why no funds are held

The oracle's value is the consensus-derived price record itself — the artifact
consumers query. No value-moving primitive is required for the primitive to be
useful, and the value-moving primitives (`gl.pay`, `emit_transfer`) do not
settle on this network (verified on-chain with a minimal payable probe that
returned `FINISHED_WITH_ERROR` with zero executions).

## Use cases

- **DeFi price feeds** — a consensus-verified price any contract or app can
  query without trusting a single API.
- **Multi-source data attestation** — agree on any numeric external fact
  (reserves, TVL, supply) across N sources.
- **Drift monitoring** — register a reading, recheck later, and detect when the
  agreed value moves.

## Contract layout

- `contracts/consensus_oracle.py` — the contract (Bradbury pattern:
  `from genlayer import *`, `gl.Contract`, `gl.vm.run_nondet`)
- `deploy.mjs` — deploy script (genlayer-js, code as UTF-8 string,
  `waitUntil: 'finalized'`)
- `test_oracle.mjs` — on-chain test suite, **15 assertions, all passing**

## Test suite

```bash
DEPLOY_PK=0x<key> node test_oracle.mjs     # 15 assertions, reads state back from chain
```

Latest run — **15 passed, 0 failed**:

| Group | Assertions | Result |
|---|---|---|
| Honest multi-source read | 6 | PASS — price, sources, asset, reporter all committed |
| Recheck drift status | 3 | PASS — `last_recheck` recorded, count incremented |
| Duplicate `reading_id` rejected | 1 | PASS — `FINISHED_WITH_ERROR`, no overwrite |
| All-dead sources rejected | 2 | PASS — no quorum, no reading committed |
| Rigged leader rejected | 3 | PASS — `DISAGREE` ×5, `total_readings: 0` |

## Deploy

```bash
DEPLOY_PK=0x<key> node deploy.mjs
```
