// Daycation Agent v2.1.2 — XSS Fix + Full NLP Pipeline + Webhook Verification
// Fixed: fuzzy search, date parsing, XML sanitization, input sanitization, HTML blocking, webhook GET handler

require("dotenv").config();
const express = require("express");
const fs = require("fs-extra");
const path = require("path");
const Fuse = require("fuse.js");
const chrono = require("chrono-node");
const morgan = require("morgan");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(morgan("combined"));

/* ---------- LOAD TOURS ---------- */
const toursFile = path.join(__dirname, "..", "src", "data", "tours.json");
let TOURS = [];
try {
  if (fs.existsSync(toursFile)) {
    TOURS = JSON.parse(fs.readFileSync(toursFile, "utf8"));
    console.log(`Loaded ${TOURS.length} tours`);
  }
} catch (err) {
  console.error("Error loading tours:", err.message);
}

const fuse = new Fuse(TOURS, {
  keys: ["ACTIVITIES"],
  threshold: 0.5,
  minMatchCharLength: 2
});

/* ---------- KEYWORDS ---------- */
const ACTIVITY_KEYWORDS = [
  "desert safari", "dhow cruise", "quad bike", "skydiving", "city tour",
  "museum", "beach", "mountain", "burj khalifa", "abu dhabi", "ferrari world",
  "yacht", "snorkeling", "dubai frame", "global village", "miracle garden",
  "hot air balloon", "sandboarding", "camel ride", "henna", "bbq dinner",
  "aquaventure", "atlantis", "burj al arab", "dubai opera", "img worlds",
  "legoland", "motiongate", "wild wadi", "ski dubai", "dubai mall"
];

const CS_KEYWORDS = ["agent", "human", "support", "help", "representative", "call", "talk"];

/* ---------- ENTITY EXTRACTION ---------- */
function extractActivity(text) {
  // Block HTML/script tags
  if (text.includes('<') || text.includes('>') || text.includes('/')) {
    return null;
  }
  
  const lower = text.toLowerCase();
  
  // Exact match first
  for (const kw of ACTIVITY_KEYWORDS) {
    if (lower.includes(kw)) return kw;
  }
  
  // Fuzzy match with Fuse.js
  const results = fuse.search(text);
  if (results.length > 0) {
    return results[0].item.ACTIVITIES;
  }
  
  // Word-by-word fuzzy fallback
  const words = lower.split(/\W+/).filter(w => w.length > 2);
  for (const word of words) {
    const wordResults = fuse.search(word);
    if (wordResults.length > 0) {
      return wordResults[0].item.ACTIVITIES;
    }
  }
  
  return null;
}

function extractGuests(text) {
  const patterns = [
    /(\d+)\s*(pax|people|guests|persons|adults|kids|children|travelers)/i,
    /(\d+)\s*(person|guest|adult|kid|child)/i,
    /for\s+(\d+)/i,
    /group\s+of\s+(\d+)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return parseInt(match[1]);
  }
  return null;
}

function extractEmail(text) {
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

function extractDate(text) {
  const lower = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const today = new Date();
  
  // Manual typo-tolerant checks
  if (lower.includes('tomorrow') || lower.includes('tomrrow') || lower.includes('tomoro')) {
    const t = new Date(today);
    t.setDate(t.getDate() + 1);
    return t.toISOString().split('T')[0];
  }
  if (lower.includes('today')) {
    return today.toISOString().split('T')[0];
  }
  if (lower.includes('next week')) {
    const t = new Date(today);
    t.setDate(t.getDate() + 7);
    return t.toISOString().split('T')[0];
  }
  
  // chrono-node for complex dates
  const parsed = chrono.parse(text);
  if (parsed.length > 0) {
    const date = parsed[0].start.date();
    return date.toISOString().split('T')[0];
  }
  
  return null;
}

function sanitizeInput(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/[\x00-\x1F\x7F]/g, '').substring(0, 500);
}

function sanitizeForXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPrefilledUrl(baseUrl, date, time, guests, email) {
  const params = new URLSearchParams();
  if (date) params.append('date', date);
  if (time) params.append('time', time);
  if (guests) params.append('guests', guests);
  if (email) params.append('email', email);
  const query = params.toString();
  return query ? `${baseUrl}?${query}` : baseUrl;
}

/* ---------- TEMPLATES ---------- */
const WELCOME = `Welcome to Daycation Tours!
Discover amazing UAE experiences instantly.

Just tell me what you want:
- "desert safari tomorrow 3 pax"
- "dhow cruise next weekend 2 people"
- "burj khalifa today hamza@email.com"

Or send "0" for this menu.`;

const RESULTS_TPL = (count, keyword, date, guests, tours) => {
  let header = `Found ${count} tours for "${keyword}"`;
  if (date) header += ` on ${date}`;
  if (guests) header += ` for ${guests} guests`;
  header += `:\n\n`;
  return header + tours + `\n\nWant more? Send another activity or "0" for menu.`;
};

const NO_RESULTS_TPL = `No tours found. Try: "desert safari", "dhow cruise", "burj khalifa"
Or our team will contact you soon.`;

const CS_HANDOFF_TPL = `Connecting you to a human agent...
Expected response time: under 5 minutes.

Meanwhile, visit: www.daycationtour.com`;

/* ---------- AUDIT & STORAGE ---------- */
const auditLog = [];
const AUDIT_FILE = path.join(__dirname, "..", "storage", "audit.json");

async function saveAudit() {
  try {
    await fs.ensureDir(path.dirname(AUDIT_FILE));
    await fs.writeJson(AUDIT_FILE, auditLog.slice(0, 100), { spaces: 2 });
  } catch (err) {
    console.error("Audit save error:", err.message);
  }
}

async function saveLead(leadData) {
  try {
    const leadsDir = path.join(__dirname, "..", "storage", "leads");
    await fs.ensureDir(leadsDir);
    const filename = `lead_${Date.now()}.json`;
    await fs.writeJson(path.join(leadsDir, filename), leadData, { spaces: 2 });
  } catch (err) {
    console.error("Lead save error:", err.message);
  }
}

/* ============================================
   WHATSAPP WEBHOOK VERIFICATION (GET)
   Meta sends this when you first set up the webhook
   ============================================ */
app.get("/webhook", (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('🔍 Webhook verification attempt:', { mode, token: token ? '***' : 'missing', challenge });

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('✅ Webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Webhook verification failed');
    res.sendStatus(403);
  }
});

/* ---------- WEBHOOK (POST) ---------- */
app.post("/webhook", async (req, res) => {
  const rawFrom = req.body?.From || "unknown";
  const rawBody = (req.body?.Body || "").trim();
  const ts = new Date().toISOString();
  
  const from = sanitizeInput(rawFrom);
  const body = sanitizeInput(rawBody);
  
  let reply = "";
  let answered = false;
  let reason = "OK";

  const activity = extractActivity(body);
  const guests = extractGuests(body);
  const email = extractEmail(body);
  const date = extractDate(body);
  const isCS = CS_KEYWORDS.some(kw => body.toLowerCase().includes(kw));

  const leadData = { ts, from, body, activity, guests, email, date, isCS };

  try {
    if (body.toLowerCase() === "0") {
      reply = WELCOME;
      answered = true;
      reason = "menu";
    } else if (isCS) {
      reply = CS_HANDOFF_TPL;
      answered = true;
      reason = "cs-handoff";
      await saveLead({ ...leadData, type: "cs_request" });
    } else if (!activity) {
      reply = NO_RESULTS_TPL;
      reason = "no-activity";
    } else {
      const results = fuse.search(activity).slice(0, 3);
      
      if (results.length === 0) {
        reply = NO_RESULTS_TPL;
        reason = "no-match";
      } else {
        const tourList = results.map(r => {
          const url = buildPrefilledUrl(r.item.URL, date, null, guests, email);
          return `${r.item.ACTIVITIES}\n${url}`;
        }).join("\n\n");
        
        reply = RESULTS_TPL(results.length, activity, date, guests, tourList);
        answered = true;
        reason = "matched";
        await saveLead({ ...leadData, type: "booking_inquiry", tours: results.map(r => r.item.ACTIVITIES) });
      }
    }
  } catch (err) {
    console.error("Webhook error:", err.message);
    reply = "Sorry, something went wrong. Please try again.";
    reason = "exception";
  }

  auditLog.unshift({
    ts, from, body: body.substring(0, 100),
    answered, reason,
    entities: { activity, guests, email, date },
    reply: reply.substring(0, 200)
  });
  
  if (auditLog.length > 100) auditLog.pop();
  await saveAudit();

  const safeReply = sanitizeForXml(reply);
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
<Message>${safeReply}</Message>
</Response>`;

  res.type("text/xml").send(twiml);
});

/* ---------- ENDPOINTS ---------- */
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version: "2.1.2",
    tours: TOURS.length,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

app.get("/audit", async (_req, res) => {
  try {
    const data = await fs.readJson(AUDIT_FILE);
    res.json({ totalMessages: data.length, messages: data.slice(0, 50) });
  } catch {
    res.json({ totalMessages: auditLog.length, messages: auditLog.slice(0, 50) });
  }
});

app.get("/leads", async (_req, res) => {
  try {
    const leadsDir = path.join(__dirname, "..", "storage", "leads");
    const files = await fs.readdir(leadsDir);
    const leads = await Promise.all(
      files.slice(-20).map(f => fs.readJson(path.join(leadsDir, f)))
    );
    res.json({ total: files.length, leads });
  } catch {
    res.json({ total: 0, leads: [] });
  }
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Daycation Agent v2.1.2 running on port ${PORT}`);
  console.log(`Loaded ${TOURS.length} tours`);
});