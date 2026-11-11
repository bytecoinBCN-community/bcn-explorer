// Bytecoin Explorer: a static page that reads everything from a bytecoind node over JSON-RPC. No database, no tracking.
'use strict';

// ?node=self talks to the site's own /json_rpc (for local testing behind a proxy)
const NODE = new URLSearchParams(location.search).get('node') === 'self' ? '' : 'https://node.bytecoin.community';
const ATOMIC = 100000000n;
const MAX_SUPPLY = 18446744073709551615n;  // 2^64 - 1 atomic units
const TARGET_BLOCK_TIME = 120;
const view = document.getElementById('view');
let status = null, statusAt = 0, refreshTimer = null, renderToken = 0;

// ---- helpers ----
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isHash = (s) => /^[0-9a-f]{64}$/i.test(s);
const int = (n) => Number(n).toLocaleString('en-US');

// Some fields (coins generated, cumulative difficulty) do not fit in a JS number, keep big integers as strings.
function parseJson(text) {
  return JSON.parse(text.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"'));
}
function bcn(atomic, minDecimals = 2) {
  let v = BigInt(String(atomic || 0));
  const neg = v < 0n;
  if (neg) v = -v;
  let frac = (v % ATOMIC).toString().padStart(8, '0').replace(/0+$/, '');
  if (frac.length < minDecimals) frac = frac.padEnd(minDecimals, '0');
  return (neg ? '-' : '') + (v / ATOMIC).toLocaleString('en-US') + (frac ? '.' + frac : '');
}
function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 60) return s + ' s ago';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min ago';
  return Math.floor(s / 86400) + ' d ago';
}
const utc = (ts) => !ts ? 'no timestamp (genesis)' : new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
function hashrate(difficulty) {
  let h = Number(difficulty) / TARGET_BLOCK_TIME, u = 0;
  const units = ['H/s', 'kH/s', 'MH/s', 'GH/s'];
  while (h >= 1000 && u < units.length - 1) { h /= 1000; u++; }
  return (h >= 100 ? Math.round(h) : h.toFixed(1)) + ' ' + units[u];
}
function size(bytes) { return bytes >= 10240 ? (bytes / 1024).toFixed(1) + ' KB' : int(bytes) + ' B'; }
const blockLink = (h) => `<a href="#/block/${esc(h)}">${int(h)}</a>`;
const txLink = (hash, short) => `<a class="mono" href="#/tx/${esc(hash)}">${esc(short ? hash.slice(0, 10) + '…' + hash.slice(-6) : hash)}</a>`;

async function rpc(method, params) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(NODE + '/json_rpc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal, cache: 'no-store',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || {} }),
    });
    if (r.status === 429) throw new Error('Too many requests. Wait a few seconds and try again.');
    if (!r.ok) throw new Error('The node answered with HTTP ' + r.status + '.');
    const j = parseJson(await r.text());
    if (j.error) { const e = new Error(j.error.message || 'Node error'); e.code = j.error.code; e.data = j.error.data; throw e; }
    return j.result;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The node did not answer in time.');
    if (err instanceof TypeError) throw new Error('Cannot reach the node. Check your connection.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
async function getStatus() {
  status = await rpc('get_status', {});  // empty request: answer at once, no long poll
  statusAt = Date.now();
  return status;
}

function setTitle(t) { document.title = t ? t + ' · Bytecoin Explorer' : 'Bytecoin Explorer'; }
function setNav(route) {
  document.querySelectorAll('nav a').forEach((a) => {
    const h = a.getAttribute('href');
    a.classList.toggle('on', h === '#/' + route || (route === '' && h === '#/'));
  });
}
function showError(err) {
  view.innerHTML = `<h1>Not found</h1><p class="err">${esc(err.message || err)}</p><p><a href="#/">Back to the latest blocks</a></p>`;
}

// ---- home: stats and latest blocks ----
const PAGE = 20;
async function renderHome(token, fromHeight) {
  setTitle('');
  const st = await getStatus();
  if (token !== renderToken) return;
  const top = st.top_block_height;
  const start = fromHeight === undefined ? top : Math.min(fromHeight, top);
  const heights = [];
  for (let h = start; h >= Math.max(0, start - PAGE); h--) heights.push(h);  // one extra block for tx counts
  const [headers, pool] = await Promise.all([
    Promise.all(heights.map((h) => rpc('get_block_header', { height_or_depth: h }).then((r) => r.block_header))),
    fromHeight === undefined ? rpc('sync_mem_pool', { known_hashes: [], need_redundant_data: false }).catch(() => null) : null,
  ]);
  if (token !== renderToken) return;
  const last = headers[0];
  const generated = BigInt(String(last.already_generated_coins));
  const left = MAX_SUPPLY - generated;
  const syncing = st.top_known_block_height > top + 5;
  let html = '';
  if (fromHeight === undefined) {
    html += `<div class="headrow">
      <h1>Bytecoin network</h1><span id="live" class="live">Live</span></div>
      ${syncing ? `<p class="note">Our node is still catching up with the network: block ${int(top)} of ${int(st.top_known_block_height)}. Recent blocks will appear once it is done.</p>` : ''}
      <div class="stats mt">
        <div class="stat"><span>Height</span><b>${int(top)}</b></div>
        <div class="stat"><span>Hashrate (from difficulty)</span><b>≈${hashrate(st.top_block_difficulty)}</b></div>
        <div class="stat"><span>Difficulty</span><b>${int(st.top_block_difficulty)}</b></div>
        <div class="stat"><span>Last block</span><b id="lastblock">${ago(st.top_block_timestamp)}</b></div>
        <div class="stat"><span>Mempool</span><b><a href="#/mempool">${pool ? int(pool.added_transactions.length) + ' tx' : '—'}</a></b></div>
        <div class="stat"><span>Left to mine</span><b>${(left / ATOMIC).toLocaleString('en-US')} BCN</b></div>
      </div>
      <h2>Latest blocks</h2>`;
  } else {
    html += `<h1>Blocks ${int(start)} and below</h1><p class="sub"><a href="#/">Back to the latest blocks</a></p>`;
  }
  html += `<div class="tablebox"><table><thead><tr><th>Height</th><th>Time</th><th class="r">Transactions</th>
    <th class="r hide-s">Size</th><th class="r">Reward, BCN</th><th class="hide-s">Hash</th></tr></thead><tbody>`;
  for (let i = 0; i < headers.length; i++) {
    const b = headers[i], prev = headers[i + 1];
    if (!prev && b.height !== 0) break;  // the extra block only gives the previous transaction count
    const txs = prev ? b.already_generated_transactions - prev.already_generated_transactions : 1;
    html += `<tr><td>${blockLink(b.height)}</td><td title="${esc(utc(b.timestamp))}">${esc(ago(b.timestamp))}</td>
      <td class="r">${int(txs)}</td><td class="r hide-s">${size(b.block_size)}</td><td class="r">${bcn(b.reward)}</td>
      <td class="hide-s"><a class="mono" href="#/block/${esc(b.hash)}">${esc(b.hash.slice(0, 16))}…</a></td></tr>`;
  }
  html += '</tbody></table></div>';
  const next = start - PAGE;
  if (next > 0) html += `<div class="more"><a class="btnlink" href="#/blocks/${next}">Older blocks</a></div>`;
  view.innerHTML = html;
  if (fromHeight === undefined) startRefresh(token, st.top_block_hash);
}

// Re-render the home page when a new block arrives; keep the "ago" labels fresh in between.
function startRefresh(token, topHash) {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    if (token !== renderToken || document.hidden) return;
    const live = document.getElementById('live');
    try {
      const st = await getStatus();
      if (token !== renderToken) return;
      if (live) { live.className = 'live'; live.textContent = 'Live'; }
      const lb = document.getElementById('lastblock');
      if (lb) lb.textContent = ago(st.top_block_timestamp);
      if (st.top_block_hash !== topHash) renderHome(token).catch(() => {});
    } catch (err) {
      if (live) { live.className = 'live stale'; live.textContent = 'Node not answering'; }
    }
  }, 15000);
}

// ---- block ----
async function renderBlock(token, id) {
  const param = /^\d+$/.test(id) ? { height_or_depth: Number(id) } : isHash(id) ? { hash: id.toLowerCase() } : null;
  if (!param) throw new Error('This is not a block height or a block hash.');
  const [res, st] = await Promise.all([rpc('get_raw_block', param), getStatus()]);
  if (token !== renderToken) return;
  const blk = res.block, h = blk.header;
  setTitle('Block ' + int(h.height));
  const conf = res.orphan_status ? 0 : st.top_block_height - h.height + 1;
  const coinbaseRaw = blk.raw_header && blk.raw_header.coinbase_transaction;
  let html = `<h1>Block ${int(h.height)} ${res.orphan_status ? '<span class="badge warn">Orphan</span>' : ''}</h1>
    <p class="sub hash">${esc(h.hash)}</p>
    <dl class="kv">
      <dt>Time</dt><dd>${esc(utc(h.timestamp))} · ${esc(ago(h.timestamp))}</dd>
      <dt>Confirmations</dt><dd>${res.orphan_status ? 'Not in the main chain' : int(conf)}</dd>
      <dt>Transactions</dt><dd>${int(blk.transactions.length)}</dd>
      <dt>Reward</dt><dd>${bcn(h.reward)} BCN</dd>
      <dt>Fees</dt><dd>${bcn(h.transactions_fee)} BCN</dd>
      <dt>Difficulty</dt><dd>${int(h.difficulty)}</dd>
      <dt>Size</dt><dd>${size(h.block_size)}</dd>
      <dt>Version</dt><dd>${h.major_version}.${h.minor_version}</dd>
      <dt>Nonce</dt><dd class="mono">${esc(h.binary_nonce || h.nonce)}</dd>
      <dt>Previous block</dt><dd class="hash">${h.height > 0 ? `<a href="#/block/${esc(h.previous_block_hash)}">${esc(h.previous_block_hash)}</a>` : '—'}</dd>
    </dl>
    <div class="pager"><span>${h.height > 0 ? `<a href="#/block/${h.height - 1}">← Block ${int(h.height - 1)}</a>` : ''}</span>
      <span>${!res.orphan_status && h.height < st.top_block_height ? `<a href="#/block/${h.height + 1}">Block ${int(h.height + 1)} →</a>` : ''}</span></div>
    <h2>Transactions</h2>
    <div class="tablebox"><table><thead><tr><th>Hash</th><th class="r">Outputs total, BCN</th><th class="r">Fee, BCN</th>
      <th class="r hide-s">In / out</th><th class="r hide-s">Size</th></tr></thead><tbody>`;
  blk.transactions.forEach((tx, i) => {
    const raw = i === 0 ? coinbaseRaw : blk.raw_transactions[i - 1];
    const io = raw ? `${raw.inputs.length} / ${raw.outputs.length}` : '';
    html += `<tr><td>${txLink(tx.hash, true)} ${tx.coinbase ? '<span class="badge">Coinbase</span>' : ''}</td>
      <td class="r">${bcn(tx.amount)}</td><td class="r">${tx.coinbase ? '—' : bcn(tx.fee)}</td>
      <td class="r hide-s">${io}</td><td class="r hide-s">${size(tx.size || tx.binary_size || 0)}</td></tr>`;
  });
  html += '</tbody></table></div>';
  view.innerHTML = html;
}

// ---- transaction ----
async function renderTx(token, hash) {
  if (!isHash(hash)) throw new Error('This is not a transaction hash.');
  const [res, st] = await Promise.all([rpc('get_raw_transaction', { hash: hash.toLowerCase() }), getStatus()]);
  if (token !== renderToken) return;
  const tx = res.transaction, raw = res.raw_transaction;
  setTitle('Transaction ' + tx.hash.slice(0, 10));
  const inPool = !tx.block_hash;
  const conf = inPool ? 0 : st.top_block_height - tx.block_height + 1;
  const ring = raw.inputs.length && raw.inputs[0].output_indexes ? raw.inputs[0].output_indexes.length : 0;
  const unlock = Number(tx.unlock_block_or_timestamp || 0);
  let html = `<h1>Transaction ${tx.coinbase ? '<span class="badge">Coinbase</span>' : ''}</h1>
    <p class="sub hash">${esc(tx.hash)}</p>
    <dl class="kv">
      <dt>Status</dt><dd>${inPool ? '<span class="badge warn">In mempool</span> waiting for a block'
        : `<span class="badge ok">Confirmed</span> ${int(conf)} confirmations`}</dd>
      ${inPool ? '' : `<dt>Block</dt><dd>${blockLink(tx.block_height)}</dd>`}
      <dt>${inPool ? 'First seen' : 'Time'}</dt><dd>${esc(utc(tx.timestamp))} · ${esc(ago(tx.timestamp))}</dd>
      <dt>Outputs total</dt><dd>${bcn(tx.amount)} BCN</dd>
      <dt>Fee</dt><dd>${tx.coinbase ? '—' : bcn(tx.fee) + ' BCN'}</dd>
      <dt>Size</dt><dd>${size(tx.size || tx.binary_size || 0)}</dd>
      ${ring ? `<dt>Ring size</dt><dd>${ring} (the real coin plus ${ring - 1} decoys per input)</dd>` : ''}
      ${unlock ? `<dt>Locked until</dt><dd>${unlock < 500000000 ? 'block ' + blockLink(unlock) : esc(utc(unlock))}</dd>` : ''}
    </dl>
    <h2>Inputs (${raw.inputs.length})</h2>`;
  if (tx.coinbase) {
    html += `<p class="sub">New coins created by the miner of block ${blockLink(tx.block_height)}.</p>`;
  } else {
    html += `<p class="sub">Each input is signed by a ring of outputs. One of them is the coin really spent, the rest are decoys, and nobody can tell which. The key image only proves that the coin is not spent twice.</p>
      <div class="tablebox"><table><thead><tr><th>#</th><th class="r">Amount, BCN</th><th>Ring members (block heights)</th><th class="hide-s">Key image</th></tr></thead><tbody>`;
    raw.inputs.forEach((inp, i) => {
      const mixed = (res.mixed_outputs && res.mixed_outputs[i]) || [];
      const members = mixed.length ? mixed.map((o) => blockLink(o.height)).join(' ') : esc((inp.output_indexes || []).length + ' outputs');
      html += `<tr><td>${i + 1}</td><td class="r">${bcn(inp.amount)}</td><td><div class="ring">${members}</div></td>
        <td class="hide-s mono">${esc((inp.key_image || '').slice(0, 16))}…</td></tr>`;
    });
    html += '</tbody></table></div>';
  }
  html += `<h2>Outputs (${raw.outputs.length})</h2>
    <p class="sub">Each output goes to a one-time key. Only the receiver can see that it is theirs.</p>
    <div class="tablebox"><table><thead><tr><th>#</th><th class="r">Amount, BCN</th><th>One-time key</th></tr></thead><tbody>`;
  raw.outputs.forEach((out, i) => {
    html += `<tr><td>${i + 1}</td><td class="r">${bcn(out.amount)}</td><td class="hash">${esc(out.public_key || out.key || '')}</td></tr>`;
  });
  html += '</tbody></table></div>';
  view.innerHTML = html;
}

// ---- mempool ----
async function renderMempool(token) {
  setTitle('Mempool');
  const res = await rpc('sync_mem_pool', { known_hashes: [], need_redundant_data: false });
  if (token !== renderToken) return;
  const txs = res.added_transactions.slice().sort((a, b) => b.timestamp - a.timestamp);
  let html = `<h1>Mempool</h1><p class="sub">Transactions our node has seen that are not in a block yet. A block is found about every 2 minutes.</p>`;
  if (!txs.length) {
    html += '<p class="note">The mempool is empty right now: every known transaction is already in a block.</p>';
  } else {
    html += `<div class="tablebox"><table><thead><tr><th>Hash</th><th>Seen</th><th class="r">Outputs total, BCN</th><th class="r">Fee, BCN</th><th class="r hide-s">Size</th></tr></thead><tbody>`;
    for (const tx of txs) {
      html += `<tr><td>${txLink(tx.hash, true)}</td><td>${esc(ago(tx.timestamp))}</td><td class="r">${bcn(tx.amount)}</td>
        <td class="r">${bcn(tx.fee)}</td><td class="r hide-s">${size(tx.size || tx.binary_size || 0)}</td></tr>`;
    }
    html += '</tbody></table></div>';
  }
  view.innerHTML = html;
}

// ---- payment proof ----
const PROOF_ERRORS = {
  '-201': 'This does not look like a send proof. Copy the whole proof from the wallet and try again.',
  '-202': 'The transaction in this proof is not in the main chain (yet).',
  '-203': 'The proof does not match the transaction: the signature is wrong.',
};
function renderProof() {
  setTitle('Check a payment');
  view.innerHTML = `<h1>Check a payment</h1>
    <p class="sub">The sender can create a send proof in their wallet (walletd: <code>create_sendproof</code>). It shows who received how much in a transaction, without revealing anything else. Paste it here to check it against the blockchain.</p>
    <form id="proof-form"><textarea id="proof" spellcheck="false" autocomplete="off" aria-label="Send proof" placeholder="Paste the send proof here"></textarea>
    <p><button type="submit" id="proof-btn">Verify proof</button></p></form>
    <div id="proof-out" aria-live="polite"></div>`;
  document.getElementById('proof-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = document.getElementById('proof').value.trim();
    const out = document.getElementById('proof-out');
    if (!text) { out.innerHTML = '<p class="err">Paste a send proof first.</p>'; return; }
    const btn = document.getElementById('proof-btn');
    btn.disabled = true;
    out.innerHTML = '<p class="sub">Checking…</p>';
    try {
      const [r, st] = await Promise.all([rpc('check_sendproof', { sendproof: text }), getStatus()]);
      const tx = await rpc('get_raw_transaction', { hash: r.transaction_hash }).catch(() => null);
      const conf = tx && tx.transaction.block_hash ? st.top_block_height - tx.transaction.block_height + 1 : 0;
      out.innerHTML = `<p class="note"><span class="badge ok">Valid proof</span> This transaction sent <b>${bcn(r.amount)} BCN</b> to the address below.</p>
        <dl class="kv mt">
          <dt>Amount</dt><dd>${bcn(r.amount)} BCN</dd>
          <dt>Receiver</dt><dd class="hash">${esc(r.address)}</dd>
          <dt>Transaction</dt><dd class="hash">${txLink(r.transaction_hash)}</dd>
          ${tx ? `<dt>Confirmations</dt><dd>${int(conf)}${tx.transaction.block_hash ? ' · block ' + blockLink(tx.transaction.block_height) : ''}</dd>` : ''}
          ${r.message ? `<dt>Message</dt><dd>${esc(r.message)}</dd>` : ''}
        </dl>`;
    } catch (err) {
      const known = PROOF_ERRORS[String(err.code)];
      const txh = err.data && err.data.transaction_hash;
      out.innerHTML = `<p class="note"><span class="badge warn">Not valid</span> ${esc(known || err.message)}
        ${txh && isHash(txh) ? '<br>Transaction: ' + txLink(txh) : ''}</p>`;
    } finally {
      btn.disabled = false;
    }
  });
}

// ---- search ----
document.getElementById('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('q');
  const q = input.value.trim().replace(/\s+/g, '');
  if (!q) return;
  if (/^\d{1,9}$/.test(q)) { location.hash = '#/block/' + q; input.value = ''; return; }
  if (!isHash(q)) { showError(new Error('Enter a block height, a block hash or a transaction hash (64 hex characters).')); return; }
  view.innerHTML = '<p class="sub">Searching…</p>';
  try {
    await rpc('get_block_header', { hash: q.toLowerCase() });
    location.hash = '#/block/' + q.toLowerCase();
  } catch (err) {
    if (err.code !== -5) { showError(err); return; }
    try {
      await rpc('get_raw_transaction', { hash: q.toLowerCase() });
      location.hash = '#/tx/' + q.toLowerCase();
    } catch (err2) {
      showError(err2.code === -5 ? new Error('No block or transaction with this hash is known to our node.') : err2);
      return;
    }
  }
  input.value = '';
});

// ---- router ----
async function route() {
  const token = ++renderToken;
  clearInterval(refreshTimer);
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  setNav(parts[0]);
  window.scrollTo(0, 0);
  view.innerHTML = '<p class="sub">Loading…</p>';
  try {
    if (parts[0] === 'block' && parts[1]) await renderBlock(token, parts[1]);
    else if (parts[0] === 'blocks' && /^\d+$/.test(parts[1] || '')) await renderHome(token, Number(parts[1]));
    else if (parts[0] === 'tx' && parts[1]) await renderTx(token, parts[1]);
    else if (parts[0] === 'mempool') await renderMempool(token);
    else if (parts[0] === 'proof') renderProof();
    else await renderHome(token);
  } catch (err) {
    if (token !== renderToken) return;
    if (err.code === -5 || err.code === -2) err.message = 'Our node does not know this ' + (parts[0] === 'tx' ? 'transaction.' : 'block.');
    showError(err);
  }
}
window.addEventListener('hashchange', route);
route();
