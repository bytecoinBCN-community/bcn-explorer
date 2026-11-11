# Bytecoin Explorer

A block explorer for Bytecoin (BCN) that is just three static files. The browser reads everything straight from a `bytecoind` node over its JSON-RPC API, so there is no database, no indexer and no server code to run.

Live: <https://explorer.bytecoin.community>, served from the community node <https://node.bytecoin.community>.

## What it shows

- **Network:** height, hashrate estimated from difficulty, difficulty, time since the last block, mempool size and how much BCN is left to mine.
- **Blocks:** the latest blocks (refreshed when a new block arrives) and older ones page by page. Each block shows its time, confirmations, reward, fees, difficulty, size and transactions.
- **Transactions:** status, confirmations, fee, ring size, every input with the block heights of its ring members, and every output with its amount and one-time key.
- **Mempool:** transactions the node has seen that are not in a block yet.
- **Payment check:** paste a send proof made by `walletd` (`create_sendproof`) and the node verifies it against the chain. It shows who received how much in that transaction.
- **Search:** by block height, block hash or transaction hash.

There is no address search and there are no address balances. Bytecoin hides senders, receivers and balances, so an explorer cannot show them.

## How it works

| File | What it is |
| --- | --- |
| `index.html` | The page, with a strict Content-Security-Policy |
| `app.js` | Routing (`#/block/…`, `#/tx/…`, `#/mempool`, `#/proof`) and the RPC calls |
| `style.css` | Styles, light and dark |
| `deploy/` | The nginx configs we use for the explorer and for the public node |

The node methods used are `get_status`, `get_block_header`, `get_raw_block`, `get_raw_transaction`, `sync_mem_pool` and `check_sendproof`. Some numbers in the node's answers (coins generated, cumulative difficulty) do not fit in a JavaScript number. `app.js` keeps them as strings and uses `BigInt` for amounts.

## Run it yourself

1. Run a node with its RPC on localhost, for example the [Docker image](https://github.com/bytecoinBCN-community/bytecoin#run-with-docker).
2. Put the three files on any static web server.
3. Point the page at your node. Either edit `NODE` at the top of `app.js` and add that host to `connect-src` in the CSP, or proxy `/json_rpc` on the same site to `127.0.0.1:8081` and open the page with `?node=self`.

`deploy/nginx-node.conf` shows how we publish a node for browsers:
- only `/json_rpc`, `/binary_rpc` and `/sync_blocks/…` are exposed;
- CORS headers, a per-IP rate limit and a cache for static sync blocks;
- while `/etc/nginx/bcn-syncing` exists, `/sync_blocks/` answers 503, so a node that is still syncing never gets incomplete answers cached.

Run `bytecoind` with `--CORS`: without it the node does not serve static sync blocks, which browser wallets use.

## Privacy

The page sets no cookies and loads nothing from third parties. The web server and the node you query see your IP address and what you look up, as with any website.

## License

LGPL-3.0, like Bytecoin itself. See [LICENSE](LICENSE).
