#!/bin/bash
SP=/tmp/claude-0/-home-claude/c667cef1-564c-5988-af83-0e432e6ac15a/scratchpad
SITE=/home/claude/sakartvelo-exchange/site
LOG=$SP/ui.log; : > $LOG
for f in anvil.pid preview.pid; do [ -f $SP/$f ] && kill $(cat $SP/$f) 2>/dev/null; done; sleep 1
$SP/anvil/anvil --accounts 8 --balance 100000 --gas-limit 32000000 --hardfork cancun --code-size-limit 24576 --silent & echo $! > $SP/anvil.pid
sleep 2
cd $SP/ui && ART=$SP/build/art node setup.mjs >> $LOG 2>&1 || { echo "SETUP FAILED" >> $LOG; exit 1; }
ADDR=$(node -e 'console.log(JSON.stringify(require("./state.json").addresses))')
cd $SITE && VITE_NETWORK=local VITE_LOCAL_ADDRESSES="$ADDR" npx vite build --outDir $SP/site-dist --emptyOutDir >> $LOG 2>&1 || { echo "BUILD FAILED" >> $LOG; exit 1; }
cd $SITE && npx vite preview --outDir $SP/site-dist --port 4173 --strictPort --host 127.0.0.1 > $SP/preview.log 2>&1 & echo $! > $SP/preview.pid
sleep 3
echo READY >> $LOG

