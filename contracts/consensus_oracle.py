# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""ConsensusOracle — multi-source price consensus with drift detection.

A caller submits a list of exchange API endpoints plus the JSON field to read
from each. The contract fetches EVERY source, derives a single agreed price
(median, with outlier rejection and a quorum requirement), and commits it
on-chain under validator consensus. Later, anyone can recheck the same sources
to detect whether the agreed price has drifted.

Consensus uses gl.vm.run_nondet with a leader/validator pair. The leader fetches
all sources and derives the agreed value; each validator INDEPENDENTLY fetches
the same sources and agrees only if it reproduces the leader's agreed price.
A leader that fabricates a price diverges from what validators independently
compute, so the round does not commit — that is what makes the dishonest-leader
case provable.

This deliberately does NOT use gl.eq_principle.strict_eq: strict_eq does not
enforce cross-validator equality for non-deterministic values on this network
(verified on-chain — a value that changes every execution committed under
AGREE). Here every validator re-derives the value independently.

The agreement rule is a MEDIAN, not an average: one corrupted or outlier source
cannot drag the agreed price. A price is accepted only if at least half the
sources return a usable value, so a leader cannot invent a price from a single
dead endpoint. Unreachable sources return -1 explicitly rather than 0, so a
dead endpoint cannot masquerade as a price of zero.

Storage uses parallel TreeMap keyed by reading_id with scalar values — no
@allow_storage dataclass, which this GenVM build rejects at deploy time
(verified by bisect: adding any such dataclass to an otherwise-working contract
makes the deploy store no code while still returning AGREE).

No funds are held or moved: the oracle's value is the consensus-derived price
record itself, which is the artifact consumers query.
"""

import json
import re
from datetime import datetime, timezone

from genlayer import *


# Agreement parameters. Plain ints at module level — class-level u256
# constants are not preserved in GenVM.
QUORUM_MIN_PCT = 50
OUTLIER_BPS = 500


def _fetch_number(url: str, field: str) -> int:
    """Fetch one source and extract a numeric value, scaled to 1e8.

    Returns -1 if the source is unreachable, malformed, or the field is
    missing — an explicit "unusable" signal so a dead endpoint cannot
    masquerade as a price of 0.
    """
    try:
        response = gl.nondet.web.request(url, method="GET")
        body = response.body if hasattr(response, "body") else (
            response.get("body", "") if isinstance(response, dict) else str(response))
        raw = body.decode("utf-8", errors="replace") if isinstance(body, bytes) else str(body)
        data = json.loads(raw)
        cur = data
        for part in field.split("."):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            else:
                return -1
        if isinstance(cur, bool):
            return -1
        if isinstance(cur, (int, float)):
            return int(round(float(cur) * 100000000))
        return -1
    except Exception:
        return -1


def _median(values) -> int:
    vals = sorted(values)
    n = len(vals)
    if n == 0:
        return -1
    if n % 2 == 1:
        return vals[n // 2]
    return (vals[n // 2 - 1] + vals[n // 2]) // 2


def _agree(urls, fields) -> dict:
    """Fetch every source and derive the agreed price.

    Deterministic given identical source responses, so every validator
    reproduces the same agreed price.
    """
    raw = []
    for i in range(len(urls)):
        raw.append(_fetch_number(str(urls[i]), str(fields[i])))

    usable = [v for v in raw if v > 0]
    total = len(raw)
    if len(usable) * 100 < QUORUM_MIN_PCT * total:
        return {"price": -1, "used": len(usable), "total": total}

    med = _median(usable)
    kept = []
    for v in usable:
        if med == 0:
            kept.append(v)
            continue
        dev = abs(v - med) * 10000 // med
        if dev <= OUTLIER_BPS * 10:
            kept.append(v)
    final = _median(kept) if kept else med
    return {"price": final, "used": len(usable), "total": total}


class ConsensusOracle(gl.Contract):
    """Multi-source price consensus: independent validator-verified reads
    aggregated into one on-chain reading, with drift re-checking."""

    asset: TreeMap[str, str]
    sources: TreeMap[str, str]
    fields: TreeMap[str, str]
    price: TreeMap[str, u256]
    used_sources: TreeMap[str, u256]
    total_sources: TreeMap[str, u256]
    reporter: TreeMap[str, str]
    created_at: TreeMap[str, u256]
    recheck_count: TreeMap[str, u256]
    last_recheck: TreeMap[str, str]
    reading_count: u256 = u256(0)

    def __init__(self):
        self.reading_count = u256(0)

    def _now(self) -> int:
        return int(datetime.now(timezone.utc).timestamp())

    def _consensus(self, urls, fields) -> dict:
        """One independent leader/validator consensus round over all sources."""
        u = list(urls)
        f = list(fields)

        def leader_fn() -> dict:
            return _agree(u, f)

        def validator_fn(leader_res) -> bool:
            if not isinstance(leader_res, gl.vm.Return):
                return False
            mine = _agree(u, f)
            return mine.get("price") == leader_res.calldata.get("price")

        result = gl.vm.run_nondet(leader_fn, validator_fn)
        result_data = result.calldata if hasattr(result, "calldata") else result
        return {
            "price": int(result_data.get("price", -1)),
            "used": int(result_data.get("used", 0)),
            "total": int(result_data.get("total", 0)),
        }

    @gl.public.write
    def read(self, reading_id: str, asset: str,
             sources: DynArray[str], fields: DynArray[str]) -> str:
        if not reading_id:
            raise gl.vm.UserError("reading_id required")
        if self.price.get(reading_id, None) is not None:
            raise gl.vm.UserError(f"Reading {reading_id} already exists")
        if len(sources) == 0:
            raise gl.vm.UserError("at least one source required")
        if len(sources) != len(fields):
            raise gl.vm.UserError("sources and fields must be the same length")

        target_urls = list(sources)
        target_fields = list(fields)

        res = self._consensus(target_urls, target_fields)
        price = res["price"]

        if price < 0:
            raise gl.vm.UserError("No quorum: too few usable sources")

        self.asset[reading_id] = asset
        self.sources[reading_id] = json.dumps(target_urls)
        self.fields[reading_id] = json.dumps(target_fields)
        self.price[reading_id] = u256(price)
        self.used_sources[reading_id] = u256(res["used"])
        self.total_sources[reading_id] = u256(res["total"])
        self.reporter[reading_id] = str(gl.message.sender_address)
        self.created_at[reading_id] = u256(self._now())
        self.recheck_count[reading_id] = u256(0)
        self.last_recheck[reading_id] = ""
        self.reading_count += u256(1)
        return str(price)

    @gl.public.write
    def recheck(self, reading_id: str) -> str:
        reading_id = str(reading_id)
        if self.price.get(reading_id, None) is None:
            raise gl.vm.UserError(f"Reading {reading_id} not found")

        target_urls = json.loads(self.sources[reading_id])
        target_fields = json.loads(self.fields[reading_id])
        stored_price = int(self.price[reading_id])

        res = self._consensus(target_urls, target_fields)
        price = res["price"]

        self.recheck_count[reading_id] += u256(1)
        if price < 0:
            result = "INCONCLUSIVE"
        elif price == stored_price:
            result = "UNCHANGED"
        else:
            result = "DRIFTED"
        self.last_recheck[reading_id] = result
        if price >= 0:
            self.price[reading_id] = u256(price)
            self.used_sources[reading_id] = u256(res["used"])
        return result

    @gl.public.view
    def get_reading(self, reading_id: str) -> dict:
        reading_id = str(reading_id)
        if self.price.get(reading_id, None) is None:
            return {"exists": False}
        return {
            "exists": True,
            "reading_id": reading_id,
            "asset": self.asset[reading_id],
            "sources": json.loads(self.sources[reading_id]),
            "fields": json.loads(self.fields[reading_id]),
            "price": int(self.price[reading_id]),
            "used_sources": int(self.used_sources[reading_id]),
            "total_sources": int(self.total_sources[reading_id]),
            "reporter": self.reporter[reading_id],
            "created_at": int(self.created_at[reading_id]),
            "recheck_count": int(self.recheck_count[reading_id]),
            "last_recheck": self.last_recheck[reading_id],
        }

    @gl.public.view
    def total_readings(self) -> u256:
        return self.reading_count

    @gl.public.view
    def now(self) -> str:
        return datetime.now(timezone.utc).isoformat()
