const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const E = process.env;
const PORT = E.PORT || 3000;
const BASE_URL = (E.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const SECRET = E.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!E.SESSION_SECRET) console.warn("⚠ SESSION_SECRET absent : les sessions admin seront perdues à chaque redémarrage.");

/* ---------- Base de données ---------- */
const db = new Database(E.DB_PATH || path.join(__dirname, "data.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY AUTOINCREMENT, nom TEXT NOT NULL, cat TEXT, description TEXT, prix INTEGER NOT NULL, stock INTEGER DEFAULT 0, image TEXT, actif INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS zones(id INTEGER PRIMARY KEY AUTOINCREMENT, nom TEXT NOT NULL, frais INTEGER DEFAULT 0, actif INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT UNIQUE, nom TEXT, tel TEXT, email TEXT, adresse TEXT, zone TEXT, frais INTEGER, sous_total INTEGER, total INTEGER, mode TEXT, paiement TEXT DEFAULT 'en_attente', statut TEXT DEFAULT 'nouvelle', provider_id TEXT, note TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, product_id INTEGER, nom TEXT, prix INTEGER, qte INTEGER);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
`);
const getSet = k => db.prepare("SELECT v FROM settings WHERE k=?").get(k)?.v;
const setSet = (k, v) => db.prepare("INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);
const hash = (pw, salt = crypto.randomBytes(16).toString("hex")) => salt + ":" + crypto.scryptSync(pw, salt, 64).toString("hex");
const check = (pw, h) => { const [s, x] = h.split(":"); const y = crypto.scryptSync(pw, s, 64).toString("hex"); return crypto.timingSafeEqual(Buffer.from(x), Buffer.from(y)); };
if (!getSet("admin")) {
  if (!E.ADMIN_PASSWORD) console.warn("⚠ ADMIN_PASSWORD absent : mot de passe temporaire « changez-moi ». Changez-le dans l’administration.");
  setSet("admin", hash(E.ADMIN_PASSWORD || "changez-moi"));
}
if (!db.prepare("SELECT 1 FROM zones").get()) {
  const z = db.prepare("INSERT INTO zones(nom,frais) VALUES(?,?)");
  [["Kaloum", 15000], ["Dixinn", 20000], ["Matam", 20000], ["Ratoma", 25000], ["Matoto", 25000], ["Retrait en boutique", 0]].forEach(a => z.run(...a));
}
if (!db.prepare("SELECT 1 FROM products").get()) {
  const p = db.prepare("INSERT INTO products(nom,cat,description,prix,stock) VALUES(?,?,?,?,?)");
  [["Smartphone 128 Go", "Téléphones", "Écran 6,5 pouces, double SIM", 2800000, 10], ["Écouteurs sans fil", "Accessoires", "Bluetooth 5.3", 250000, 25], ["Chargeur rapide 33 W", "Accessoires", "USB-C, câble inclus", 120000, 40]].forEach(a => p.run(...a));
}

/* ---------- Outils ---------- */
const sign = s => crypto.createHmac("sha256", SECRET).update(s).digest("hex");
const makeToken = () => { const p = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 3600e3 })).toString("base64url"); return p + "." + sign(p); };
function validToken(t) {
  if (!t) return false;
  const [p, s] = t.split(".");
  if (!p || !s) return false;
  const ok = sign(p);
  if (s.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(ok))) return false;
  try { return JSON.parse(Buffer.from(p, "base64url")).exp > Date.now(); } catch { return false; }
}
const cookies = r => Object.fromEntries((r.headers.cookie || "").split(";").map(c => c.trim().split("=")).filter(a => a[0]));
const normTel = t => String(t || "").replace(/\D/g, "").replace(/^224/, "");
const tries = new Map();
const MODES_OK = ["nouvelle", "confirmee", "preparation", "livraison", "livree", "annulee"];
const PAIE_OK = ["en_attente", "paye", "echoue", "rembourse"];

function restock(orderId) {
  const o = db.prepare("SELECT statut FROM orders WHERE id=?").get(orderId);
  if (!o || o.statut === "annulee") return;
  db.prepare("SELECT product_id,qte FROM items WHERE order_id=?").all(orderId)
    .forEach(i => db.prepare("UPDATE products SET stock=stock+? WHERE id=?").run(i.qte, i.product_id));
  db.prepare("UPDATE orders SET statut='annulee' WHERE id=?").run(orderId);
}

/* ---------- Paiement automatique (Moneroo) ---------- */
const MONEROO = "https://api.moneroo.io/v1";
const mHeaders = () => ({ Authorization: `Bearer ${E.MONEROO_SECRET_KEY}`, "Content-Type": "application/json", Accept: "application/json" });
async function initPaiement(o) {
  const [prenom, ...reste] = o.nom.split(" ");
  const r = await fetch(MONEROO + "/payments/initialize", {
    method: "POST", headers: mHeaders(),
    body: JSON.stringify({
      amount: o.total, currency: "GNF", description: `Commande ${o.ref}`,
      return_url: `${BASE_URL}/?ref=${o.ref}`,
      customer: { email: o.email, first_name: prenom, last_name: reste.join(" ") || prenom },
      metadata: { ref: o.ref, tel: o.tel }
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.data?.checkout_url) throw new Error(j.message || "Initialisation du paiement refusée");
  return { id: j.data.id, url: j.data.checkout_url };
}
async function verifierPaiement(id) {
  const r = await fetch(`${MONEROO}/payments/${encodeURIComponent(id)}/verify`, { headers: mHeaders() });
  const j = await r.json().catch(() => ({}));
  return r.ok ? j.data : null;
}
async function traiterPaiement(providerId) {
  const d = await verifierPaiement(providerId);
  if (!d) return;
  const o = db.prepare("SELECT * FROM orders WHERE provider_id=?").get(providerId);
  if (!o) return;
  if (d.status === "success") {
    if (typeof d.amount === "number" && d.amount !== o.total) {
      db.prepare("UPDATE orders SET note=COALESCE(note,'')||? WHERE id=?").run(` [Montant payé différent : ${d.amount}]`, o.id);
      return;
    }
    db.prepare("UPDATE orders SET paiement='paye', statut=CASE WHEN statut='nouvelle' THEN 'confirmee' ELSE statut END WHERE id=?").run(o.id);
  } else if (d.status === "failed" || d.status === "cancelled") {
    db.prepare("UPDATE orders SET paiement='echoue' WHERE id=? AND paiement!='paye'").run(o.id);
    if (o.paiement !== "paye") restock(o.id);
  }
}

/* ---------- Application ---------- */
const app = express();
app.disable("x-powered-by");
app.use((q, s, n) => { s.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" }); n(); });

app.post("/api/webhooks/moneroo", express.raw({ type: "*/*" }), async (q, s) => {
  const sig = String(q.headers["x-moneroo-signature"] || "");
  const ok = crypto.createHmac("sha256", E.MONEROO_WEBHOOK_SECRET || "").update(q.body).digest("hex");
  if (!E.MONEROO_WEBHOOK_SECRET || sig.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(ok))) return s.sendStatus(401);
  s.sendStatus(200);
  try { const ev = JSON.parse(q.body.toString()); const id = ev.data?.id; if (id) await traiterPaiement(id); } catch (e) { console.error("Webhook :", e.message); }
});

app.use(express.json({ limit: "100kb" }));

/* --- Public --- */
app.get("/api/config", (q, s) => s.json({
  boutique: E.BOUTIQUE || "Boutique", whatsapp: E.WHATSAPP || "", pixelId: E.META_PIXEL_ID || "",
  paiementEnLigne: !!E.MONEROO_SECRET_KEY,
  zones: db.prepare("SELECT id,nom,frais FROM zones WHERE actif=1 ORDER BY id").all()
}));
app.get("/api/products", (q, s) => s.json(db.prepare("SELECT id,nom,cat,description,prix,stock,image FROM products WHERE actif=1 AND stock>0 ORDER BY id DESC").all()));

app.post("/api/orders", async (q, s) => {
  const b = q.body || {};
  const nom = String(b.nom || "").trim().slice(0, 80), tel = normTel(b.tel), adr = String(b.adresse || "").trim().slice(0, 200);
  const email = String(b.email || "").trim().slice(0, 120) || `${tel}@${E.FALLBACK_EMAIL_DOMAIN || "example.com"}`;
  const zone = db.prepare("SELECT * FROM zones WHERE id=? AND actif=1").get(+b.zone);
  const mode = b.mode === "en_ligne" && E.MONEROO_SECRET_KEY ? "en_ligne" : "livraison";
  if (nom.length < 3 || tel.length < 8 || !zone || !Array.isArray(b.items) || !b.items.length) return s.status(400).json({ error: "Informations incomplètes. Vérifiez votre nom, téléphone et commune." });
  if (!/^retrait/i.test(zone.nom) && adr.length < 4) return s.status(400).json({ error: "Indiquez votre quartier et un repère pour le livreur." });
  const ref = "AT-" + crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
  let order;
  try {
    order = db.transaction(() => {
      const lignes = []; let st = 0;
      for (const it of b.items.slice(0, 30)) {
        const p = db.prepare("SELECT * FROM products WHERE id=? AND actif=1").get(+it.id);
        const qte = Math.max(1, Math.min(20, parseInt(it.qte) || 1));
        if (!p) throw new Error("Un produit n’existe plus. Actualisez la page.");
        if (db.prepare("UPDATE products SET stock=stock-? WHERE id=? AND stock>=?").run(qte, p.id, qte).changes === 0) throw new Error(`Stock insuffisant pour « ${p.nom} ».`);
        lignes.push({ p, qte }); st += p.prix * qte;
      }
      const total = st + zone.frais;
      const id = db.prepare("INSERT INTO orders(ref,nom,tel,email,adresse,zone,frais,sous_total,total,mode) VALUES(?,?,?,?,?,?,?,?,?,?)").run(ref, nom, tel, email, adr, zone.nom, zone.frais, st, total, mode).lastInsertRowid;
      lignes.forEach(l => db.prepare("INSERT INTO items(order_id,product_id,nom,prix,qte) VALUES(?,?,?,?,?)").run(id, l.p.id, l.p.nom, l.p.prix, l.qte));
      return { id, ref, nom, tel, email, total };
    })();
  } catch (e) { return s.status(409).json({ error: e.message }); }
  if (mode === "en_ligne") {
    try {
      const p = await initPaiement(order);
      db.prepare("UPDATE orders SET provider_id=? WHERE id=?").run(p.id, order.id);
      return s.json({ ref, checkoutUrl: p.url });
    } catch (e) {
      console.error("Paiement :", e.message);
      restock(order.id);
      return s.status(502).json({ error: "Le paiement en ligne est momentanément indisponible. Choisissez le paiement à la livraison ou réessayez." });
    }
  }
  s.json({ ref });
});

app.get("/api/suivi", async (q, s) => {
  const o = db.prepare("SELECT * FROM orders WHERE ref=?").get(String(q.query.ref || "").toUpperCase());
  if (!o || normTel(q.query.tel).slice(-8) !== o.tel.slice(-8)) return s.status(404).json({ error: "Aucune commande trouvée avec ces informations." });
  if (o.paiement === "en_attente" && o.mode === "en_ligne" && o.provider_id) { await traiterPaiement(o.provider_id).catch(() => {}); }
  const m = db.prepare("SELECT ref,statut,paiement,mode,total,zone,created_at FROM orders WHERE id=?").get(o.id);
  m.items = db.prepare("SELECT nom,qte,prix FROM items WHERE order_id=?").all(o.id);
  s.json(m);
});

/* --- Administration --- */
app.get("/admin", (q, s) => s.sendFile(path.join(__dirname, "public", "admin.html")));
app.post("/admin/api/login", (q, s) => {
  const ip = q.ip, t = tries.get(ip) || { n: 0, until: 0 };
  if (t.n >= 5 && Date.now() < t.until) return s.status(429).json({ error: "Trop de tentatives. Réessayez dans 10 minutes." });
  if (!check(String(q.body?.password || ""), getSet("admin"))) { tries.set(ip, { n: t.n + 1, until: Date.now() + 600e3 }); return s.status(401).json({ error: "Mot de passe incorrect." }); }
  tries.delete(ip);
  s.setHeader("Set-Cookie", `adm=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${BASE_URL.startsWith("https") ? "; Secure" : ""}`);
  s.json({ ok: true });
});
app.post("/admin/api/logout", (q, s) => { s.setHeader("Set-Cookie", "adm=; HttpOnly; Path=/; Max-Age=0"); s.json({ ok: true }); });
app.use("/admin/api", (q, s, n) => validToken(cookies(q).adm) ? n() : s.status(401).json({ error: "Session expirée" }));

app.get("/admin/api/stats", (q, s) => s.json({
  total: db.prepare("SELECT COUNT(*) n FROM orders").get().n,
  aujourdhui: db.prepare("SELECT COUNT(*) n FROM orders WHERE date(created_at)=date('now')").get().n,
  nouvelles: db.prepare("SELECT COUNT(*) n FROM orders WHERE statut='nouvelle'").get().n,
  caPaye: db.prepare("SELECT COALESCE(SUM(total),0) n FROM orders WHERE paiement='paye' AND statut!='annulee'").get().n,
  aEncaisser: db.prepare("SELECT COALESCE(SUM(total),0) n FROM orders WHERE paiement!='paye' AND mode='livraison' AND statut NOT IN ('annulee')").get().n,
  stockBas: db.prepare("SELECT id,nom,stock FROM products WHERE actif=1 AND stock<=3 ORDER BY stock").all()
}));
app.get("/admin/api/orders", (q, s) => {
  const st = String(q.query.statut || ""), term = `%${String(q.query.q || "").trim()}%`;
  const rows = db.prepare(`SELECT * FROM orders WHERE (?='' OR statut=?) AND (nom LIKE ? OR tel LIKE ? OR ref LIKE ?) ORDER BY id DESC LIMIT 200`).all(st, st, term, term, term);
  rows.forEach(o => o.items = db.prepare("SELECT nom,qte,prix FROM items WHERE order_id=?").all(o.id));
  s.json(rows);
});
app.patch("/admin/api/orders/:id", (q, s) => {
  const o = db.prepare("SELECT * FROM orders WHERE id=?").get(+q.params.id);
  if (!o) return s.sendStatus(404);
  const { statut, paiement, note } = q.body || {};
  if (paiement && PAIE_OK.includes(paiement)) db.prepare("UPDATE orders SET paiement=? WHERE id=?").run(paiement, o.id);
  if (typeof note === "string") db.prepare("UPDATE orders SET note=? WHERE id=?").run(note.slice(0, 500), o.id);
  if (statut && MODES_OK.includes(statut)) {
    if (statut === "annulee") restock(o.id);
    else {
      db.prepare("UPDATE orders SET statut=? WHERE id=?").run(statut, o.id);
      if (statut === "livree" && o.mode === "livraison") db.prepare("UPDATE orders SET paiement='paye' WHERE id=?").run(o.id);
    }
  }
  s.json({ ok: true });
});
app.get("/admin/api/export.csv", (q, s) => {
  const c = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = db.prepare("SELECT * FROM orders ORDER BY id DESC").all();
  s.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=commandes.csv" });
  s.send("\ufeff" + ["ref,date,nom,tel,zone,adresse,total,mode,paiement,statut", ...rows.map(o => [o.ref, o.created_at, o.nom, o.tel, o.zone, o.adresse, o.total, o.mode, o.paiement, o.statut].map(c).join(","))].join("\n"));
});

const prodFields = b => [String(b.nom || "").slice(0, 120), String(b.cat || "").slice(0, 60), String(b.description || "").slice(0, 300), Math.max(0, parseInt(b.prix) || 0), Math.max(0, parseInt(b.stock) || 0), String(b.image || "").slice(0, 300), b.actif === 0 || b.actif === false ? 0 : 1];
app.get("/admin/api/products", (q, s) => s.json(db.prepare("SELECT * FROM products ORDER BY id DESC").all()));
app.post("/admin/api/products", (q, s) => {
  if (!String(q.body?.nom || "").trim()) return s.status(400).json({ error: "Le nom est obligatoire." });
  s.json({ id: db.prepare("INSERT INTO products(nom,cat,description,prix,stock,image,actif) VALUES(?,?,?,?,?,?,?)").run(...prodFields(q.body)).lastInsertRowid });
});
app.put("/admin/api/products/:id", (q, s) => { db.prepare("UPDATE products SET nom=?,cat=?,description=?,prix=?,stock=?,image=?,actif=? WHERE id=?").run(...prodFields(q.body || {}), +q.params.id); s.json({ ok: true }); });
app.delete("/admin/api/products/:id", (q, s) => { db.prepare("DELETE FROM products WHERE id=?").run(+q.params.id); s.json({ ok: true }); });

app.get("/admin/api/zones", (q, s) => s.json(db.prepare("SELECT id,nom,frais,actif FROM zones ORDER BY id").all()));
app.put("/admin/api/zones", (q, s) => {
  const list = Array.isArray(q.body) ? q.body.filter(z => String(z.nom || "").trim()).slice(0, 60) : [];
  db.transaction(() => {
    db.prepare("UPDATE zones SET actif=0").run();
    list.forEach(z => {
      const f = Math.max(0, parseInt(z.frais) || 0), n = String(z.nom).trim().slice(0, 80);
      const ex = db.prepare("SELECT id FROM zones WHERE nom=?").get(n);
      ex ? db.prepare("UPDATE zones SET frais=?,actif=1 WHERE id=?").run(f, ex.id) : db.prepare("INSERT INTO zones(nom,frais) VALUES(?,?)").run(n, f);
    });
  })();
  s.json({ ok: true });
});
app.put("/admin/api/password", (q, s) => {
  const { ancien, nouveau } = q.body || {};
  if (!check(String(ancien || ""), getSet("admin"))) return s.status(400).json({ error: "Ancien mot de passe incorrect." });
  if (String(nouveau || "").length < 8) return s.status(400).json({ error: "Le nouveau mot de passe doit faire au moins 8 caractères." });
  setSet("admin", hash(nouveau)); s.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));
app.listen(PORT, () => console.log(`Boutique démarrée : ${BASE_URL} (admin : ${BASE_URL}/admin)`));
