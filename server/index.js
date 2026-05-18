// Daycation Agent v2.0 — NLP-Powered WhatsApp Booking Bot
// Added: date parsing, guest extraction, email extraction, CS handoff, URL pre-fill

require("dotenv").config();
const express = require("express");
const fs = require("fs-extra");
const path = require("path");
const Fuse = require("fuse.js");
const chrono = require("chrono-node");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ---------- LOAD TOURS ---------- */
const toursFile = path.join(__dirname, "..", "src", "data", "tours.json");
let TOURS = [];
if (fs.existsSync(toursFile)) {
  TOURS = JSON.parse(fs.readFileSync(toursFile, "utf8"));
}
const fuse = new Fuse(TOURS, {
  keys: ["ACTIVITIES"],
  threshold: 0.35,
  minMatchCharLength: 3
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
  const lower = text.toLowerCase();
  for (const kw of ACTIVITY_KEYWORDS) {
    if (lower.includes(kw)) return kw;
  }
  const words = lower.split(/\W+/).filter(w => w.length > 2);
  for (const w of words) {
    const match = ACTIVITY_KEYWORDS.find(k => k.includes(w));
    if (match) return match;
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
  const parsed = chrono.parse(text);
  if (parsed.length > 0) {
    const date = parsed[0].start.date();
    return date.toISOString().split('T')[0];
  }
  return null;
}

function extractTime(text) {
  const parsed = chrono.parse(text);
  if (parsed.length > 0 && parsed[0].start.isCertain('hour')) {
    const hour = parsed[0].start.get('hour');
    const minute = parsed[0].start.get('minute') || 0;
    return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
  }
  return null;
}

/* ---------- URL BUILDER ---------- */
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
const WELCOME = `🌴 Welcome to Daycation Tours!
Discover amazing UAE experiences instantly.

Just tell me what you want:
• "desert safari tomorrow 3 pax"
• "dhow cruise next weekend 2 people"
• "burj khalifa today hamza@email.com"

Or send "0" for this menu.`;

const RESULTS_TPL = (count, keyword, date, guests, tours) => {
  let header = `✅ Found ${count} tours for "${keyword}"`;
  if (date) header += ` on ${date}`;
  if (guests) header += ` for ${guests} guests`;
  header += `:\n\n`;
  return header + tours + `\n\n🔄 Want more? Send another activity or "0" for menu.`;
};

const NO_RESULTS_TPL = `❌ No tours found. Try: "desert safari", "dhow cruise", "burj khalifa"
Or our team will contact you soon.`;

const CS_HANDOFF_TPL = `👋 Connecting you to a human agent...
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

/* ---------- WEBHOOK ---------- */
app.post("/webhook", async (req, res) => {
  const from = req.body?.From || "unknown";
  const body = (req.body?.Body || "").trim();
  const ts = new Date().toISOString();
  
  let reply = "";
  let answered = false;
  let reason = "OK";

  const activity = extractActivity(body);
  const guests = extractGuests(body);
  const email = extractEmail(body);
  const date = extractDate(body);
  const time = extractTime(body);
  const isCS = CS_KEYWORDS.some(kw => body.toLowerCase().includes(kw));

  const leadData = { ts, from, body, activity, guests, email, date, time, isCS };

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
          const url = buildPrefilledUrl(r.item.URL, date, time, guests, email);
          return `🎯 ${r.item.ACTIVITIES}\n🔗 ${url}`;
        }).join("\n\n");
        
        reply = RESULTS_TPL(results.length, activity, date, guests, tourList);
        answered = true;
        reason = "matched";
        await saveLead({ ...leadData, type: "booking_inquiry", tours: results.map(r => r.item.ACTIVITIES) });
      }
    }
  } catch (err) {
    reply = "⚠️ Sorry, something went wrong. Please try again.";
    reason = "exception";
    console.error("Error:", err.message);
  }

  auditLog.unshift({
    ts, from, body: body.substring(0, 100),
    answered, reason,
    entities: { activity, guests, email, date, time },
    reply: reply.substring(0, 200)
  });
  
  if (auditLog.length > 100) auditLog.pop();
  await saveAudit();

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
<Message>${reply.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Message>
</Response>`;

  res.type("text/xml").send(twiml);
});

/* ---------- ENDPOINTS ---------- */
app.get("/health", (_req, res) => res.json({
  status: "ok",
  version: "2.0",
  tours: TOURS.length,
  uptime: process.uptime()
}));

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

/* ---------- START ---------- */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Daycation Agent v2.0 running on port ${PORT}`);
  console.log(`📊 Loaded ${TOURS.length} tours`);
  console.log(`🔗 Webhook: http://localhost:${PORT}/webhook`);
  console.log(`📈 Health: http://localhost:${PORT}/health`);
  console.log(`📋 Audit: http://localhost:${PORT}/audit`);
});
