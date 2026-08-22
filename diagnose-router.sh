#!/bin/bash

# Why is this Gateway not registered with the federation Router?
#
# One read-only pass over the four things that answer it, because chasing them one command at a time
# over a phone is how a five-minute problem becomes an afternoon. Nothing here starts, stops or
# writes anything.
#
# NEVER prints a secret. transport.json holds the WS bearer, so this reports only the SHAPE of it -
# which transport, which URL, whether a bearer exists - and the cert fingerprint, which is public on
# the Router's own /health and is the one value worth comparing by eye.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="${GATEWAY_CONTAINER:-switchboard}"
TRANSPORT="$SCRIPT_DIR/volumes/gateway-data/federation/transport.json"

echo "=============================================================="
echo " 1. Is the gateway even staying up?"
echo "=============================================================="
# A restart loop and a connection problem look identical from the outside, and only this tells them
# apart: an uptime measured in seconds means the process dies before it can report anything.
docker ps -a --filter "name=${CONTAINER}" --format '{{.Names}}\t{{.Status}}' 2>/dev/null || echo "docker not reachable"

echo
echo "=============================================================="
echo " 2a. Router lines only (the outcome of each attempt)"
echo "=============================================================="
ROUTER_LINES=$(docker logs "$CONTAINER" --since 10m 2>&1 | grep -iE "router-client|router\]|registered|register" | tail -20)
if [ -n "$ROUTER_LINES" ]; then
	echo "$ROUTER_LINES"
else
	# Silence here is the GOOD case, and saying so stops it reading as a failure.
	echo "(nothing in 10m - normal for a gateway that registered once and has stayed up;"
	echo " a gateway retrying would print an attempt roughly every 30s)"
fi

echo
echo "=============================================================="
echo " 2b. UNFILTERED tail - what sits between those attempts"
echo "=============================================================="
# Unfiltered on purpose. Grepping for the router prefix is what hid the reason last time: every
# failure path logs something, so the lines BETWEEN the attempts are the answer.
docker logs "$CONTAINER" --since 3m 2>&1 | tail -30 || echo "no logs for ${CONTAINER}"

echo
echo "=============================================================="
echo " 3. Which Router it is dialing, and with what (no secrets)"
echo "=============================================================="
# Through the container first: the Router root-owns this directory, so the host user usually cannot
# read it. Read ONCE into a variable, because a per-field read that fails renders every field as
# absent - and "absent" here reads as a diagnosis ("no bearer!") rather than as the non-answer it is.
BLOB=$(docker exec "$CONTAINER" cat /app/data/federation/transport.json 2>/dev/null)
[ -z "$BLOB" ] && [ -r "$TRANSPORT" ] && BLOB=$(cat "$TRANSPORT" 2>/dev/null)

field() { echo "$BLOB" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | cut -d'"' -f4; }

if [ -n "$BLOB" ]; then
	echo "transport : $(field transport)"
	echo "routerUrl : $(field routerUrl)"
	echo "pinned fp : $(field routerCertFp)"
	# Only ever stated when the file was actually read; see the note above.
	case "$BLOB" in
		*'"bearer"'*) echo "bearer    : present (not shown)" ;;
		*) echo "bearer    : absent - the Router refuses the upgrade without it" ;;
	esac
elif docker inspect "$CONTAINER" >/dev/null 2>&1; then
	echo "could not READ transport.json (container up but the file is unreadable) - not a verdict, just no answer"
else
	echo "no transport.json readable, and no ${CONTAINER} container"
	echo "-> if the file genuinely does not exist, this gateway is ARMING and has no Router to reach (./setup.sh)"
fi

echo
echo "=============================================================="
echo " 4. Can this machine reach the Router at all?"
echo "=============================================================="
# The fingerprint here is what the pin above must equal. A mismatch is a re-provision, not a bug.
URL=$(field routerUrl)
if [ -n "$URL" ]; then
	echo "GET ${URL}/health"
	# From INSIDE the gateway container: that is the thing which actually dials, and a routerUrl is
	# often a docker-network alias that the host cannot resolve at all. Probing from the host would
	# report a healthy Router as unreachable purely because the name means nothing out here.
	OUT=$(docker exec "$CONTAINER" sh -c "curl -sk --max-time 8 '${URL}/health'" 2>/dev/null)
	[ -z "$OUT" ] && OUT=$(curl -sk --max-time 8 "${URL}/health" 2>/dev/null)
	if [ -n "$OUT" ]; then
		echo "$OUT"
		echo
		echo "-> compare that certFingerprint with the pinned fp above; they must be equal"
	else
		echo "  ...no answer from the gateway container or this host"
	fi
else
	echo "(no routerUrl to probe)"
fi

echo
echo "=============================================================="
echo " Read it like this"
echo "=============================================================="
cat <<'GUIDE'
  Status shows a recent restart / seconds of uptime
      -> a crash loop, not a connectivity problem. The reason is in section 2.
  Section 2 has ONLY "connecting to ..." and nothing between
      -> the process is dying mid-connect; check section 1 and the host's memory.
  "router cert fingerprint mismatch"
      -> section 3's pinned fp != section 4's certFingerprint. Re-provision this gateway.
  "gateway_register failed" / "Router rejected registration"
      -> reached the Router and was refused; the reason on that line is the answer.
  "registered as Gateway" present
      -> it IS registered, and the problem is elsewhere.
GUIDE
