const https = require('https');
const TOKEN = process.env.TG_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;
const SYM = 'EVAAUSDT';

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const B = 'https://fapi.binance.com';
  const [klines, oi, funding] = await Promise.all([
    get(B + '/fapi/v1/klines?symbol=' + SYM + '&interval=1h&limit=3'),
    get(B + '/futures/data/openInterestHist?symbol=' + SYM + '&period=1h&limit=3'),
    get(B + '/fapi/v1/fundingRate?symbol=' + SYM + '&limit=3')
  ]);

  if (!Array.isArray(klines) || klines.length < 2) {
    console.log('Not enough kline data'); return;
  }
  if (!Array.isArray(oi) || oi.length < 2) {
    console.log('Not enough OI data'); return;
  }

  const cu = klines[klines.length - 1];
  const co = oi[oi.length - 1];
  const po = oi[oi.length - 2];
  const lf = Array.isArray(funding) && funding.length ? parseFloat(funding[funding.length - 1].fundingRate) : 0;

  const open = parseFloat(cu[1]);
  const close = parseFloat(cu[4]);
  const vol = parseFloat(cu[5]);
  const bvol = parseFloat(cu[9]);
  const pchg = (close - open) / open * 100;
  const br = bvol / vol * 100;
  const oiNow = parseFloat(co.sumOpenInterest);
  const oiPrev = parseFloat(po.sumOpenInterest);
  const oiChg = (oiNow - oiPrev) / oiPrev * 100;
  const fp = lf * 100;

  console.log('OI:' + oiChg.toFixed(3) + '% P:' + pchg.toFixed(3) + '% F:' + fp.toFixed(4) + '% Buy:' + br.toFixed(1) + '%');

  let phase = null;
  if (oiChg < -1.5 && pchg < -2.0) phase = 'flush';
  else if (oiChg > 0.4 && pchg > 1.5 && br > 55) phase = 'markup';
  else if (pchg > 0.5 && oiChg < -0.3 && fp > 0.06) phase = 'distribution';
  else if (Math.abs(oiChg) < 0.6 && Math.abs(pchg) < 1.2 && fp < 0.055) phase = 'accumulation';

  if (!phase) { console.log('No phase matched'); return; }

  const LABELS = {
    accumulation: 'ACCUMULATION',
    markup: 'MARKUP',
    distribution: 'DISTRIBUTION',
    flush: 'FLUSH / CAPITULATION'
  };

  const upd = await get('https://api.telegram.org/bot' + TOKEN + '/getUpdates?limit=50');
  let lastPhase = null;
  if (upd.ok && upd.result && upd.result.length) {
    const cut = Math.floor(Date.now() / 1000) - 4 * 3600;
    const rec = upd.result.filter(u =>
      u.message && u.message.from && u.message.from.is_bot && u.message.date > cut
    );
    if (rec.length) {
      const txt = rec[rec.length - 1].message.text || '';
      if (txt.includes('ACCUMULATION')) lastPhase = 'accumulation';
      else if (txt.includes('MARKUP')) lastPhase = 'markup';
      else if (txt.includes('DISTRIBUTION')) lastPhase = 'distribution';
      else if (txt.includes('FLUSH')) lastPhase = 'flush';
    }
  }

  console.log('Phase: ' + phase + ' | Last: ' + lastPhase);
  if (phase === lastPhase) { console.log('No change, skipping'); return; }

  const label = LABELS[phase];
  const msg = [
    label + ' PHASE ALERT',
    'Symbol: EVAAUSDT',
    '---',
    'Price:     $' + close.toFixed(4) + ' (' + (pchg >= 0 ? '+' : '') + pchg.toFixed(2) + '%)',
    'OI:        ' + (oiNow / 1e6).toFixed(3) + 'M (' + (oiChg >= 0 ? '+' : '') + oiChg.toFixed(3) + '%)',
    'Funding:   ' + fp.toFixed(4) + '%',
    'Buy Ratio: ' + br.toFixed(1) + '%',
    'Vol 1h:    ' + (vol / 1000).toFixed(1) + 'K',
    '---',
    new Date().toUTCString()
  ].join('\n');

  const result = await post('https://api.telegram.org/bot' + TOKEN + '/sendMessage', {
    chat_id: CHAT_ID,
    text: msg
  });
  console.log('Alert sent:', result.ok, '| Phase:', phase);
}

main().catch(e => { console.error(e.message); process.exit(1); });
