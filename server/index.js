// Daycation Tours – WhatsApp Bot – WITH AUDIT
require("dotenv").config();
const express = require("express");
const fs = require("fs-extra");
const path = require("path");
const Fuse = require("fuse.js");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ---------- LOAD TOURS ---------- */
const toursFile = path.join(__dirname, "..", "src", "data", "tours.json");
let TOURS = [];
if (fs.existsSync(toursFile)) TOURS = JSON.parse(fs.readFileSync(toursFile, "utf8"));
const fuse = new Fuse(TOURS, { keys: ["ACTIVITIES"], threshold: 0.35, minMatchCharLength: 3 });

/* ---------- KEYWORD EXTRACTOR ---------- */
const KEYWORDS = [
  "desert safari","dhow cruise","quad bike","skydiving","city tour",
  "museum","beach","mountain","burj khalifa","abu dhabi","ferrari world",
  "yacht","snorkeling","dubai frame","global village","miracle garden",
  "hot air balloon","sandboarding","camel ride","henna","bbq dinner"
];
function extractKeyword(text) {
  const lower = text.toLowerCase();
  for (const kw of KEYWORDS) if (lower.includes(kw)) return kw;
  const words = lower.split(/\W+/);
  for (const w of words) if (KEYWORDS.some(k => k.includes(w))) return w;
  return text;
}

/* ---------- TEMPLATES ---------- */
const WELCOME = `🌴 Welcome to Daycation Tours – Never Ending Memories!
🇦🇪 Discover amazing UAE experiences instantly!
Just send any activity you're interested in:
- Desert Safari 🏜️
- Dhow Cruise ⛵
- City Tour 🏙️
- Skydiving 🪂
- Dubai Frame 🖼️
- Ferrari World 🏎️
- And much more...
Send any keyword to get started! 🚀
or visit https://daycationtour.com/  for details and bookings.`;

const RESULTS_TPL = (count, keyword, tours) =>
  `Great choice! Here are ${count} amazing tours for "${keyword}":\n\n${tours}\nReady for more adventures? Send me another activity or "0" to see the main menu!`;

const NO_RESULTS_TPL =
  `Thank you for your inquiry. Our customer service team will contact you soon or visit website www.daycationtour.com`;

/* ---------- AUDIT LOG (in-memory, restart-safe) ---------- */
const auditLog = [];

/* ---------- WEBHOOK ---------- */
app.post("/webhook", (req, res) => {
  const from   = req.body?.From || "unknown";
  const body   = (req.body?.Body || "").trim().toLowerCase();
  const ts     = new Date().toISOString();
  let reason   = "OK"; // default

  let reply = "";
  let answered = false;

  try {
    if (body === "0") {
      reply    = WELCOME;
      answered = true;
      reason   = "reset";
    } else {
      const keyword = extractKeyword(body);
      const results = fuse.search(keyword).slice(0, 5);

      if (results.length === 0) {
        reply    = NO_RESULTS_TPL;
        reason   = "no-match";
      } else {
        const tourList = results.map(r => `🎯 ${r.item.ACTIVITIES}\n🔗 ${r.item.URL}`).join("\n\n");
        reply    = RESULTS_TPL(results.length, keyword, tourList);
        answered = true;
      }
    }
  } catch (err) {
    reply    = "Sorry, an error occurred.";
    reason   = "exception";
    console.error("📉 stall:", err.message);
  }

  // push to audit log (newest first)
  auditLog.unshift({
    ts,
    from,
    body,
    answered,
    reason,
    reply: reply.substring(0, 200) + "…"
  });

  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`;
  res.type("text/xml").send(twiml);
});

/* ---------- HEALTH ---------- */
app.get("/health", (_req, res) => res.json({ status: "ok", tours: TOURS.length }));

/* ---------- AUDIT DASHBOARD ---------- */
app.get("/audit", (_req, res) =>
  res.json({
    totalMessages: auditLog.length,
    messages: auditLog
  })
);

/* ---------- START ---------- */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Audit bot listening on port ${PORT}`));