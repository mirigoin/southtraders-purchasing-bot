const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));
// ============ ENV ============
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'marco_verify_2024';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OWNER_PHONE = process.env.OWNER_PHONE || '17865591119';
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 10000;

// ============ DB ============
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes('render.com') ? { rejctUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS suppliers (
    id SERIAL PRIMARY KEY,
    slot INTEGER UNIQUE NOT NULL,
    name TEXT,
    alias TEXT,
    whatsapp_group_id TEXT,
    whatsapp_group_name TEXT,
    contact_phone TEXT,
    contact_name TEXT,
    country TEXT,
    notes TEXT,
    active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  const count = await pool.query('SELECT COUNT(*) FROM suppliers');
  if (parseInt(count.rows[0].count) === 0) {
    const values = [];
    for (let i = 1; i <= 50; i++) { values.push(`(${i})`); }
    await pool.query(`INSERT INTO suppliers (slot) VALUES ${values.join(',')}`);
    console.log('Seeded 50 supplier slots');
  }

  await pool.query(`CREATE TABLE IF NOT EXISTS quotes (
    id SERIAL PRIMARY KEY,
    supplier_slot INTEGER REFERENCES suppliers(slot),
    supplier_name TEXT,
    source TEXT DEFAULT 'group',
    raw_text TEXT,
    product TEXT,
    model TEXT,
    capacity TEXT,
    color TEXT,
    condition TEXT DEFAULT 'new',
    price NUMERIC,
    currency TEXT DEFAULT 'USD',
    qty INTEGER,
    incoterm TEXT DEFAULT 'CIF Miami',
    ts TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS quote_requests (
    id SERIAL PRIMARY KEY,
    product TEXT,
    target_price NUMERIC,
    suppliers_sent TEXT,
    message_sent TEXT,
    responses INTEGER DEFAULT 0,
    status TEXT DEFAULT 'open',
    ts TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS group_messages (
    id SERIAL PRIMARY KEY,
    group_id TEXT,
    group_name TEXT,
    sender_phone TEXT,
    sender_name TEXT,
    message_text TEXT,
    has_quote BOOLEAN DEFAULT FALSE,
    processed BOOLEAN DEFAULT FALSE,
    ts TIMESTAMPTZ DEFAULT NOW(),
    media_type TEXT,
    media_id TEXT,
    media_caption TEXT,
    media_filename TEXT,
    media_mime TEXT,
    wa_message_id TEXT
  )`);
// Migrations: agregar columnas nuevas si no existen (idempotente)
await pool.query(`
  ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS media_type TEXT;
  ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS media_id TEXT;
  ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS media_caption TEXT;
  ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS media_filename TEXT;
  ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS media_mime TEXT;
  ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS wa_message_id TEXT;
`);

// Tabla de log de requests de precio (para rate limiting)
await pool.query(`
  CREATE TABLE IF NOT EXISTS price_request_log (
    id SERIAL PRIMARY KEY,
    supplier_phone TEXT NOT NULL,
    product_key TEXT NOT NULL,
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    notified_owner BOOLEAN DEFAULT FALSE
  );
  CREATE INDEX IF NOT EXISTS idx_prl_phone_prod ON price_request_log(supplier_phone, product_key, requested_at DESC);
`);

// Tabla de introducciones: tracking de a qué supplier/grupo ya se presentó Marco
await pool.query(`
  CREATE TABLE IF NOT EXISTS marco_introductions (
    id SERIAL PRIMARY KEY,
    supplier_phone TEXT UNIQUE NOT NULL,
    introduced_at TIMESTAMPTZ DEFAULT NOW()
  );
`);

// Re-sincronizar secuencias de SERIAL (importante después de seed de datos externos)
try {
  await pool.query(`SELECT setval(pg_get_serial_sequence('group_messages', 'id'), COALESCE((SELECT MAX(id) FROM group_messages), 1))`);
  await pool.query(`SELECT setval(pg_get_serial_sequence('quotes', 'id'), COALESCE((SELECT MAX(id) FROM quotes), 1))`);
  console.log('[init] serial sequences re-synced');
} catch (e) {
  console.error('[init] setval failed (non-fatal):', e.message);
}

  await pool.query(`CREATE TABLE IF NOT EXISTS purchase_minimums (
    id SERIAL PRIMARY KEY,
    codigo TEXT UNIQUE NOT NULL,
    descripcion TEXT,
    minimo INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Migrations - agregar columnas si no existen
  await pool.query(`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS target_price NUMERIC`);
  await pool.query(`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS suppliers_sent TEXT`);
  await pool.query(`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS message_sent TEXT`);
  await pool.query(`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS responses INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'open'`);
  await pool.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS group_id TEXT`);
  await pool.query(`ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS wa_message_id TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_messages_wa_id ON group_messages(wa_message_id)`);

  console.log('DB OK');
}

// ============ CLAUDE - EXTRACT QUOTES ============
// ============ STOCK-WITHOUT-PRICE DETECTION (Nivel 2 — pedir precio) ============
// Cuando un proveedor anuncia stock sin precio, notifica al owner con mensaje sugerido en ingles.
// Rate limit: max 1 notificacion por producto+proveedor cada 6 horas.
async function notifyOwnerStockNoPrice(quotes, msgInfo) {
  if (!quotes || !Array.isArray(quotes) || quotes.length === 0) return;
  const noPriceQuotes = quotes.filter(q => q.price === null || q.price === undefined);
  if (noPriceQuotes.length === 0) return;

  const supplierPhone = msgInfo.supplierPhone || msgInfo.from || 'unknown';
  const supplierName = msgInfo.supplierName || msgInfo.senderName || supplierPhone;

  // Generar product_key de cada quote (canonical)
  const productKeys = noPriceQuotes.map(q => {
    return [q.product, q.model, q.capacity, q.color, q.spec].filter(Boolean).join('|').toLowerCase();
  });

  // Rate limit check: descartar productos ya notificados en las últimas 6h
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const allowedKeys = [];
  for (const key of productKeys) {
    try {
      const recent = await pool.query(
        'SELECT 1 FROM price_request_log WHERE supplier_phone = $1 AND product_key = $2 AND requested_at > $3 LIMIT 1',
        [supplierPhone, key, sixHoursAgo]
      );
      if (recent.rows.length === 0) allowedKeys.push(key);
    } catch (e) {
      console.error('[notifyOwnerStockNoPrice] rate-limit query failed:', e.message);
    }
  }
  if (allowedKeys.length === 0) return; // todos rate-limited

  // Logear las nuevas requests
  for (let i = 0; i < productKeys.length; i++) {
    if (!allowedKeys.includes(productKeys[i])) continue;
    try {
      await pool.query(
        'INSERT INTO price_request_log (supplier_phone, product_key, notified_owner) VALUES ($1, $2, TRUE)',
        [supplierPhone, productKeys[i]]
      );
    } catch(e) { /* duplicate ok */ }
  }

  // Armar lista de productos en formato amigable
  const productLines = noPriceQuotes
    .filter((q, i) => allowedKeys.includes(productKeys[i]))
    .map(q => {
      const desc = [q.product, q.model, q.capacity, q.color, q.spec ? '(' + q.spec + ' spec)' : null].filter(Boolean).join(' ');
      const qtyStr = q.qty ? ` (qty: ${q.qty})` : '';
      return `• ${desc}${qtyStr}`;
    });

  // Check si Marco ya se presentó a este supplier. Si no, incluir intro.
  let alreadyIntroduced = false;
  try {
    const introRes = await pool.query(
      'SELECT 1 FROM marco_introductions WHERE supplier_phone = $1 LIMIT 1',
      [supplierPhone]
    );
    alreadyIntroduced = introRes.rows.length > 0;
  } catch (e) {
    console.error('[notifyOwnerStockNoPrice] intro check failed:', e.message);
  }

  // Mensaje sugerido en INGLES (sin firma — ya saben quién es)
  // Primera vez: presentación completa. Despues: directo al grano.
  const intro = !alreadyIntroduced
    ? `Hi! I'm Marco, the purchasing assistant from South Traders. `
    : '';
  const askMultiple = noPriceQuotes.length > 1;
  const body = askMultiple
    ? `Could you share the prices for these items?`
    : `Could you share the price?`;
  const suggestedReply = intro + body;

  const alertMsg = [
    `🔔 Stock without price detected`,
    `From: ${supplierName} (${supplierPhone})`,
    alreadyIntroduced ? '(Marco already introduced to this supplier)' : '(First contact — message includes intro)',
    ``,
    `Items:`,
    productLines.join('\n'),
    ``,
    `Suggested reply (copy-paste to the group):`,
    `"${suggestedReply}"`
  ].join('\n');

  await alertOwner(alertMsg);

  // Marcar como presentado (INSERT ... ON CONFLICT DO NOTHING por unique constraint)
  if (!alreadyIntroduced) {
    try {
      await pool.query(
        'INSERT INTO marco_introductions (supplier_phone) VALUES ($1) ON CONFLICT (supplier_phone) DO NOTHING',
        [supplierPhone]
      );
    } catch (e) {
      console.error('[notifyOwnerStockNoPrice] insert intro failed:', e.message);
    }
  }
}

// ============ MEDIA HELPERS (WhatsApp attachments) ============
async function downloadMediaFromMeta(mediaId) {
  if (!mediaId || !WHATSAPP_TOKEN) return null;
  try {
    // 1. Obtener URL temporal del media
    const metaResp = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      timeout: 10000
    });
    const mediaUrl = metaResp.data && metaResp.data.url;
    const mime = metaResp.data && metaResp.data.mime_type || 'application/octet-stream';
    if (!mediaUrl) return null;

    // 2. Descargar el archivo
    const fileResp = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      responseType: 'arraybuffer',
      timeout: 30000
    });

    return {
      bytes: Buffer.from(fileResp.data),
      mimeType: mime,
      sizeBytes: fileResp.data.byteLength
    };
  } catch (e) {
    console.error('[downloadMediaFromMeta] error:', e.message);
    return null;
  }
}

// Procesa una imagen con Claude Vision (Sonnet). Usa el mismo formato de salida que extractQuote.
async function extractQuoteFromImage(imageBytes, mimeType, supplierName, caption) {
  if (!ANTHROPIC_API_KEY || !imageBytes) return { quotes: [] };
  // Guard owner igual que en texto
  const OWNER_NAMES = ['marcelo', 'marquitos', 'south traders'];
  const senderLower = (supplierName || '').toLowerCase();
  if (OWNER_NAMES.some(n => senderLower.includes(n))) {
    return { quotes: [], skipped_reason: 'sender_is_owner' };
  }

  const base64 = Buffer.from(imageBytes).toString('base64');
  const imageMime = (mimeType && mimeType.startsWith('image/')) ? mimeType : 'image/jpeg';

  const systemPrompt = `Eres un asistente que extrae cotizaciones de productos Apple y Samsung de IMAGENES enviadas por proveedores mayoristas (fotos de listas de precios, screenshots de Excel, capturas con precios escritos). Devuelve SOLO un JSON valido sin markdown ni backticks.

Formato requerido (igual que para mensajes de texto):
{"quotes": [{"product": "iPhone|MacBook|...", "model": "17 Pro|...", "capacity": "256GB|null", "color": "Black|null", "spec": "US|EU|IND|null", "condition": "new|used|refurbished", "price": <numero o null>, "currency": "USD|EUR|null", "qty": <numero o null>, "incoterm": "FOB|CIF|EXW|null"}]}

REGLAS:
- Si la imagen es un logo, meme, foto personal, no cotizacion: devuelve {"quotes":[]}.
- Si es una tabla con precios: extrae una quote por fila/variante. Las columnas tipicas son: modelo, color, precio, cantidad.
- PRECIO vs CANTIDAD: precios suelen estar con $/USD o ser numeros 100-5000. Cantidades son numeros pequenos (<200) junto a colores o "pcs".
- SPEC/REGION: "eu spec", "us spec", "ind spec", "hk spec" -> campo spec.
- Si no se puede leer la imagen, devuelve {"quotes":[]}.
`;

  const userText = caption ? `Caption del mensaje: "${caption}"\n\nExtrae cotizaciones de la imagen adjunta.` : 'Extrae cotizaciones de la imagen adjunta.';

  try {
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: imageMime, data: base64 } },
            { type: 'text', text: userText }
          ]
        }]
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        timeout: 45000
      }
    );
    const raw = resp.data && resp.data.content && resp.data.content[0] && resp.data.content[0].text || '{"quotes":[]}';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch(e) { parsed = { quotes: [] }; }
    if (!parsed.quotes) parsed.quotes = [];
    return parsed;
  } catch (e) {
    console.error('[extractQuoteFromImage] error:', e.message);
    return { quotes: [] };
  }
}

// Procesa un XLSX: convierte a texto tabular y usa el extractQuote normal
async function extractQuoteFromXlsx(buffer, supplierName) {
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const allText = [];
    wb.SheetNames.forEach(name => {
      const sheet = wb.Sheets[name];
      const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false, FS: ' | ' });
      if (csv && csv.trim()) {
        allText.push(`=== Hoja: ${name} ===\n${csv}`);
      }
    });
    const combined = allText.join('\n\n').slice(0, 15000); // limite sano para prompt
    if (!combined.trim()) return { quotes: [] };
    return await extractQuote(combined, supplierName);
  } catch (e) {
    console.error('[extractQuoteFromXlsx] error:', e.message);
    return { quotes: [] };
  }
}

async function extractQuote(msgText, supplierName) {
  if (!ANTHROPIC_API_KEY) return { quotes: [] };
  // GUARD: ignorar mensajes de nosotros mismos (no son cotizaciones de proveedor)
  const OWNER_NAMES = ['marcelo', 'marquitos', 'south traders'];
  const senderLower = (supplierName || '').toLowerCase();
  if (OWNER_NAMES.some(n => senderLower.includes(n))) {
    return { quotes: [], skipped_reason: 'sender_is_owner' };
  }
  try {
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: `Eres un asistente que extrae cotizaciones de productos Apple y Samsung de mensajes de proveedores mayoristas. Devuelve SOLO un JSON valido sin markdown ni backticks.

Formato requerido:
{"quotes": [{"product": "iPhone|MacBook|iPad|AirPods|Apple Watch|Samsung Galaxy|...", "model": "17 Pro|S26 Ultra|...", "capacity": "256GB|512GB|1TB|null", "color": "Black|Silver|Orange|null", "spec": "US|EU|JP|IND|HK|null", "condition": "new|used|refurbished", "price": <numero o null>, "currency": "USD|EUR|null", "qty": <numero o null>, "incoterm": "FOB|CIF|EXW|null"}]}

REGLAS CRITICAS:

1. DEVUELVE {"quotes":[]} SI:
   - Es saludo, charla social, conversacion personal (futbol, familia, hobbies, agradecimientos)
   - Es informacion logistica sin precios (envios, demoras, llegadas)
   - El mensaje es de "Marcelo", "marquitos" u otro nombre que aparente ser el dueno (cliente comprador). Solo cotizamos lo que MANDA EL PROVEEDOR.
   - No hay producto identificable

2. PRECIO vs CANTIDAD - REGLA DE ORO:
   - PRECIO: tipicamente con $, USD, EUR, o numeros entre 50 y 5000 que claramente refieran a valor monetario
   - CANTIDAD: numero entero pequeno (<200) que sigue al color o aparece junto a "unidades", "pcs", "stock", "disponible"
   - EJEMPLO CORRECTO: "Orange 59 | Blue 35 | Silver 3" -> Son CANTIDADES por color (qty=59, 35, 3), price=null. NO son precios.
   - EJEMPLO CORRECTO: "$1100" o "1100 usd" -> es PRECIO
   - SI HAY DUDA: numeros muy chicos (<10) o que siguen a un color son cantidad. Numeros con $ o entre 100-3000 sin color cercano son precio.

3. MULTI-ITEM: Un mensaje puede tener varias cotizaciones. Por ejemplo si lista varios colores con cantidades distintas pero un solo precio, generar 1 quote por color/variante manteniendo el mismo price.

4. SPEC/REGION: Si el mensaje dice "eu spec", "us spec", "ind spec", "jp spec", "arabic spec" etc., incluirlo en el campo "spec".

5. DISPONIBILIDAD SIN PRECIO: Si el proveedor solo informa stock disponible sin precio, devolver la quote con price=null. Marca importante: estas son oportunidades de pedir cotizacion.

Si NADA encaja, devuelve {"quotes":[]}.`,
        messages: [{ role: 'user', content: `Proveedor: ${supplierName}\nMensaje:\n${text}` }]
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        }
      }
    );
    const raw = resp.data.content[0].msgText.trim().replace(/^```[\w]*\n?/,"").replace(/\n?```$/,"").trim();
    return JSON.parse(raw);
  } catch (e) {
    console.error('Claude extract error:', e.message);
    return { quotes: [] };
  }
}

// ============ SAVE QUOTES TO DB ============
async function saveQuotes(quotes, supplierSlot, supplierName, rawText, source) {
  for (const q of quotes) {
    await pool.query(
      `INSERT INTO quotes (supplier_slot, supplier_name, source, raw_text, product, model, capacity, color, condition, price, currency, qty, incoterm) 
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [supplierSlot, supplierName, source || 'group', rawText, q.product, q.model, q.capacity, q.color, q.condition || 'new', q.price, q.currency || 'USD', q.qty, q.incoterm || 'FOB']
    );
  }
}

// ============ META WHATSAPP (for 1-to-1 messages via Cloud API) ============
async function sendWA(to, text) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.log('WA Cloud API not configured, skipping send to', to);
    return;
  }
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('sendWA error:', e.response?.data || e.message);
  }
}

// Alert owner
async function alertOwner(message) {
  if (!message || typeof message !== 'string' || message.trim().length === 0) return;
  // Intentar via Baileys primero (siempre disponible)
  if (baileysClient && baileysStatus === 'connected' && OWNER_PHONE) {
    try {
      const ownerJid = OWNER_PHONE + '@s.whatsapp.net';
      await baileysClient.sendMessage(ownerJid, { text: message });
      return;
    } catch (e) {
      console.error('Baileys alertOwner error:', e.message);
    }
  }
  // Fallback: Meta Cloud API
  await sendWA(OWNER_PHONE, message);
}

// ============ BAILEYS INTEGRATION (WhatsApp Web for groups) ============
let baileysClient = null;
let baileysQR = null;
let baileysStatus = 'disconnected';

async function initBaileys() {
  try {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
    const { Boom } = require('@hapi/boom');

    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
    usePairingCode: true,
      printQRInTerminal: true,
      browser: ['Marco Bot', 'Chrome', '22.0'],
        getMessage: async (key) => {
        try {
          const r = await pool.query('SELECT message_text FROM group_messages WHERE wa_message_id = $1 LIMIT 1', [key.id]);
          if (r.rows.length > 0) return { conversation: r.rows[0].message_text };
        } catch(e) {}
        return { conversation: '' };
      },
});

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        baileysQR = qr;
        baileysStatus = 'waiting_qr';
        console.log('QR code ready - scan from dashboard');
      }
      if (connection === 'close') {
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        if (reason !== DisconnectReason.loggedOut) {
          console.log('Reconnecting Baileys...');
          setTimeout(initBaileys, 5000);
        } else {
          baileysStatus = 'logged_out';
          console.log('Baileys logged out');
        }
      } else if (connection === 'open') {
        baileysStatus = 'connected';
        baileysQR = null;
        console.log('Baileys connected to WhatsApp');
      }
    });

    // Listen to ALL group messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
          if (!msg.message || msg.key.fromMe) continue;
          const remoteJid = msg.key.remoteJid || '';
          const isGroup = remoteJid.endsWith('@g.us');
          const isDM = remoteJid.endsWith('@s.whatsapp.net');
          if (!isGroup && !isDM) continue;

          const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
          if (!text || msgText.length < 3) continue;

          if (isGroup) {
            const groupId = remoteJid;
            const senderPhone = msg.key.participant?.replace('@s.whatsapp.net', '') || '';
            let groupName = groupId;
            try { const meta = await sock.groupMetadata(groupId); groupName = meta.subject || groupId; } catch(e) {}
            let senderName = senderPhone;
            try { senderName = msg.pushName || senderPhone; } catch(e) {}
            await pool.query(
              `INSERT INTO group_messages (group_id, group_name, sender_phone, sender_name, message_text, wa_message_id) VALUES ($1,$2,$3,$4,$5,$6)`,
              [groupId, groupName, senderPhone, senderName, msgText, msg.key.id]
            );
            // Buscar supplier por group_id
            const supplier = await pool.query('SELECT * FROM suppliers WHERE whatsapp_group_id = $1 AND active = TRUE', [groupId]);
            let supSlot = null, supName = groupName;
            if (supplier.rows.length > 0) { supSlot = supplier.rows[0].slot; supName = supplier.rows[0].name || supplier.rows[0].alias || groupName; }
            // Extraer quote siempre (registrado o no)
            const result = await extractQuote(msgText, supName);
            if (result.quotes && result.quotes.length > 0) {
              await pool.query(`UPDATE group_messages SET has_quote = TRUE, processed = TRUE WHERE wa_message_id = $1`, [msg.key.id]);
              await saveQuotes(result.quotes, supSlot, supName, msgText, 'group');
              try { await pool.query('UPDATE quotes SET group_id = $1 WHERE raw_text = $2 AND group_id IS NULL', [groupId, text]); } catch(e) {}
            }
          } else if (isDM) {
            const senderPhone = remoteJid.replace('@s.whatsapp.net', '');
            let senderName = msg.pushName || senderPhone;
            // Guardar tambien en group_messages con group_id=null y group_name='DM:<phone>'
            await pool.query(
              `INSERT INTO group_messages (group_id, group_name, sender_phone, sender_name, message_text, wa_message_id) VALUES ($1,$2,$3,$4,$5,$6)`,
              [null, 'DM:' + senderPhone, senderPhone, senderName, msgText, msg.key.id]
            );
            // Buscar supplier por contact_phone (flexible: comparar sufijos por si hay + o prefijos)
            const supplierRes = await pool.query(
              `SELECT * FROM suppliers WHERE active = TRUE AND contact_phone IS NOT NULL AND (regexp_replace(contact_phone, '[^0-9]', '', 'g') = $1 OR regexp_replace(contact_phone, '[^0-9]', '', 'g') LIKE '%' || $1 OR $1 LIKE '%' || regexp_replace(contact_phone, '[^0-9]', '', 'g')) LIMIT 1`,
              [senderPhone]
            );
            let supSlot = null, supName = 'DM:' + senderPhone;
            if (supplierRes.rows.length > 0) { supSlot = supplierRes.rows[0].slot; supName = supplierRes.rows[0].name || supplierRes.rows[0].alias || supName; }
            const result = await extractQuote(msgText, supName);
            if (result.quotes && result.quotes.length > 0) {
              await pool.query(`UPDATE group_messages SET has_quote = TRUE, processed = TRUE WHERE wa_message_id = $1`, [msg.key.id]);
              await saveQuotes(result.quotes, supSlot, supName, msgText, 'dm');
            }
          }
        }
      });

      baileysClient = sock;
    console.log('Baileys initialized');
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      console.log('Baileys not installed - group monitoring disabled. Install with: npm install @whiskeysockets/baileys @hapi/boom');
      baileysStatus = 'not_installed';
    } else {
      console.error('Baileys init error:', e.message);
      baileysStatus = 'error';
    }
  }
}

// ============ COSTOS (lee planilla South Pizarra columna J) ============
var COSTOS_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQJnHEwjzr2DODFe50HiG4g1ARBm8kLRFkSj2mP7pI26ymYrN-5q-M4R9S_mhapc0Ip9jQt6ZT9vREd/pub?gid=0&single=true&output=csv';
var costosCache = { map: {}, ts: 0 };
var COSTOS_TTL = 10 * 60 * 1000; // 10 min

function normalizeDesc(s) {
  if (!s) return '';
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

function parseCsvLine(line) {
  // CSV con quotes para campos que tienen comas
  var out = [];
  var cur = '';
  var inQ = false;
  for (var i = 0; i < line.length; i++) {
    var c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parsePrice(raw) {
  if (!raw) return null;
  var clean = String(raw).replace(/\$/g, '').replace(/\s/g, '').trim();
  if (!clean) return null;
  // Formato esperable: "840,00" o "840.00" o "840"
  // Si tiene coma como decimal y punto como miles, asumimos formato latam
  if (clean.indexOf(',') !== -1 && clean.indexOf('.') !== -1) {
    clean = clean.replace(/\./g, '').replace(',', '.');
  } else if (clean.indexOf(',') !== -1) {
    clean = clean.replace(',', '.');
  }
  var n = parseFloat(clean);
  return isNaN(n) ? null : n;
}

async function loadCostos(force) {
  var now = Date.now();
  if (!force && costosCache.ts && (now - costosCache.ts < COSTOS_TTL)) return costosCache;
  try {
    var resp = await axios.get(COSTOS_CSV_URL, { timeout: 15000, responseType: 'text' });
    var csv = resp.data;
    var lines = csv.split('\n');
    var map = {};
    var count = 0;
    for (var i = 0; i < lines.length; i++) {
      var cells = parseCsvLine(lines[i]);
      // Necesitamos al menos 10 columnas (A-J)
      if (cells.length < 10) continue;
      var desc = (cells[6] || cells[3] || cells[0] || '').trim(); // G, D o A: descripcion del producto
      var costo = parsePrice(cells[9]); // J
      if (!desc || !costo) continue;
      // Filtrar headers/categorias (no tienen costo numerico, suelen tener asteriscos)
      if (desc.indexOf('*') !== -1) continue;
      var key = normalizeDesc(desc);
      if (key.length < 3) continue;
      map[key] = { desc: desc, costo: costo };
      count++;
    }
    costosCache = { map: map, ts: now, count: count };
    console.log('[costos] loaded ' + count + ' rows from sheet');
    return costosCache;
  } catch(e) {
    console.error('[costos] load error:', e.message);
    return costosCache; // devuelvo lo que haya
  }
}

function findCosto(productSearchStr) {
  if (!productSearchStr || !costosCache.map) return null;
  var key = normalizeDesc(productSearchStr);
  if (!key) return null;
  // 1) Match exacto (la forma más confiable)
  if (costosCache.map[key]) return costosCache.map[key];

  // 2) Match por palabras exactas (NO substring) para evitar falsos positivos
  // Ej: "iphone 17 256gb" NO debe matchear "iphone 17e 256gb" porque "17" != "17e"
  var searchWords = key.split(' ').filter(function(w) { return w.length >= 2; });
  if (searchWords.length === 0) return null;

  var bestScore = 0;
  var best = null;
  var bestKeyLen = Infinity; // en empate, preferir la entry con MENOS palabras (más específica al match)

  for (var k in costosCache.map) {
    var entryWords = k.split(' ').filter(function(w) { return w.length >= 1; });
    // Todas las palabras del search deben existir exactas en entryWords
    var allMatch = true;
    for (var i = 0; i < searchWords.length; i++) {
      if (entryWords.indexOf(searchWords[i]) === -1) { allMatch = false; break; }
    }
    if (!allMatch) continue;

    // Score = cuántas palabras del search matchearon (siempre = searchWords.length aquí)
    // Criterio de desempate: entry con menos palabras extras = mejor match
    var score = searchWords.length;
    if (score > bestScore || (score === bestScore && entryWords.length < bestKeyLen)) {
      bestScore = score;
      bestKeyLen = entryWords.length;
      best = costosCache.map[k];
    }
  }
  return best;
}

// Refresh inicial al arrancar (no esperamos)
loadCostos().catch(function(e) { console.error('initial costos load failed:', e.message); });

// ============ ROUTES ============
// Endpoint para ver/refrescar costos
app.get('/api/costos', async (req, res) => {
  var force = req.query.refresh === '1';
  var c = await loadCostos(force);
  res.json({ count: c.count || Object.keys(c.map || {}).length, ts: c.ts, sample: Object.entries(c.map || {}).slice(0, 3) });
});


// Health
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Marco - South Traders Purchasing Bot',
    baileys: baileysStatus,
    timestamp: new Date().toISOString()
  });
});

// Dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Baileys QR code
app.get('/api/baileys/qr', (req, res) => {
  res.json({ status: baileysStatus, qr: baileysQR });
});

// Baileys QR image - devuelve PNG para escanear desde el dashboard
app.get('/api/baileys/qr-image', async (req, res) => {
  if (!baileysQR) return res.status(404).json({ error: 'No QR available', status: baileysStatus });
  try {
    const QRCode = require('qrcode');
    const png = await QRCode.toBuffer(baileysQR, { type: 'png', width: 300, margin: 2 });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(png);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Baileys status
app.post('/api/baileys/logout', async (req, res) => {
  try {
    const fs = require('fs');
    if (baileysClient) { try { await baileysClient.logout(); } catch(e) {} }
    const authDir = '/opt/render/project/src/auth_info';
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    baileysStatus = 'disconnected';
    baileysClient = null;
    res.json({ ok: true, message: 'Sesion cerrada. Llamá a /api/baileys/restart para generar QR.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/baileys/restart', async (req, res) => {
  try {
    baileysStatus = 'initializing';
    baileysClient = null;
    res.json({ ok: true, message: 'Reiniciando Baileys...' });
    setTimeout(() => initBaileys(), 500);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Estado de registro SMS
let registrationSocket = null;

app.post('/api/baileys/register', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const { makeRegistrationSocket, useMultiFileAuthState: useMultiFileAuthStateReg } = require('@whiskeysockets/baileys');
    const authDir = '/opt/render/project/src/auth_info';
    const { state, saveCreds } = await useMultiFileAuthStateReg(authDir);
    if (!code) {
      // Paso 1: Crear socket de registro y pedir SMS
      registrationSocket = makeRegistrationSocket({ auth: state });
      registrationSocket.ev.on('creds.update', saveCreds);
      await registrationSocket.requestRegistrationCode({ phoneNumber: phone, method: 'sms' });
      console.log('SMS de registro enviado a', phone);
      res.json({ ok: true, message: 'SMS enviado a +' + phone + '. Llama a este endpoint con el code recibido.' });
    } else {
      // Paso 2: Confirmar con el código SMS
      if (!registrationSocket) {
        const socket = makeRegistrationSocket({ auth: state });
        socket.ev.on('creds.update', saveCreds);
        registrationSocket = socket;
      }
      await registrationSocket.register(code.replace(/-/g, '').trim());
      console.log('Numero registrado exitosamente:', phone);
      registrationSocket = null;
      // Reiniciar Baileys normal
      setTimeout(() => initBaileys(), 1000);
      res.json({ ok: true, message: 'Numero registrado! Baileys se reconecta ahora.' });
    }
  } catch(e) {
    console.error('Register error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/baileys/pairing-code', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });
    if (!baileysClient) return res.status(503).json({ error: 'Baileys not initialized' });
    const code = await baileysClient.requestPairingCode(phone);
    console.log('Pairing code for', phone, ':', code);
    res.json({ ok: true, code, phone });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/baileys/start', async (req, res) => {
  try {
    // Borrar archivos de sesion uno por uno (no el directorio, que esta bloqueado)
    const fs = require('fs');
    const authDir = '/opt/render/project/src/auth_info';
    if (fs.existsSync(authDir)) {
      const files = fs.readdirSync(authDir);
      for (const f of files) {
        try { fs.unlinkSync(authDir + '/' + f); } catch(e) {}
      }
      console.log('Auth files deleted:', files.length);
    }
    baileysStatus = 'disconnected';
    baileysClient = null;
    setTimeout(() => initBaileys(), 500);
    res.json({ ok: true, message: 'Sesion borrada. Generando QR nuevo en 2 segundos...' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/baileys/status', (req, res) => {
  res.json({ status: baileysStatus, connected: baileysStatus === 'connected' });
});

// Baileys - list groups the phone is in
app.get('/api/baileys/groups', async (req, res) => {
  if (!baileysClient || baileysStatus !== 'connected') {
    return res.json({ error: 'Baileys not connected', groups: [] });
  }
  try {
    const groups = await baileysClient.groupFetchAllParticipating();
    const list = Object.values(groups).map(g => ({
      id: g.id,
      name: g.subject,
      participants: g.participants?.length || 0,
      creation: g.creation
    }));
    res.json({ groups: list });
  } catch (e) {
    res.json({ error: e.message, groups: [] });
  }
});

// ============ SUPPLIER MANAGEMENT ============

// List all suppliers
app.get('/api/suppliers', async (req, res) => {
  const result = await pool.query('SELECT * FROM suppliers ORDER BY slot ASC');
  res.json(result.rows);
});

// Update a supplier slot
app.put('/api/suppliers/:slot', async (req, res) => {
  const { slot } = req.params;
  const { name, alias, whatsapp_group_id, whatsapp_group_name, contact_phone, contact_name, country, notes, active } = req.body;
  try {
    await pool.query(
      `UPDATE suppliers SET
        name = COALESCE($1, name),
        alias = COALESCE($2, alias),
        whatsapp_group_id = COALESCE($3, whatsapp_group_id),
        whatsapp_group_name = COALESCE($4, whatsapp_group_name),
        contact_phone = COALESCE($5, contact_phone),
        contact_name = COALESCE($6, contact_name),
        country = COALESCE($7, country),
        notes = COALESCE($8, notes),
        active = COALESCE($9, active),
        updated_at = NOW()
      WHERE slot = $10`,
      [name, alias, whatsapp_group_id, whatsapp_group_name, contact_phone, contact_name, country, notes, active, slot]
    );
    res.json({ ok: true, slot });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Link a WhatsApp group to a supplier slot
app.post('/api/suppliers/:slot/link-group', async (req, res) => {
  const { slot } = req.params;
  const { group_id, group_name } = req.body;
  try {
    await pool.query(
      'UPDATE suppliers SET whatsapp_group_id = $1, whatsapp_group_name = $2, active = TRUE, updated_at = NOW() WHERE slot = $3',
      [group_id, group_name, slot]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ QUOTES ============

// Get all quotes, optionally filtered
app.get('/api/quotes', async (req, res) => {
  const { product, supplier, hours, limit } = req.query;
  let query = 'SELECT * FROM quotes WHERE 1=1';
  const params = [];
  let idx = 1;

  if (product) {
    query += ` AND (product ILIKE $${idx} OR model ILIKE $${idx})`;
    params.push(`%${product}%`);
    idx++;
  }
  if (supplier) {
    query += ` AND (supplier_name ILIKE $${idx})`;
    params.push(`%${supplier}%`);
    idx++;
  }
  if (hours) {
    query += ` AND ts > NOW() - INTERVAL '${parseInt(hours)} hours'`;
  }

  query += ' ORDER BY ts DESC';
  if (limit) query += ` LIMIT ${parseInt(limit)}`;

  const result = await pool.query(query, params);
  await loadCostos();
  var enriched = result.rows.map(function(row) {
    var search = [row.product, row.model, row.capacity].filter(Boolean).join(' ');
    var c = findCosto(search);
    row.ultimo_costo = c ? c.costo : null;
    return row;
  });
  res.json(enriched);
});

// Best prices summary
app.get('/api/quotes/best', async (req, res) => {
  const result = await pool.query(`
    SELECT DISTINCT ON (product, model, capacity)
      product, model, capacity, price, currency, supplier_name, supplier_slot, qty, incoterm, ts
    FROM quotes
    WHERE ts > NOW() - INTERVAL '7 days'
    ORDER BY product, model, capacity, price ASC
  `);
  await loadCostos();
  var enriched = result.rows.map(function(row) {
    var search = [row.product, row.model, row.capacity].filter(Boolean).join(' ');
    var c = findCosto(search);
    row.ultimo_costo = c ? c.costo : null;
    row.costo_match = c ? c.desc : null;
    return row;
  });
  res.json(enriched);
});

// ============ QUOTE REQUESTS ============

// Request quote from suppliers (sends via Baileys to groups)
app.post('/api/request-quote', async (req, res) => {
  try {
    const { product, target_price, supplier_slots } = req.body;
    if (!product) return res.status(400).json({ error: 'product required' });

    // Obtener proveedores activos con grupo de WA
    const suppRes = await pool.query('SELECT * FROM suppliers WHERE active = true AND (whatsapp_group_id IS NOT NULL OR contact_phone IS NOT NULL)');
    let targets = suppRes.rows;

    // Filtrar por slots si se especificaron
    if (supplier_slots && supplier_slots.length > 0) {
      const slotsNum = supplier_slots.map(s => parseInt(s));
      targets = targets.filter(s => slotsNum.includes(parseInt(s.slot)));
    }

    // Guardar registro
    const supplierNames = targets.map(s => s.name || 'Slot ' + s.slot).join(', ');
    const msg = 'Cotizacion: ' + product + (target_price ? ' | Target: $' + target_price : '') + ' | Responder con precio, cantidad e incoterm';
    await pool.query(
      'INSERT INTO quote_requests (product, target_price, suppliers_sent, message_sent, status) VALUES ($1,$2,$3,$4,$5)',
      [product, target_price || null, supplierNames || null, msg, 'open']
    );

    // Enviar WhatsApp a cada proveedor
    let sent = 0;
    for (const s of targets) {
      try {
        if (baileysClient && baileysStatus === 'connected') {
          // Intentar grupo primero, fallback a contact_phone
          let sentOk = false;
          if (s.whatsapp_group_id) {
            try {
              await baileysClient.sendMessage(s.whatsapp_group_id, { text: msg });
              sentOk = true;
              console.log('Sent to group', s.name || s.slot);
            } catch(groupErr) {
              console.log('Group send failed:', groupErr.message);
            }
          }
          if (!sentOk && s.contact_phone) {
            try {
              const phone = s.contact_phone.replace(/\D/g, '');
              await baileysClient.sendMessage(phone + '@s.whatsapp.net', { text: msg });
              sentOk = true;
              console.log('Sent direct via Baileys to', s.name || s.slot);
            } catch(dmErr) {
              console.log('Baileys DM failed:', dmErr.message);
            }
          }
          if (sentOk) sent++;
        } else if (s.contact_phone) {
          // Baileys no conectado - Cloud API al contact_phone
          try {
            const phone = s.contact_phone.replace(/\D/g, '');
            await sendWA(phone, msg);
            sent++;
            console.log('Sent via Cloud API to', s.name || s.slot);
          } catch(cloudErr) {
            console.error('Cloud API failed for', s.name || s.slot, cloudErr.message);
          }
        }
      } catch(e) {
        console.error('Error sending to', s.name || s.slot, e.message);
      }
    }
    // Notificar al owner SIEMPRE - con resultado
    const ownerMsg = sent > 0
      ? '📤 Pedido enviado a ' + sent + ' proveedor(es): ' + supplierNames + '\n' + msg
      : '📋 Pedido registrado (envío manual requerido):\n' + supplierNames + '\n' + msg;
    await alertOwner(ownerMsg);

    res.json({ ok: true, sent, suppliers: targets.map(s => s.name || 'Slot'+s.slot) });
  } catch(e) {
    console.error('request-quote error:', e);
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/quote-requests', async (req, res) => {
  const result = await pool.query('SELECT * FROM quote_requests ORDER BY ts DESC LIMIT 50');
  res.json(result.rows);
});

// ============ GROUP MESSAGES ============
app.get('/api/group-messages', async (req, res) => {
  const { group_id, hours, has_quote } = req.query;
  let query = 'SELECT * FROM group_messages WHERE 1=1';
  const params = [];
  let idx = 1;

  if (group_id) {
    query += ` AND group_id = $${idx}`;
    params.push(group_id);
    idx++;
  }
  if (hours) {
    query += ` AND ts > NOW() - INTERVAL '${parseInt(hours)} hours'`;
  }
  if (has_quote === 'true') {
    query += ' AND has_quote = TRUE';
  }

  query += ' ORDER BY ts DESC LIMIT 200';
  const result = await pool.query(query, params);
  res.json(result.rows);
});

// ============ SEND (manual message from dashboard) ============
app.post('/api/send', async (req, res) => {
  const { phone, message, group_id } = req.body;

  if (group_id && baileysClient && baileysStatus === 'connected') {
    try {
      await baileysClient.sendMessage(group_id, { text: message });
      return res.json({ ok: true, via: 'baileys_group' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (phone) {
    await sendWA(phone, message);
    return res.json({ ok: true, via: 'cloud_api' });
  }

  res.status(400).json({ error: 'phone or group_id required' });
});

// ============ REPROCESS (backfill) ============
app.post('/api/admin/reprocess-messages', async (req, res) => {
  var hours = (req.body && req.body.hours) || 72;
  var limit = (req.body && req.body.limit) || 200;
  try {
    var sql1 = "SELECT id, group_id, group_name, sender_phone, sender_name, message_text, wa_message_id FROM group_messages WHERE has_quote = FALSE AND ts > NOW() - (INTERVAL '1 hour' * $1) ORDER BY ts DESC LIMIT $2";
    var msgs = await pool.query(sql1, [hours, limit]);
    var processed = 0, extracted = 0, errors = 0;
    for (const row of msgs.rows) {
      try {
        var supSlot = null, supName = row.group_name || ('DM:' + row.sender_phone);
        var source = row.group_id ? 'group' : 'dm';
        if (row.group_id) {
          var sup = await pool.query('SELECT * FROM suppliers WHERE whatsapp_group_id = $1 LIMIT 1', [row.group_id]);
          if (sup.rows.length > 0) { supSlot = sup.rows[0].slot; supName = sup.rows[0].name || sup.rows[0].alias || supName; }
        } else if (row.sender_phone) {
          var supQ = "SELECT * FROM suppliers WHERE contact_phone IS NOT NULL AND (regexp_replace(contact_phone, '[^0-9]', '', 'g') = $1 OR regexp_replace(contact_phone, '[^0-9]', '', 'g') LIKE '%' || $1 OR $1 LIKE '%' || regexp_replace(contact_phone, '[^0-9]', '', 'g')) LIMIT 1";
          var sup2 = await pool.query(supQ, [row.sender_phone]);
          if (sup2.rows.length > 0) { supSlot = sup2.rows[0].slot; supName = sup2.rows[0].name || sup2.rows[0].alias || supName; }
        }
        var result = await extractQuote(row.message_text, supName);
        processed++;
        if (result.quotes && result.quotes.length > 0) {
          extracted += result.quotes.length;
          await pool.query('UPDATE group_messages SET has_quote = TRUE, processed = TRUE WHERE id = $1', [row.id]);
          await saveQuotes(result.quotes, supSlot, supName, row.message_text, source);
          if (row.group_id) {
            try { await pool.query('UPDATE quotes SET group_id = $1 WHERE raw_text = $2 AND group_id IS NULL', [row.group_id, row.message_text]); } catch(e) {}
          }
        } else {
          await pool.query('UPDATE group_messages SET processed = TRUE WHERE id = $1', [row.id]);
        }
      } catch(e) { errors++; console.error('reprocess error msg ' + row.id + ':', e.message); }
    }
    res.json({ ok: true, scanned: msgs.rows.length, processed, quotes_extracted: extracted, errors });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ REPROCESS (backfill) ============

// ============ MISSING QUOTES TRACKING (#12) ============
// Para cada producto de la planilla COMPRAS 2026, devuelve cuando se cotizo por ultima vez
// Query params: ?stale_days=7 (default 7). Marca stale si hace mas de N dias, never si nunca.
app.get('/api/missing-quotes', async (req, res) => {
  try {
    const staleDays = parseInt(req.query.stale_days) || 7;
    const staleMs = staleDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    // 1. Leer la planilla (loadCostos devuelve { map: {key: {desc, costo}}, ts })
    const costosCacheLocal = await loadCostos();
    const costosObj = costosCacheLocal && costosCacheLocal.map ? costosCacheLocal.map : null;
    if (!costosObj) {
      return res.status(500).json({ error: 'loadCostos().map is null/empty' });
    }

    // 2. Traer todas las quotes, calcular match con findCosto (misma logica que /api/quotes/best)
    const rows = await pool.query(`
      SELECT product, model, capacity, price, currency, supplier_name, supplier_slot, incoterm, ts
      FROM quotes
      ORDER BY ts DESC
    `);

    // Calcular costo_match para cada quote y tomar la mas reciente por match
    const lastByKey = new Map();
    for (const r of rows.rows) {
      const searchText = [r.product, r.model, r.capacity].filter(Boolean).join(' ');
      const c = findCosto(searchText);
      if (!c || !c.desc) continue;
      const key = c.desc;
      if (!lastByKey.has(key)) lastByKey.set(key, r);
    }

    // 3. Armar el resultado recorriendo la planilla
    const items = [];
    for (const [key, entry] of Object.entries(costosObj)) {
      const lastQuote = lastByKey.get(entry.desc);
      if (!lastQuote) {
        items.push({
          costo_match: key,
          desc: entry.desc,
          ultimo_costo: entry.costo,
          status: 'never',
          last_quote: null,
          days_since: null
        });
      } else {
        const daysSince = Math.floor((now - new Date(lastQuote.ts).getTime()) / (24 * 60 * 60 * 1000));
        const isStale = (now - new Date(lastQuote.ts).getTime()) > staleMs;
        items.push({
          costo_match: key,
          desc: entry.desc,
          ultimo_costo: entry.costo,
          status: isStale ? 'stale' : 'fresh',
          last_quote: {
            price: lastQuote.price,
            currency: lastQuote.currency,
            supplier_name: lastQuote.supplier_name,
            supplier_slot: lastQuote.supplier_slot,
            incoterm: lastQuote.incoterm,
            ts: lastQuote.ts
          },
          days_since: daysSince
        });
      }
    }

    // Ordenar: never primero, despues stale por dias desc, despues fresh
    items.sort((a, b) => {
      const order = { never: 0, stale: 1, fresh: 2 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      if (a.status === 'stale') return (b.days_since || 0) - (a.days_since || 0);
      return 0;
    });

    const summary = {
      never: items.filter(i => i.status === 'never').length,
      stale: items.filter(i => i.status === 'stale').length,
      fresh: items.filter(i => i.status === 'fresh').length,
      total: items.length,
      stale_threshold_days: staleDays
    };

    res.json({ ok: true, summary, items });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// ============ PARSER BASELINE ANALYSIS ============
// Mide cuantos group_messages generaron quotes (regex actual).
// NO modifica nada. Solo lee y devuelve estadisticas.
app.get('/api/admin/parser-baseline', async (req, res) => {
  try {
    // Total de group_messages
    const totalMsgs = await pool.query('SELECT COUNT(*) as n FROM group_messages');
    // Total de quotes
    const totalQuotes = await pool.query('SELECT COUNT(*) as n FROM quotes');
    // Mensajes que tienen AL MENOS UNA quote asociada
    // Asumimos que quotes.ts match con group_messages.ts (aproximado por timestamp)
    // Mas fiable: ver si hay FK o un source_message_id
    const schemaQuotes = await pool.query(`
      SELECT column_name FROM information_schema.columns WHERE table_name='quotes'
    `);
    const schemaMsgs = await pool.query(`
      SELECT column_name FROM information_schema.columns WHERE table_name='group_messages'
    `);
    // Sample de mensajes para analisis rapido
    const sampleMsgs = await pool.query(`
      SELECT id, sender_name, message_text, has_quote, processed, ts FROM group_messages
      ORDER BY ts DESC LIMIT 30
    `);
    const sampleQuotes = await pool.query(`
      SELECT id, product, model, capacity, price, supplier_name, ts FROM quotes
      ORDER BY ts DESC LIMIT 30
    `);
    // Distribucion de longitud de mensajes (heuristica: mensajes <50 chars rara vez son cotizaciones)
    const lengthDist = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE LENGTH(message_text) < 20) as tiny,
        COUNT(*) FILTER (WHERE LENGTH(message_text) BETWEEN 20 AND 100) as short,
        COUNT(*) FILTER (WHERE LENGTH(message_text) BETWEEN 100 AND 500) as medium,
        COUNT(*) FILTER (WHERE LENGTH(message_text) >= 500) as long
      FROM group_messages
    `);
    res.json({
      total_messages: parseInt(totalMsgs.rows[0].n),
      total_quotes: parseInt(totalQuotes.rows[0].n),
      messages_schema: schemaMsgs.rows.map(r => r.column_name),
      quotes_schema: schemaQuotes.rows.map(r => r.column_name),
      length_distribution: lengthDist.rows[0],
      sample_messages: sampleMsgs.rows.map(m => ({
        id: m.id,
        sender: m.sender_name,
        ts: m.ts,
        text_preview: m.message_text ? m.message_text.slice(0, 200) : null,
        text_len: m.message_text ? m.message_text.length : 0,
        has_quote: m.has_quote,
        processed: m.processed
      })),
      sample_quotes: sampleQuotes.rows
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// ============ AI RE-PARSER (analiza mensajes que pudieron perderse) ============
// GET /api/admin/reparse-missed?limit=N&category=unprocessed|noquote|all
// NO escribe a DB. Devuelve diff entre lo que tiene la DB y lo que la IA detecta ahora.
app.get('/api/admin/reparse-missed', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const category = req.query.category || 'noquote';

    let where;
    if (category === 'unprocessed') {
      where = `WHERE processed = false`;
    } else if (category === 'noquote') {
      // mensajes que Claude vio y no extrajo nada, pero longitud sugerente
      where = `WHERE has_quote = false AND processed = true AND LENGTH(message_text) >= 40`;
    } else if (category === 'all') {
      where = `WHERE LENGTH(message_text) >= 30`;
    } else {
      return res.status(400).json({ error: 'category must be unprocessed|noquote|all' });
    }

    const msgs = await pool.query(`
      SELECT id, sender_name, group_name, message_text, has_quote, processed, ts
      FROM group_messages
      ${where}
      ORDER BY ts DESC
      LIMIT $1
    `.replace('${where}', where), [limit]);

    const results = [];
    let aiQuotesFound = 0;
    let aiCallsMade = 0;
    let errors = 0;

    for (const msg of msgs.rows) {
      try {
        aiCallsMade++;
        const supplierName = msg.sender_name || msg.group_name || 'unknown';
        const aiResult = await extractQuote(msg.message_text, supplierName);
        const aiQuotes = (aiResult && aiResult.quotes) || [];
        aiQuotesFound += aiQuotes.length;
        results.push({
          msg_id: msg.id,
          sender: msg.sender_name,
          group: msg.group_name,
          msg_len: msg.message_text.length,
          msg_preview: msg.message_text.slice(0, 200),
          db_has_quote: msg.has_quote,
          db_processed: msg.processed,
          ai_quote_count: aiQuotes.length,
          ai_quotes: aiQuotes
        });
      } catch (msgErr) {
        errors++;
        results.push({ msg_id: msg.id, error: msgErr.message });
      }
    }

    const summary = {
      category,
      messages_analyzed: msgs.rows.length,
      ai_calls_made: aiCallsMade,
      ai_errors: errors,
      total_new_quotes_detected: aiQuotesFound,
      messages_with_new_quotes: results.filter(r => r.ai_quote_count > 0).length,
      potential_recovery_rate: aiCallsMade > 0 ? (results.filter(r => r.ai_quote_count > 0).length / aiCallsMade * 100).toFixed(1) + '%' : 'N/A'
    };

    res.json({ ok: true, summary, results });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// ============ RECENT MESSAGES (debug — incluye media cols) ============
app.get('/api/admin/recent-messages', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const onlyMedia = req.query.media === 'true';
    const where = onlyMedia ? 'WHERE media_type IS NOT NULL' : '';
    const rows = await pool.query(`
      SELECT id, group_name, sender_phone, sender_name, message_text,
             media_type, media_id, media_caption, media_filename, media_mime,
             wa_message_id, has_quote, processed, ts
      FROM group_messages
      ${where}
      ORDER BY ts DESC
      LIMIT $1
    `.replace('${where}', where), [limit]);
    const items = rows.rows.map(m => ({
      id: m.id,
      ts: m.ts,
      sender_phone: m.sender_phone,
      sender_name: m.sender_name || '(null)',
      group_name: m.group_name || '(null)',
      preview: m.message_text ? m.message_text.slice(0, 150) : null,
      media_type: m.media_type,
      media_id: m.media_id,
      media_filename: m.media_filename,
      media_caption: m.media_caption,
      wa_message_id: m.wa_message_id,
      has_quote: m.has_quote,
      processed: m.processed
    }));
    res.json({ ok: true, count: items.length, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// [DEV ONLY] Seed marco-dev DB from marco-prod DB. Single-use, safe for dev.
// Requires PROD_DATABASE_URL env var. Protected with BAILEYS_DISABLED=true as indicator this is dev.
app.post('/api/admin/seed-from-prod', async (req, res) => {
  if (process.env.BAILEYS_DISABLED !== 'true') {
    return res.status(403).json({ error: 'This endpoint only runs on dev (BAILEYS_DISABLED=true)' });
  }
  if (!process.env.PROD_DATABASE_URL) {
    return res.status(500).json({ error: 'PROD_DATABASE_URL env var not set' });
  }
  const { Pool: PgPool } = require('pg');
  const prodPool = new PgPool({ connectionString: process.env.PROD_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const tables = ['suppliers', 'quotes', 'group_messages', 'minimum_stock'];
  const result = {};
  try {
    for (const table of tables) {
      try {
        const prodRows = await prodPool.query(`SELECT * FROM ${table}`);
        result[table] = { prod_count: prodRows.rows.length };
        if (prodRows.rows.length === 0) { result[table].inserted = 0; continue; }
        // Obtener columnas disponibles en dev
        const devCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [table]);
        const devColNames = devCols.rows.map(r => r.column_name);
        // Truncate dev table (excepto suppliers para conservar los 50 slots placeholder)
        if (table !== 'suppliers') {
          await pool.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
        }
        let inserted = 0;
        for (const row of prodRows.rows) {
          // Filtrar solo columnas que existen en dev
          const keys = Object.keys(row).filter(k => devColNames.includes(k));
          if (keys.length === 0) continue;
          const values = keys.map(k => row[k]);
          const placeholders = keys.map((_, i) => `$${i+1}`).join(',');
          if (table === 'suppliers') {
            // UPSERT por slot
            const updateSet = keys.filter(k => k !== 'slot' && k !== 'id').map((k,i) => `${k}=EXCLUDED.${k}`).join(',');
            await pool.query(`INSERT INTO suppliers (${keys.join(',')}) VALUES (${placeholders}) ON CONFLICT (slot) DO UPDATE SET ${updateSet}`, values);
          } else {
            await pool.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${placeholders})`, values);
          }
          inserted++;
        }
        result[table].inserted = inserted;
      } catch(tableErr) {
        result[table] = { error: tableErr.message };
      }
    }
    await prodPool.end();
    res.json({ ok: true, result });
  } catch(e) {
    try { await prodPool.end(); } catch(_){}
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

app.post('/api/admin/reprocess-messages', async (req, res) => {
  var hours = (req.body && req.body.hours) || 72;
  var limit = (req.body && req.body.limit) || 200;
  try {
    var sql1 = "SELECT id, group_id, group_name, sender_phone, sender_name, message_text, wa_message_id FROM group_messages WHERE has_quote = FALSE AND ts > NOW() - (INTERVAL '1 hour' * $1) ORDER BY ts DESC LIMIT $2";
    var msgs = await pool.query(sql1, [hours, limit]);
    var processed = 0, extracted = 0, errors = 0;
    for (const row of msgs.rows) {
      try {
        var supSlot = null, supName = row.group_name || ('DM:' + row.sender_phone);
        var source = row.group_id ? 'group' : 'dm';
        if (row.group_id) {
          var sup = await pool.query('SELECT * FROM suppliers WHERE whatsapp_group_id = $1 LIMIT 1', [row.group_id]);
          if (sup.rows.length > 0) { supSlot = sup.rows[0].slot; supName = sup.rows[0].name || sup.rows[0].alias || supName; }
        } else if (row.sender_phone) {
          var supQ = "SELECT * FROM suppliers WHERE contact_phone IS NOT NULL AND (regexp_replace(contact_phone, '[^0-9]', '', 'g') = $1 OR regexp_replace(contact_phone, '[^0-9]', '', 'g') LIKE '%' || $1 OR $1 LIKE '%' || regexp_replace(contact_phone, '[^0-9]', '', 'g')) LIMIT 1";
          var sup2 = await pool.query(supQ, [row.sender_phone]);
          if (sup2.rows.length > 0) { supSlot = sup2.rows[0].slot; supName = sup2.rows[0].name || sup2.rows[0].alias || supName; }
        }
        var result = await extractQuote(row.message_text, supName);
        processed++;
        if (result.quotes && result.quotes.length > 0) {
          extracted += result.quotes.length;
          await pool.query('UPDATE group_messages SET has_quote = TRUE, processed = TRUE WHERE id = $1', [row.id]);
          await saveQuotes(result.quotes, supSlot, supName, row.message_text, source);
          if (row.group_id) {
            try { await pool.query('UPDATE quotes SET group_id = $1 WHERE raw_text = $2 AND group_id IS NULL', [row.group_id, row.message_text]); } catch(e) {}
          }
        } else {
          await pool.query('UPDATE group_messages SET processed = TRUE WHERE id = $1', [row.id]);
        }
      } catch(e) { errors++; console.error('reprocess error msg ' + row.id + ':', e.message); }
    }
    res.json({ ok: true, scanned: msgs.rows.length, processed: processed, quotes_extracted: extracted, errors: errors });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ DEBUG ============
app.post('/api/debug/send-raw', async (req, res) => {
  var { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone+message required' });
  try {
    var resp = await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: message } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    res.json({ ok: true, meta_status: resp.status, meta_response: resp.data });
  } catch(e) {
    res.json({ ok: false, meta_status: e.response?.status, meta_error: e.response?.data, message: e.message });
  }
});

// ============ WEBHOOK (Meta Cloud API) ============
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    if (!change?.messages) return;

    for (const msg of change.messages) {
      // Manejar distintos tipos de mensaje: text, image, document (xlsx), ignorar audio/video
      let msgText = null;
      let mediaType = null;
      let mediaId = null;
      let mediaCaption = null;
      let mediaFilename = null;
      if (msg.type === 'text') {
        msgText = msg.text && msg.text.body;
      } else if (msg.type === 'image') {
        mediaType = 'image';
        mediaId = msg.image && msg.image.id;
        mediaCaption = msg.image && msg.image.caption;
        msgText = mediaCaption || '[IMAGEN]';
      } else if (msg.type === 'document') {
        mediaType = 'document';
        mediaId = msg.document && msg.document.id;
        mediaFilename = msg.document && msg.document.filename;
        mediaCaption = msg.document && msg.document.caption;
        msgText = mediaCaption || ('[DOC:' + (mediaFilename || 'file') + ']');
      } else {
        continue; // ignoramos audio, video, sticker, location por ahora
      }
      const from = msg.from;

      // Persistir el mensaje entrante en group_messages (incluyendo media)
      // processed=false inicialmente, lo marcamos true despues de intentar parser
      try {
        await pool.query(
          `INSERT INTO group_messages (group_id, group_name, sender_phone, sender_name, message_text, media_type, media_id, media_caption, media_filename, wa_message_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [null, null, from, null, msgText, mediaType, mediaId, mediaCaption, mediaFilename, msg.id || null]
        );
      } catch (dbErr) {
        console.error('[webhook] insert group_messages failed:', dbErr.message);
      }
      // (text proviene del switch anterior como msgText)

      // Check if this is from a known supplier
      const supplier = await pool.query(
        'SELECT * FROM suppliers WHERE contact_phone = $1 AND active = TRUE',
        [from]
      );

      if (supplier.rows.length > 0) {
        const s = supplier.rows[0];
        // Decidir parser segun tipo de mensaje: texto, imagen (vision) o xlsx
        const supplierNameForAi = s.name || s.alias;
        let result = { quotes: [] };
        if (mediaType === 'image' && mediaId) {
          const media = await downloadMediaFromMeta(mediaId);
          if (media && media.bytes) {
            result = await extractQuoteFromImage(media.bytes, media.mimeType, supplierNameForAi, mediaCaption);
          }
        } else if (mediaType === 'document' && mediaId) {
          const media = await downloadMediaFromMeta(mediaId);
          if (media && media.bytes) {
            const fname = (mediaFilename || '').toLowerCase();
            const isXlsx = fname.endsWith('.xlsx') || fname.endsWith('.xls') || (media.mimeType || '').includes('spreadsheet');
            if (isXlsx) {
              result = await extractQuoteFromXlsx(media.bytes, supplierNameForAi);
            } else {
              // Por ahora, otros documentos (pdf, etc.) no se procesan
              result = { quotes: [] };
            }
          }
        } else {
          // texto normal
          result = await extractQuote(msgText, supplierNameForAi);
        }
        if (result.quotes && result.quotes.length > 0) {
          await saveQuotes(result.quotes, s.slot, s.name || s.alias, msgText, 'direct');
          // Nivel 2: si hay quotes SIN precio, alertar al owner para pedir precio
          try {
            await notifyOwnerStockNoPrice(result.quotes, {
              supplierPhone: from,
              supplierName: s.name || s.alias
            });
          } catch (e) {
            console.error('[notifyOwnerStockNoPrice] failed:', e.message);
          }
          const summary = result.quotes.map(q =>
            `${q.product} ${q.model} ${q.capacity}: $${q.price} x${q.qty || '?'}`
          ).join('\n');
          await alertOwner(`📊 Cotización directa de ${s.name}:\n${summary}`);
        }
      }
    }
  } catch (e) {
    console.error('Webhook error:', e.message);
  }
});

// ============ STOCK & COMPRAS ============

// Stock desde Northtraders
app.get('/api/stock', async (req, res) => {
  try {
    const { JSDOM } = require('jsdom');
    const resp = await axios.get('https://northtraders.oppen.io/report/shared?shared=fe0f1305-3a71-4b78-be99-e54e3396cbdd', { timeout: 15000 });
    const dom = new JSDOM(resp.data);
    const rows = dom.window.document.querySelectorAll('table tr');
    const items = [];
    for (let i = 2; i < rows.length; i++) {
      const cells = rows[i].querySelectorAll('td');
      if (cells.length >= 3) {
        const codigo = cells[0].textContent.trim();
        const desc = cells[1].textContent.trim();
        const stock = parseFloat(cells[2].textContent.trim().replace(',', '.')) || 0;
        const transito = parseFloat(cells[3] ? cells[3].textContent.trim().replace(',', '.') : '0') || 0;
        if (codigo) items.push({ codigo, desc, stock, transito });
      }
    }
    res.json({ ok: true, items, updated: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// CRUD purchase_minimums
app.get('/api/purchase-minimums', async (req, res) => {
  const result = await pool.query('SELECT * FROM purchase_minimums ORDER BY descripcion ASC');
  res.json(result.rows);
});

app.post('/api/purchase-minimums', async (req, res) => {
  const { codigo, descripcion, minimo } = req.body;
  try {
    await pool.query(
      'INSERT INTO purchase_minimums (codigo, descripcion, minimo) VALUES ($1,$2,$3) ON CONFLICT (codigo) DO UPDATE SET descripcion=$2, minimo=$3, updated_at=NOW()',
      [codigo, descripcion, minimo]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/purchase-minimums/:id', async (req, res) => {
  await pool.query('DELETE FROM purchase_minimums WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Compras: stock vs minimos + mejor precio
app.get('/api/compras', async (req, res) => {
  try {
    const { JSDOM } = require('jsdom');
    // Obtener stock
    const stockResp = await axios.get('https://northtraders.oppen.io/report/shared?shared=fe0f1305-3a71-4b78-be99-e54e3396cbdd', { timeout: 15000 });
    const dom = new JSDOM(stockResp.data);
    const rows = dom.window.document.querySelectorAll('table tr');
    const stockMap = {};
    for (let i = 2; i < rows.length; i++) {
      const cells = rows[i].querySelectorAll('td');
      if (cells.length >= 3) {
        const codigo = cells[0].textContent.trim();
        const desc = cells[1].textContent.trim();
        const stock = parseFloat(cells[2].textContent.trim().replace(',', '.')) || 0;
        const transito = parseFloat(cells[3] ? cells[3].textContent.trim().replace(',', '.') : '0') || 0;
        if (codigo) stockMap[codigo] = { desc, stock, transito };
      }
    }
    // Obtener minimos
    const minimoRes = await pool.query('SELECT * FROM purchase_minimums');
    const minimos = minimoRes.rows;
    // Para cada minimo, comparar con stock y buscar mejor precio
    const compras = [];
    for (const m of minimos) {
      const stockItem = stockMap[m.codigo] || { desc: m.descripcion, stock: 0, transito: 0 };
      const stockTotal = stockItem.stock + stockItem.transito;
      const falta = Math.max(0, m.minimo - stockTotal);
      // Buscar mejor cotizacion en ultimos 7 dias por descripcion fuzzy
      const desc = m.descripcion || '';
      const parts = desc.replace(/APPLEs+/i,'').replace(/s+-s+.*/, '').trim().split(/s+/);
      const searchTerm = parts.slice(0,4).join(' ');
      let bestQuote = null;
      if (searchTerm) {
        const qResult = await pool.query(
          `SELECT supplier_name, price, currency, incoterm, qty, ts FROM quotes WHERE (product || ' ' || COALESCE(model,'') || ' ' || COALESCE(capacity,'')) ILIKE $1 AND ts > NOW() - INTERVAL '7 days' ORDER BY price ASC LIMIT 1`,
          ['%' + searchTerm.split(' ').slice(0,2).join('%') + '%']
        );
        if (qResult.rows.length > 0) bestQuote = qResult.rows[0];
      }
      compras.push({
        id: m.id,
        codigo: m.codigo,
        descripcion: m.descripcion || stockItem.desc,
        stock: stockItem.stock,
        transito: stockItem.transito,
        stock_total: stockTotal,
        minimo: m.minimo,
        falta,
        alerta: falta > 0,
        mejor_precio: bestQuote
      });
    }
    // Ordenar: alertas primero
    // Enriquecer con ultimo costo de la planilla
      await loadCostos();
      compras.forEach(function(c) {
        var search = c.descripcion || '';
        var costo = findCosto(search);
        c.ultimo_costo = costo ? costo.costo : null;
      });
      compras.sort((a,b) => (b.alerta ? 1 : 0) - (a.alerta ? 1 : 0));
    res.json(compras);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ START ============
async function start() {
  await initDB();
  app.listen(PORT, () => console.log(`Marco purchasing bot on port ${PORT}`));

  // Try to start Baileys (won't crash if not installed)
  if (process.env.BAILEYS_DISABLED === 'true') {
    console.log('[BAILEYS] Disabled via BAILEYS_DISABLED env var — skipping init');
  } else {
    await initBaileys();
  }
}

start().catch(e => console.error('Start error:', e));
