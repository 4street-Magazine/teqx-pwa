const J = (d, s = 200) => Response.json(d, { status: s });

// Commission is fixed at 8% on every sale made through an agent's post.
const FIXED_PCT = 8;

const cleanAttrs = (a) =>
  (Array.isArray(a) ? a : [])
    .map((x) => ({
      k: String((x && x.k) || "").trim().slice(0, 20),
      v: (Array.isArray(x && x.v) ? x.v : []).map((y) => String(y).trim().slice(0, 20)).filter(Boolean).slice(0, 12),
    }))
    .filter((x) => x.k && x.v.length)
    .slice(0, 6);

// Detail fields from the category catalog: { Brand: "Samsung", Condition: "New" }
const cleanSpecs = (s) => {
  const o = {};
  Object.entries(s && typeof s === "object" && !Array.isArray(s) ? s : {}).slice(0, 12).forEach(([k, v]) => {
    const kk = String(k).trim().slice(0, 30), vv = String(v == null ? "" : v).trim().slice(0, 60);
    if (kk && vv) o[kk] = vv;
  });
  return o;
};

// Post photos must be images we host or https links.
const cleanImgs = (a) =>
  (Array.isArray(a) ? a : [])
    .map((x) => String(x || ""))
    .filter((x) => /^\/api\/images\/\d+$/.test(x) || /^https:\/\//.test(x))
    .map((x) => x.slice(0, 300))
    .slice(0, 6);

const STATUS_RANK = { Secured: 0, Shipped: 1, Delivered: 2, Collected: 3 };

const normPhone = (p) => {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("0")) d = "254" + d.slice(1);
  else if (/^[17]\d{8}$/.test(d)) d = "254" + d;
  return /^254[17]\d{8}$/.test(d) ? d : null;
};

// ---------- Safaricom Daraja (M-Pesa STK push) ----------
// Sandbox by default. For live, set MPESA_BASE = "https://api.safaricom.co.ke" in wrangler.toml [vars].
// (payments.flw_id column now holds Daraja's CheckoutRequestID.)
const mBase = (env) => env.MPESA_BASE || "https://sandbox.safaricom.co.ke";
const stamp = () => new Date().toISOString().replace(/\D/g, "").slice(0, 14);

let tok = { t: "", exp: 0 };
const mToken = async (env) => {
  if (tok.t && Date.now() < tok.exp) return tok.t;
  const r = await fetch(mBase(env) + "/oauth/v1/generate?grant_type=client_credentials", {
    headers: { Authorization: "Basic " + btoa(env.MPESA_CONSUMER_KEY + ":" + env.MPESA_CONSUMER_SECRET) },
  });
  const d = await r.json().catch(() => ({}));
  if (!d.access_token) throw new Error("auth");
  tok = { t: d.access_token, exp: Date.now() + 3000 * 1000 };
  return tok.t;
};

const mCall = async (env, path, payload) => {
  const ts = stamp();
  const r = await fetch(mBase(env) + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + (await mToken(env)), "Content-Type": "application/json" },
    body: JSON.stringify({
      BusinessShortCode: env.MPESA_SHORTCODE,
      Password: btoa(env.MPESA_SHORTCODE + env.MPESA_PASSKEY + ts),
      Timestamp: ts,
      ...payload,
    }),
  });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
};

// Ask Safaricom for the real state of a payment (fallback if the callback is late) and save it.
const settle = async (env, db, p) => {
  if (p.status !== "pending" || !env.MPESA_CONSUMER_KEY) return p.status;
  const age = p.created_at ? Date.now() - Date.parse(String(p.created_at).replace(" ", "T") + "Z") : 1e9;
  if (age < 15000) return "pending"; // give the callback a head start
  try {
    const r = await mCall(env, "/mpesa/stkpushquery/v1/query", { CheckoutRequestID: p.flw_id });
    // ResultCode is absent while the customer is still on the prompt
    if (r.data && r.data.ResultCode !== undefined) {
      const ok = String(r.data.ResultCode) === "0";
      await db.prepare("UPDATE payments SET status = ? WHERE tx_ref = ? AND status = 'pending'")
        .bind(ok ? "successful" : "failed", p.tx_ref).run();
      return ok ? "successful" : "failed";
    }
  } catch (e) {}
  return "pending";
};

const readAttrs = (t) => {
  try { return JSON.parse(t || "[]"); } catch (e) { return []; }
};

const readJ = (t, d) => {
  try {
    const v = JSON.parse(t || "");
    return v === null || v === undefined ? d : v;
  } catch (e) { return d; }
};

// The products table needs a few extra columns for variants. Add them once, automatically, if missing.
let colsOk = false;
const ensureCols = async (db) => {
  if (colsOk) return;
  const have = new Set(((await db.prepare("PRAGMA table_info(products)").all()).results || []).map((c) => c.name));
  for (const [c, t] of [["variants", "TEXT"], ["category", "TEXT"], ["description", "TEXT"], ["moq", "INTEGER"], ["cimg", "TEXT"], ["specs", "TEXT"]])
    if (!have.has(c)) await db.prepare("ALTER TABLE products ADD COLUMN " + c + " " + t).run();
  // Promoted dropshipper posts, and which post/dropshipper an order came from.
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, store_id TEXT NOT NULL, pid TEXT, name TEXT, price INTEGER, pct INTEGER, caption TEXT, imgs TEXT, created_at INTEGER)"
  ).run();
  const pc = new Set(((await db.prepare("PRAGMA table_info(posts)").all()).results || []).map((c) => c.name));
  for (const c of ["author_name", "author_icon", "author_img", "cid"])
    if (!pc.has(c)) await db.prepare("ALTER TABLE posts ADD COLUMN " + c + " TEXT").run();
  // Shop profile fields.
  const sc = new Set(((await db.prepare("PRAGMA table_info(stores)").all()).results || []).map((c) => c.name));
  for (const c of ["bio", "phone", "loc", "hours"])
    if (!sc.has(c)) await db.prepare("ALTER TABLE stores ADD COLUMN " + c + " TEXT").run();
  // One row per product per (paid) order. This is what the order-based rating counts.
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS order_items (order_id TEXT NOT NULL, store_id TEXT NOT NULL, product_id INTEGER NOT NULL, name TEXT, qty INTEGER, created_at INTEGER, PRIMARY KEY (order_id, product_id))"
  ).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id)").run();
  // Likes, saves, follows (and likes on comments). One row per phone per thing.
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS reactions (device_id TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, created_at INTEGER, PRIMARY KEY (device_id, kind, target))"
  ).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_reactions_target ON reactions(kind, target)").run();
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, device_id TEXT NOT NULL, author TEXT, text TEXT NOT NULL, parent TEXT, created_at INTEGER)"
  ).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(target)").run();
  // Short share links (teqxmarket.co.ke/s/<code>) -> product post + the agent who shared it (for commission).
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS links (code TEXT PRIMARY KEY, pid TEXT NOT NULL, ref TEXT, created_at INTEGER)"
  ).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_links_pid_ref ON links(pid, ref)").run();
  // Chat history, one row per phone per shop.
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS chats (device_id TEXT NOT NULL, store_id TEXT NOT NULL, data TEXT, unread INTEGER DEFAULT 0, updated_at INTEGER, draft TEXT, PRIMARY KEY (device_id, store_id))"
  ).run();
  // Unfinished order ("draft") saved with each chat so it can be picked up later.
  const cc = new Set(((await db.prepare("PRAGMA table_info(chats)").all()).results || []).map((c) => c.name));
  if (!cc.has("draft")) await db.prepare("ALTER TABLE chats ADD COLUMN draft TEXT").run();
  const oc = new Set(((await db.prepare("PRAGMA table_info(orders)").all()).results || []).map((c) => c.name));
  for (const [c, t] of [["ds_device", "TEXT"], ["post_id", "INTEGER"], ["comm", "INTEGER"], ["qty", "INTEGER"]])
    if (!oc.has(c)) await db.prepare("ALTER TABLE orders ADD COLUMN " + c + " " + t).run();
  try {
    const ic = new Set(((await db.prepare("PRAGMA table_info(images)").all()).results || []).map((c) => c.name));
    if (!ic.has("hash")) await db.prepare("ALTER TABLE images ADD COLUMN hash TEXT").run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_images_dev_hash ON images(owner_device, hash)").run();
  } catch (e) {}
  colsOk = true;
};

// Each variant: { key: "M / Black", opts: { Size: "M", Color: "Black" }, price, stock, off }
const cleanVariants = (a, base) =>
  (Array.isArray(a) ? a : [])
    .slice(0, 150)
    .map((x) => {
      const opts = {};
      Object.entries((x && x.opts) || {}).slice(0, 3).forEach(([k, v]) => {
        opts[String(k).slice(0, 20)] = String(v).slice(0, 20);
      });
      const p = parseInt(x && x.price, 10);
      return {
        key: String((x && x.key) || Object.values(opts).join(" / ")).slice(0, 80),
        opts,
        price: p > 0 ? p : base,
        stock: Math.max(0, parseInt(x && x.stock, 10) || 0),
        off: !!(x && x.off),
      };
    })
    .filter((x) => x.key && Object.keys(x.opts).length);

// Photo for each colour: { Black: 12 } (image ids) -> { Black: "/api/images/12" }
const cleanCimg = (c) => {
  const o = {};
  Object.entries(c && typeof c === "object" ? c : {}).slice(0, 12).forEach(([k, v]) => {
    const n = Number(v);
    if (n > 0) o[String(k).slice(0, 20)] = "/api/images/" + n;
  });
  return o;
};

// Product price = lowest active variant price, stock = total of active variants.
const totals = (vars, price, stock) => {
  const on = vars.filter((v) => !v.off && v.price > 0);
  return on.length
    ? { price: Math.min(...on.map((v) => v.price)), stock: on.reduce((a, v) => a + v.stock, 0) }
    : { price, stock };
};

// Work out which product an order line is for: same name in the shop, then the chosen options
// ("Size: M, Color: Black") decide between products that share a name.
const parseOpt = (opt) => {
  const want = {};
  String(opt || "").split(", ").forEach((part) => {
    const i = part.indexOf(": ");
    if (i > 0) want[part.slice(0, i)] = part.slice(i + 2);
  });
  return want;
};
const findProduct = async (db, storeId, ln) => {
  const rows = ((await db.prepare("SELECT * FROM products WHERE store_id = ? AND name = ? ORDER BY id")
    .bind(storeId, String((ln && ln.name) || "")).all()).results) || [];
  if (rows.length <= 1) return rows[0] || null;
  const want = parseOpt(ln && ln.opt), keys = Object.keys(want);
  if (!keys.length) return rows[0];
  let best = rows[0], bestScore = -1;
  for (const p of rows) {
    const vars = readJ(p.variants, []).filter((v) => !v.off), attrs = readAttrs(p.attrs);
    let score;
    if (vars.length) {
      const hit = vars.some((v) => keys.every((k) => v.opts[k] === want[k]));
      score = hit ? keys.length + 1 : Math.max(0, ...vars.map((v) => keys.filter((k) => v.opts[k] === want[k]).length));
    } else score = keys.filter((k) => attrs.some((a) => a.k === k && a.v.includes(want[k]))).length;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
};

// Take bought quantities off stock. lines = [{ name, opt: "Size: M, Color: Black", qty }]
const takeStock = async (db, storeId, lines) => {
  for (const ln of lines.slice(0, 30)) {
    const qty = Math.min(99, Math.max(1, parseInt(ln && ln.qty, 10) || 1));
    const p = await findProduct(db, storeId, ln);
    if (!p) continue;
    const vars = readJ(p.variants, []);
    if (vars.length) {
      const want = {};
      String((ln && ln.opt) || "").split(", ").forEach((part) => {
        const i = part.indexOf(": ");
        if (i > 0) want[part.slice(0, i)] = part.slice(i + 2);
      });
      const v = vars.find((x) => !x.off && Object.entries(want).every(([k, val]) => x.opts[k] === val));
      if (!v) continue;
      v.stock = Math.max(0, v.stock - qty);
      const t = totals(vars, p.price, p.stock || 0);
      await db.prepare("UPDATE products SET price = ?, stock = ?, variants = ? WHERE id = ?")
        .bind(t.price, t.stock, JSON.stringify(vars), p.id).run();
    } else {
      await db.prepare("UPDATE products SET stock = MAX(0, COALESCE(stock, 0) - ?) WHERE id = ?").bind(qty, p.id).run();
    }
  }
};

// Remember which products an order contained, so each product can show how many orders it has had.
const recordItems = async (db, orderId, storeId, lines) => {
  const seen = new Map();
  for (const ln of lines.slice(0, 30)) {
    const name = String((ln && ln.name) || "");
    if (!name) continue;
    const p = await findProduct(db, storeId, ln);
    if (!p) continue;
    const qty = Math.min(99, Math.max(1, parseInt(ln.qty, 10) || 1));
    seen.set(p.id, { name, qty: ((seen.get(p.id) || {}).qty || 0) + qty });
  }
  for (const [pid, v] of seen)
    await db.prepare("INSERT OR IGNORE INTO order_items (order_id,store_id,product_id,name,qty,created_at) VALUES (?,?,?,?,?,?)")
      .bind(orderId, storeId, pid, v.name, v.qty, Date.now()).run();
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const m = request.method;
    const db = env.DB;
    const body = async () => {
      try { return await request.json(); } catch (e) { return {}; }
    };

    if (path === "/api/ping") return J({ ok: true });

    // ---------- DROPSHIPPER POSTS ----------
    if (path === "/api/posts" && m === "GET") {
      await ensureCols(db);
      const device = url.searchParams.get("device") || "";
      const rows = (await db.prepare("SELECT * FROM posts ORDER BY id DESC LIMIT 100").all()).results;
      return J(rows.map((r) => ({
        id: r.id, store_id: r.store_id, pid: r.pid, name: r.name, price: r.price, pct: FIXED_PCT,
        caption: r.caption || "", imgs: readJ(r.imgs, []), created_at: r.created_at,
        author_name: r.author_name || "", author_icon: r.author_icon || "", author_img: r.author_img || "",
        mine: !!device && r.device_id === device,
      })));
    }

    if (path === "/api/posts" && m === "POST") {
      await ensureCols(db);
      const b = await body();
      if (!b.device_id || !b.store_id || !b.name) return J({ error: "missing fields" }, 400);
      let pct = FIXED_PCT;
      let price = parseInt(b.price, 10) || 0;
      let name = String(b.name).slice(0, 80);
      const mm = /^db(\d+)$/.exec(String(b.pid || ""));
      if (mm) {
        // A real merchant product: trust the server for its name, price and commission.
        const pr = await db.prepare("SELECT store_id, name, price, pct FROM products WHERE id = ?").bind(Number(mm[1])).first();
        if (!pr || pr.store_id !== b.store_id) return J({ error: "unknown product" }, 400);
        pct = FIXED_PCT; price = pr.price; name = pr.name;
      }
      const imgs = cleanImgs(b.imgs);
      if (!(price > 0) || !imgs.length) return J({ error: "price and a photo are required" }, 400);
      // Same post sent twice (double tap, or a retry after a slow reply)? Return the one we already have.
      const cid = String(b.cid || "").slice(0, 40), cap = String(b.caption || "").slice(0, 500);
      const dupe = cid
        ? await db.prepare("SELECT id FROM posts WHERE device_id = ? AND cid = ?").bind(b.device_id, cid).first()
        : await db.prepare("SELECT id FROM posts WHERE device_id = ? AND store_id = ? AND pid = ? AND name = ? AND caption = ? AND created_at > ?")
            .bind(b.device_id, b.store_id, String(b.pid || "").slice(0, 40), name, cap, Date.now() - 60000).first();
      if (dupe) return J({ ok: true, id: dupe.id, existing: true });
      const r = await db.prepare(
        "INSERT INTO posts (device_id,store_id,pid,name,price,pct,caption,imgs,created_at,author_name,author_icon,author_img,cid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(b.device_id, b.store_id, String(b.pid || "").slice(0, 40), name, price, pct,
        cap, JSON.stringify(imgs), Date.now(),
        String(b.author_name || "").slice(0, 40), String(b.author_icon || "").slice(0, 8), cleanImgs([b.author_img])[0] || "", cid).run();
      return J({ ok: true, id: r.meta.last_row_id });
    }

    if (path.startsWith("/api/posts/") && m === "PATCH") {
      await ensureCols(db);
      const id = Number(path.split("/").pop());
      const b = await body();
      const imgs = cleanImgs(b.imgs);
      await db.prepare(
        "UPDATE posts SET caption = ?, imgs = CASE WHEN ? = '[]' THEN imgs ELSE ? END, author_name = COALESCE(NULLIF(?, ''), author_name), author_icon = COALESCE(NULLIF(?, ''), author_icon), author_img = COALESCE(NULLIF(?, ''), author_img) WHERE id = ? AND device_id = ?"
      ).bind(String(b.caption || "").slice(0, 500), JSON.stringify(imgs), JSON.stringify(imgs),
        String(b.author_name || "").slice(0, 40), String(b.author_icon || "").slice(0, 8), cleanImgs([b.author_img])[0] || "",
        id, b.device_id || "").run();
      return J({ ok: true });
    }

    if (path.startsWith("/api/posts/") && m === "DELETE") {
      await ensureCols(db);
      const id = Number(path.split("/").pop());
      await db.prepare("DELETE FROM posts WHERE id = ? AND device_id = ?").bind(id, url.searchParams.get("device") || "").run();
      return J({ ok: true });
    }

    // ---------- STORES ----------
    if (path === "/api/stores" && m === "GET") {
      await ensureCols(db);
      const device = url.searchParams.get("device") || "";
      const stores = (await db.prepare("SELECT * FROM stores").all()).results;
      const prods = (await db.prepare("SELECT * FROM products ORDER BY id").all()).results;
      const sold = new Map(((await db.prepare("SELECT product_id, COUNT(*) AS n FROM order_items GROUP BY product_id").all()).results || []).map((r) => [r.product_id, r.n]));
      return J(stores.map((s) => {
        const mine = prods.filter((p) => p.store_id === s.id);
        return {
          id: s.id, name: s.name, tag: s.tag, icon: s.icon, category: s.category,
          img: s.img, open: s.open !== 0,
          mine: !!device && s.owner_device === device,
          bio: s.bio || "", loc: s.loc || "", hours: s.hours || "",
          phone: !!device && s.owner_device === device ? s.phone || "" : "", // contact number is only sent back to the owner
          prods: mine.map((p) => [p.name, p.price]),
          items: mine.map((p) => ({
            id: p.id, name: p.name, price: p.price, pct: FIXED_PCT, stock: p.stock || 0, orders: sold.get(p.id) || 0, attrs: readAttrs(p.attrs),
            variants: readJ(p.variants, []), cimg: readJ(p.cimg, {}), specs: readJ(p.specs, {}), category: p.category || "", description: p.description || "", moq: p.moq || 0,
            imgs: (p.img_ids || "").split(",").filter(Boolean).map((i) => "/api/images/" + i),
          })),
        };
      }));
    }

    if (path === "/api/stores" && m === "POST") {
      await ensureCols(db);
      const b = await body();
      if (!b.device_id || !b.name) return J({ error: "name and device_id required" }, 400);
      const ex = await db.prepare("SELECT id FROM stores WHERE owner_device = ?").bind(b.device_id).first();
      if (ex) {
        await db.prepare("UPDATE stores SET category=COALESCE(?,category), img=COALESCE(NULLIF(?, ''),img) WHERE id=?")
          .bind(b.category ? String(b.category).slice(0, 40) : null, b.img_id ? "/api/images/" + Number(b.img_id) : "", ex.id).run();
        return J({ ok: true, id: ex.id, existing: true });
      }
      const id = "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const img = b.img_id ? "/api/images/" + Number(b.img_id) : "";
      await db.prepare(
        "INSERT INTO stores (id,name,tag,icon,category,img,owner_device,open) VALUES (?,?,?,?,?,?,?,1)"
      ).bind(
        id, String(b.name).slice(0, 40), String(b.tag || "").slice(0, 30),
        String(b.icon || "🏪").slice(0, 8), String(b.category || "General").slice(0, 40), img, b.device_id
      ).run();
      return J({ ok: true, id });
    }

    if (path.startsWith("/api/stores/") && m === "PATCH") {
      await ensureCols(db);
      const id = path.split("/").pop();
      const b = await body();
      const img = b.img_id ? "/api/images/" + Number(b.img_id) : b.clear_img ? "" : null;
      await db.prepare(
        "UPDATE stores SET name=COALESCE(?,name), icon=COALESCE(?,icon), img=COALESCE(?,img), open=COALESCE(?,open), category=COALESCE(?,category), tag=COALESCE(?,tag), bio=COALESCE(?,bio), phone=COALESCE(?,phone), loc=COALESCE(?,loc), hours=COALESCE(?,hours) WHERE id=? AND owner_device=?"
      ).bind(
        b.name ? String(b.name).slice(0, 40) : null,
        b.icon ? String(b.icon).slice(0, 8) : null,
        img,
        b.open === undefined ? null : (b.open ? 1 : 0),
        b.category ? String(b.category).slice(0, 40) : null,
        b.tag ? String(b.tag).slice(0, 30) : null,
        b.bio === undefined ? null : String(b.bio).slice(0, 300),
        b.phone === undefined ? null : String(b.phone).slice(0, 20),
        b.loc === undefined ? null : String(b.loc).slice(0, 80),
        b.hours === undefined ? null : String(b.hours).slice(0, 80),
        id, b.device_id || ""
      ).run();
      return J({ ok: true });
    }

    // ---------- PRODUCTS ----------
    if (path === "/api/products" && m === "POST") {
      await ensureCols(db);
      const b = await body();
      const st = await db.prepare("SELECT owner_device FROM stores WHERE id = ?").bind(b.store_id || "").first();
      if (!st || !b.device_id || st.owner_device !== b.device_id) return J({ error: "not your shop" }, 403);
      const price = parseInt(b.price, 10);
      if (!b.name || !(price > 0)) return J({ error: "name and price required" }, 400);
      const attrs = cleanAttrs(b.attrs); // options like Size / Color (none for single-item products)
      const vars = cleanVariants(b.variants, price);
      const t = totals(vars, price, Math.max(0, parseInt(b.stock, 10) || 0));
      const ids = (b.img_ids || []).map(Number).filter(Boolean).slice(0, 5).join(",");
      const r = await db.prepare(
        "INSERT INTO products (store_id,name,price,pct,stock,img_ids,attrs,variants,category,description,moq,cimg,specs) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(
        b.store_id, String(b.name).slice(0, 80), t.price,
        FIXED_PCT, t.stock, ids, JSON.stringify(attrs),
        JSON.stringify(vars), String(b.category || "").slice(0, 40), String(b.description || "").slice(0, 500),
        Math.max(0, parseInt(b.moq, 10) || 0), JSON.stringify(cleanCimg(b.cimg)), JSON.stringify(cleanSpecs(b.specs))
      ).run();
      return J({ ok: true, id: r.meta.last_row_id });
    }

    // Update stock / variants of one of your own products (used by quick restock)
    if (path.startsWith("/api/products/") && m === "PATCH") {
      await ensureCols(db);
      const id = Number(path.split("/").pop());
      const b = await body();
      const row = await db.prepare(
        "SELECT p.* FROM products p JOIN stores s ON s.id = p.store_id WHERE p.id = ? AND s.owner_device = ?"
      ).bind(id, b.device_id || "").first();
      if (!row) return J({ error: "not your product" }, 403);
      let vars = readJ(row.variants, []);
      if (Array.isArray(b.variants)) vars = cleanVariants(b.variants, row.price);
      const t = totals(vars, row.price, b.stock !== undefined ? Math.max(0, parseInt(b.stock, 10) || 0) : row.stock || 0);
      await db.prepare("UPDATE products SET price = ?, stock = ?, variants = ? WHERE id = ?")
        .bind(t.price, t.stock, JSON.stringify(vars), id).run();
      return J({ ok: true, price: t.price, stock: t.stock });
    }

    if (path.startsWith("/api/products/") && m === "DELETE") {
      const id = Number(path.split("/").pop());
      const device = url.searchParams.get("device") || "";
      await db.prepare(
        "DELETE FROM products WHERE id = ? AND store_id IN (SELECT id FROM stores WHERE owner_device = ?)"
      ).bind(id, device).run();
      return J({ ok: true });
    }

    // ---------- IMAGES ----------
    if (path === "/api/images" && m === "POST") {
      await ensureCols(db);
      const b = await body();
      if (!b.device_id || typeof b.data !== "string" || !b.data.startsWith("data:image/"))
        return J({ error: "bad image" }, 400);
      if (b.data.length > 400000) return J({ error: "image too large" }, 413);
      // Same picture from the same phone = reuse it, so re-syncing never eats the image quota.
      const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(b.data));
      const hash = Array.from(new Uint8Array(dig)).map((x) => x.toString(16).padStart(2, "0")).join("");
      const dup = await db.prepare("SELECT id FROM images WHERE owner_device = ? AND hash = ?").bind(b.device_id, hash).first();
      if (dup) return J({ ok: true, id: dup.id, reused: true });
      const c = await db.prepare("SELECT COUNT(*) AS n FROM images WHERE owner_device = ?").bind(b.device_id).first();
      if (c && c.n >= 400) return J({ error: "image limit reached" }, 429);
      const r = await db.prepare("INSERT INTO images (owner_device,data,hash) VALUES (?,?,?)").bind(b.device_id, b.data, hash).run();
      return J({ ok: true, id: r.meta.last_row_id });
    }

    if (path.startsWith("/api/images/") && m === "GET") {
      const id = Number(path.split("/").pop());
      const row = await db.prepare("SELECT data FROM images WHERE id = ?").bind(id).first();
      if (!row) return new Response("not found", { status: 404 });
      const mt = /^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i.exec(row.data);
      if (!mt) return new Response("bad image", { status: 500 });
      const bin = Uint8Array.from(atob(mt[2]), (c) => c.charCodeAt(0));
      return new Response(bin, {
        headers: { "Content-Type": mt[1], "Cache-Control": "public, max-age=31536000, immutable" },
      });
    }

    // ---------- PAYMENTS (Safaricom Daraja M-Pesa STK push) ----------
    if (path === "/api/pay" && m === "POST") {
      if (!env.MPESA_CONSUMER_KEY || !env.MPESA_SHORTCODE || !env.MPESA_PASSKEY || !env.MPESA_CALLBACK_SECRET)
        return J({ error: "Payments are not set up yet" }, 503);
      const b = await body();
      const phone = normPhone(b.phone);
      const amount = Math.round(Number(b.amount));
      if (!b.device_id || !phone) return J({ error: "Enter a valid M-Pesa number" }, 400);
      if (!(amount >= 1 && amount <= 250000)) return J({ error: "Invalid amount" }, 400);
      const tx_ref = "TQP-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      let r;
      try {
        r = await mCall(env, "/mpesa/stkpush/v1/processrequest", {
          TransactionType: env.MPESA_TXN_TYPE || "CustomerPayBillOnline", // "CustomerBuyGoodsOnline" for a Till
          Amount: amount,
          PartyA: phone,
          PartyB: env.MPESA_PARTY_B || env.MPESA_SHORTCODE, // for a Till: set MPESA_PARTY_B to the Till number
          PhoneNumber: phone,
          CallBackURL: url.origin + "/api/pay/callback/" + env.MPESA_CALLBACK_SECRET,
          AccountReference: "TeQx",
          TransactionDesc: "TeQx order",
        });
      } catch (e) {
        return J({ error: "Could not reach M-Pesa, try again" }, 502);
      }
      if (!r.data || r.data.ResponseCode !== "0" || !r.data.CheckoutRequestID) {
        const why = r.data && (r.data.errorMessage || r.data.CustomerMessage || r.data.ResponseDescription);
        return J({ error: typeof why === "string" ? why : "Payment could not be started" }, 400);
      }
      await db.prepare(
        "INSERT INTO payments (tx_ref, flw_id, device_id, phone, amount, status) VALUES (?,?,?,?,?,'pending')"
      ).bind(tx_ref, String(r.data.CheckoutRequestID), b.device_id, phone, amount).run();
      return J({ ok: true, tx_ref });
    }

    if (path === "/api/pay/status" && m === "GET") {
      const tx = url.searchParams.get("tx_ref") || "";
      const device = url.searchParams.get("device") || "";
      const p = await db.prepare("SELECT * FROM payments WHERE tx_ref = ? AND device_id = ?").bind(tx, device).first();
      if (!p) return J({ status: "unknown" }, 404);
      return J({ status: await settle(env, db, p) });
    }

    // Safaricom calls this when the customer approves, cancels or times out.
    // The secret in the URL is what keeps strangers from faking a payment.
    if (env.MPESA_CALLBACK_SECRET && path === "/api/pay/callback/" + env.MPESA_CALLBACK_SECRET && m === "POST") {
      try {
        const cb = ((await body()).Body || {}).stkCallback || {};
        const p = await db.prepare("SELECT * FROM payments WHERE flw_id = ?").bind(String(cb.CheckoutRequestID || "")).first();
        if (p && p.status === "pending") {
          let st = "failed";
          if (Number(cb.ResultCode) === 0) {
            const it = Object.fromEntries(((cb.CallbackMetadata || {}).Item || []).map((i) => [i.Name, i.Value]));
            if (Number(it.Amount) >= p.amount) st = "successful";
          }
          await db.prepare("UPDATE payments SET status = ? WHERE tx_ref = ? AND status = 'pending'").bind(st, p.tx_ref).run();
        }
      } catch (e) {}
      return J({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    // ---------- ORDERS ----------
    if (path === "/api/orders" && m === "GET") {
      await ensureCols(db);
      const ds = url.searchParams.get("ds"), mer = url.searchParams.get("merchant");
      const cols = "o.id, o.store_id, o.item, o.price, o.fee, o.status, o.created_at, o.comm, o.qty, o.post_id, (o.ds_device IS NOT NULL) AS via_ds";
      if (ds)
        return J((await db.prepare("SELECT " + cols + " FROM orders o WHERE o.ds_device = ? ORDER BY o.created_at DESC LIMIT 200").bind(ds).all()).results);
      if (mer)
        return J((await db.prepare("SELECT " + cols + " FROM orders o JOIN stores s ON s.id = o.store_id WHERE s.owner_device = ? ORDER BY o.created_at DESC LIMIT 200").bind(mer).all()).results);
      const device = url.searchParams.get("device");
      if (!device) return J([]);
      const rows = (await db.prepare("SELECT * FROM orders WHERE device_id = ? ORDER BY created_at DESC").bind(device).all()).results;
      return J(rows);
    }

    if (path === "/api/orders" && m === "POST") {
      const o = await body();
      if (!o.id || !o.device_id) return J({ error: "missing id or device_id" }, 400);
      await ensureCols(db);
      // Came from a dropshipper's promoted post? Credit them (never the buyer themselves).
      let dsDev = null, postId = null, comm = 0, qty = 1;
      if (o.post_id) {
        const po = await db.prepare("SELECT * FROM posts WHERE id = ?").bind(Number(o.post_id) || 0).first();
        if (po && po.store_id === (o.store_id || "") && po.device_id !== o.device_id) {
          dsDev = po.device_id; postId = po.id;
          const lines = Array.isArray(o.lines) ? o.lines : [];
          let base = 0, q = 0;
          lines.forEach((l) => {
            if (l && String(l.name || "").startsWith(po.name)) {
              const n = Math.min(99, Math.max(1, parseInt(l.qty, 10) || 1));
              base += Math.max(0, parseInt(l.price, 10) || 0) * n; q += n;
            }
          });
          if (!lines.length && String(o.item || "").includes(po.name)) { base = o.price || 0; q = 1; }
          base = Math.min(base, o.price || 0);
          comm = Math.round((base * FIXED_PCT) / 100);
          qty = q || 1;
        }
      }
      // Bought through a shared link (?ref=<agent device>)? Credit that agent 8% of the shared product's lines.
      if (!dsDev && o.ref_device && o.ref_device !== o.device_id && /^db\d+$/.test(String(o.ref_pid || ""))) {
        const rp = await db.prepare("SELECT store_id, name FROM products WHERE id = ?").bind(Number(String(o.ref_pid).slice(2))).first();
        if (rp && rp.store_id === (o.store_id || "")) {
          const lines = Array.isArray(o.lines) ? o.lines : [];
          let base = 0, q = 0;
          lines.forEach((l) => {
            if (l && String(l.name || "").startsWith(rp.name)) {
              const n = Math.min(99, Math.max(1, parseInt(l.qty, 10) || 1));
              base += Math.max(0, parseInt(l.price, 10) || 0) * n; q += n;
            }
          });
          if (!lines.length && String(o.item || "").includes(rp.name)) { base = o.price || 0; q = 1; }
          base = Math.min(base, o.price || 0);
          if (base > 0) { dsDev = String(o.ref_device).slice(0, 80); comm = Math.round((base * FIXED_PCT) / 100); qty = q || 1; }
        }
      }
      let paid = 0;
      if (o.tx_ref) {
        const u = await db.prepare(
          "UPDATE payments SET order_id = ? WHERE tx_ref = ? AND device_id = ? AND status = 'successful' AND order_id IS NULL AND amount >= ?"
        ).bind(o.id, o.tx_ref, o.device_id, (o.price || 0) + (o.fee || 0)).run();
        if (!u.meta.changes) return J({ error: "payment not valid" }, 402);
        paid = 1;
      }
      const ins = await db.prepare(
        "INSERT OR IGNORE INTO orders (id, device_id, store_id, item, price, fee, status, station, tx_ref, paid, ds_device, post_id, comm, qty) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(o.id, o.device_id, o.store_id || null, o.item || "", o.price || 0, o.fee || 0, o.status || "Secured", o.station || null, o.tx_ref || null, paid, dsDev, postId, comm, qty).run();
      // Reduce stock only for a new order with a verified payment (set DEMO_MODE in wrangler.toml [vars] to test without payments)
      if (ins.meta && ins.meta.changes && (paid || env.DEMO_MODE) && o.store_id && Array.isArray(o.lines)) {
        try { await ensureCols(db); await takeStock(db, o.store_id, o.lines); } catch (e) {}
        try { await recordItems(db, o.id, o.store_id, o.lines); } catch (e) {}
      }
      return J({ ok: true });
    }

    if (path.startsWith("/api/orders/") && m === "PATCH") {
      const id = path.split("/").pop();
      const o = await body();
      const cur = await db.prepare("SELECT status FROM orders WHERE id = ?").bind(id).first();
      const ok = o.status && STATUS_RANK[o.status] !== undefined && cur && STATUS_RANK[o.status] >= (STATUS_RANK[cur.status] || 0);
      await db.prepare(
        "UPDATE orders SET status = COALESCE(?, status), station = COALESCE(?, station) WHERE id = ? AND (device_id = ? OR store_id IN (SELECT id FROM stores WHERE owner_device = ?))"
      ).bind(ok ? o.status : null, o.station || null, id, o.device_id || "", o.device_id || "").run();
      return J({ ok: true });
    }

    // ---------- LIKES, SAVES, FOLLOWS ----------
    const KINDS = ["like", "save", "follow", "clike", "share"];
    // Short, readable share link: "Air Max Retro Horizon" -> /s/airmax (same product + same agent always reuses the same code).
    if (path === "/api/short" && m === "POST") {
      await ensureCols(db);
      const b = await body();
      const pid = String(b.pid || "").slice(0, 80), ref = String(b.device_id || "").slice(0, 80);
      if (!pid) return J({ error: "bad link" }, 400);
      const old = await db.prepare("SELECT code FROM links WHERE pid = ? AND ref = ?").bind(pid, ref).first();
      if (old) return J({ ok: true, code: old.code });
      const base = (String(b.name || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean).slice(0, 2).join("") || "item").slice(0, 16);
      for (let i = 0; i < 8; i++) {
        const code = i === 0 ? base : base + Math.random().toString(36).slice(2, i < 4 ? 4 : 6);
        const r = await db.prepare("INSERT OR IGNORE INTO links (code,pid,ref,created_at) VALUES (?,?,?,?)").bind(code, pid, ref, Date.now()).run();
        if (r && r.meta && r.meta.changes) return J({ ok: true, code });
      }
      return J({ error: "busy" }, 500);
    }

    if (path === "/api/react" && m === "POST") {
      await ensureCols(db);
      const b = await body();
      const kind = String(b.kind || ""), target = String(b.target || "").slice(0, 80);
      if (!b.device_id || !KINDS.includes(kind) || !target) return J({ error: "bad reaction" }, 400);
      if (b.on)
        await db.prepare("INSERT OR IGNORE INTO reactions (device_id,kind,target,created_at) VALUES (?,?,?,?)")
          .bind(b.device_id, kind, target, Date.now()).run();
      else
        await db.prepare("DELETE FROM reactions WHERE device_id = ? AND kind = ? AND target = ?")
          .bind(b.device_id, kind, target).run();
      const c = await db.prepare("SELECT COUNT(*) AS n FROM reactions WHERE kind = ? AND target = ?").bind(kind, target).first();
      return J({ ok: true, count: (c && c.n) || 0 });
    }

    // Everything this phone has liked / saved / followed.
    if (path === "/api/me" && m === "GET") {
      await ensureCols(db);
      const device = url.searchParams.get("device") || "";
      const out = { like: [], save: [], follow: [], clike: [] };
      if (device)
        for (const r of (await db.prepare("SELECT kind, target FROM reactions WHERE device_id = ? LIMIT 5000").bind(device).all()).results || [])
          if (out[r.kind]) out[r.kind].push(r.target);
      return J(out);
    }

    // Real like / follower / comment totals.
    if (path === "/api/counts" && m === "GET") {
      await ensureCols(db);
      const out = { like: {}, follow: {}, comment: {}, share: {} };
      for (const r of (await db.prepare("SELECT kind, target, COUNT(*) AS n FROM reactions WHERE kind IN ('like','follow','share') GROUP BY kind, target LIMIT 3000").all()).results || [])
        out[r.kind][r.target] = r.n;
      for (const r of (await db.prepare("SELECT target, COUNT(*) AS n FROM comments GROUP BY target LIMIT 3000").all()).results || [])
        out.comment[r.target] = r.n;
      return J(out);
    }

    // ---------- COMMENTS ----------
    if (path === "/api/comments" && m === "GET") {
      await ensureCols(db);
      const target = String(url.searchParams.get("target") || "").slice(0, 80), device = url.searchParams.get("device") || "";
      if (!target) return J([]);
      // "likes" leaves out the asking phone's own like; the app adds it back itself.
      const rows = (await db.prepare(
        "SELECT c.*, (SELECT COUNT(*) FROM reactions r WHERE r.kind = 'clike' AND r.target = 'c' || c.id AND r.device_id != ?) AS likes FROM comments c WHERE c.target = ? ORDER BY c.id DESC LIMIT 300"
      ).bind(device, target).all()).results || [];
      return J(rows.reverse().map((r) => ({
        id: r.id, author: r.author || "", text: r.text, parent: r.parent || null,
        created_at: r.created_at, likes: r.likes || 0, mine: !!device && r.device_id === device,
      })));
    }

    if (path === "/api/comments" && m === "POST") {
      await ensureCols(db);
      const b = await body();
      const text = String(b.text || "").trim().slice(0, 500), target = String(b.target || "").slice(0, 80);
      if (!b.device_id || !target || !text) return J({ error: "missing fields" }, 400);
      const recent = await db.prepare("SELECT COUNT(*) AS n FROM comments WHERE device_id = ? AND created_at > ?")
        .bind(b.device_id, Date.now() - 60000).first();
      if (recent && recent.n >= 15) return J({ error: "slow down" }, 429);
      const r = await db.prepare("INSERT INTO comments (target,device_id,author,text,parent,created_at) VALUES (?,?,?,?,?,?)")
        .bind(target, b.device_id, String(b.author || "").trim().slice(0, 30), text, b.parent ? String(b.parent).slice(0, 20) : null, Date.now()).run();
      return J({ ok: true, id: r.meta.last_row_id });
    }

    if (path.startsWith("/api/comments/") && m === "DELETE") {
      await ensureCols(db);
      const id = Number(path.split("/").pop()), device = url.searchParams.get("device") || "";
      const own = await db.prepare("SELECT id FROM comments WHERE id = ? AND device_id = ?").bind(id, device).first();
      if (own) {
        await db.prepare("DELETE FROM comments WHERE id = ? OR parent = ?").bind(id, "c" + id).run();
        await db.prepare("DELETE FROM reactions WHERE kind = 'clike' AND target = ?").bind("c" + id).run();
      }
      return J({ ok: true });
    }

    // ---------- CHAT HISTORY ----------
    if (path === "/api/chats" && m === "GET") {
      await ensureCols(db);
      const device = url.searchParams.get("device") || "";
      if (!device) return J([]);
      const rows = (await db.prepare("SELECT store_id, data, unread, updated_at, draft FROM chats WHERE device_id = ? ORDER BY updated_at DESC LIMIT 100").bind(device).all()).results || [];
      const fresh = Date.now() - 14 * 864e5; // drafts older than two weeks are dropped
      return J(rows.map((r) => ({ store_id: r.store_id, msgs: readJ(r.data, []), unread: r.unread || 0, updated_at: r.updated_at, draft: r.updated_at > fresh ? readJ(r.draft, null) : null })));
    }

    if (path.startsWith("/api/chats/") && m === "PUT") {
      await ensureCols(db);
      const sid = decodeURIComponent(path.split("/").pop()).slice(0, 40), b = await body();
      if (!b.device_id || !sid || !Array.isArray(b.msgs)) return J({ error: "bad chat" }, 400);
      const data = JSON.stringify(b.msgs.slice(-200));
      if (data.length > 300000) return J({ error: "chat too large" }, 413);
      let draft = null;
      try { draft = b.draft && typeof b.draft === "object" ? JSON.stringify(b.draft) : null; } catch (e) {}
      if (draft && draft.length > 20000) draft = null;
      await db.prepare(
        "INSERT INTO chats (device_id,store_id,data,unread,updated_at,draft) VALUES (?,?,?,?,?,?) ON CONFLICT(device_id,store_id) DO UPDATE SET data = excluded.data, unread = excluded.unread, updated_at = excluded.updated_at, draft = excluded.draft"
      ).bind(b.device_id, sid, data, Math.max(0, parseInt(b.unread, 10) || 0), Date.now(), draft).run();
      return J({ ok: true });
    }

    // Shared post link: serve the app (so it opens on that post) with a preview card for chats.
    const pmatch = /^\/post\/([^/]+)\/?$/.exec(path);
    const smatch = /^\/s\/([A-Za-z0-9_-]+)\/?$/.exec(path);
    if ((pmatch || smatch) && m === "GET") {
      let pid, sref = "";
      if (smatch) {
        await ensureCols(db);
        const l = await db.prepare("SELECT pid, ref FROM links WHERE code = ?").bind(smatch[1].toLowerCase()).first();
        if (!l) return Response.redirect(url.origin + "/", 302);
        pid = l.pid; sref = l.ref || "";
      } else pid = decodeURIComponent(pmatch[1]);
      const page = await env.ASSETS.fetch(new Request(url.origin + "/", { method: "GET" }));
      let html = await page.text();
      const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
      let tags = '<base href="/">';
      // Short link: hand the app the normal /post/<id>?ref=<agent> address so it opens on the post and credits the agent.
      if (smatch)
        tags += "<script>try{history.replaceState(null,'','/post/'+encodeURIComponent(" + JSON.stringify(pid).replace(/</g, "\\u003c") +
          ")+'?ref='+encodeURIComponent(" + JSON.stringify(sref).replace(/</g, "\\u003c") + "))}catch(e){}</script>";
      const mm = /^db(\d+)$/.exec(pid);
      if (mm) {
        const pr = await db.prepare("SELECT name, price, img_ids FROM products WHERE id = ?").bind(Number(mm[1])).first();
        if (pr) {
          const first = String(pr.img_ids || "").split(",").filter(Boolean)[0];
          tags += '<meta property="og:type" content="website"><meta property="og:site_name" content="TeQx">' +
            '<meta property="og:title" content="' + esc(pr.name) + '">' +
            '<meta property="og:description" content="Chat with the shop and order securely on TeQx.">' +
            '<meta property="og:url" content="' + esc(url.origin + path) + '">' +
            (first ? '<meta property="og:image" content="' + esc(url.origin + "/api/images/" + Number(first)) + '"><meta name="twitter:card" content="summary_large_image">' : "");
        }
      }
      html = html.replace("<head>", "<head>" + tags);
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, must-revalidate" } });
    }

    const res = await env.ASSETS.fetch(request);
    // Pages must always be re-checked so phones pick up new code straight away.
    if (/\.(html|json)$/.test(path) || path === "/" || !path.includes(".")) {
      const r2 = new Response(res.body, res);
      r2.headers.set("Cache-Control", "no-cache, must-revalidate");
      return r2;
    }
    return res;
  },
};
