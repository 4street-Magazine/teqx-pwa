const J = (d, s = 200) => Response.json(d, { status: s });

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
  for (const c of ["author_name", "author_icon", "author_img"])
    if (!pc.has(c)) await db.prepare("ALTER TABLE posts ADD COLUMN " + c + " TEXT").run();
  const oc = new Set(((await db.prepare("PRAGMA table_info(orders)").all()).results || []).map((c) => c.name));
  for (const [c, t] of [["ds_device", "TEXT"], ["post_id", "INTEGER"], ["comm", "INTEGER"], ["qty", "INTEGER"]])
    if (!oc.has(c)) await db.prepare("ALTER TABLE orders ADD COLUMN " + c + " " + t).run();
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

// Take bought quantities off stock. lines = [{ name, opt: "Size: M, Color: Black", qty }]
const takeStock = async (db, storeId, lines) => {
  for (const ln of lines.slice(0, 30)) {
    const qty = Math.min(99, Math.max(1, parseInt(ln && ln.qty, 10) || 1));
    const p = await db.prepare("SELECT * FROM products WHERE store_id = ? AND name = ?")
      .bind(storeId, String((ln && ln.name) || "")).first();
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
        id: r.id, store_id: r.store_id, pid: r.pid, name: r.name, price: r.price, pct: r.pct || 0,
        caption: r.caption || "", imgs: readJ(r.imgs, []), created_at: r.created_at,
        author_name: r.author_name || "", author_icon: r.author_icon || "", author_img: r.author_img || "",
        mine: !!device && r.device_id === device,
      })));
    }

    if (path === "/api/posts" && m === "POST") {
      await ensureCols(db);
      const b = await body();
      if (!b.device_id || !b.store_id || !b.name) return J({ error: "missing fields" }, 400);
      let pct = Math.max(0, Math.min(60, parseInt(b.pct, 10) || 0));
      let price = parseInt(b.price, 10) || 0;
      let name = String(b.name).slice(0, 80);
      const mm = /^db(\d+)$/.exec(String(b.pid || ""));
      if (mm) {
        // A real merchant product: trust the server for its name, price and commission.
        const pr = await db.prepare("SELECT store_id, name, price, pct FROM products WHERE id = ?").bind(Number(mm[1])).first();
        if (!pr || pr.store_id !== b.store_id) return J({ error: "unknown product" }, 400);
        pct = pr.pct || 0; price = pr.price; name = pr.name;
      }
      const imgs = cleanImgs(b.imgs);
      if (!(price > 0) || !imgs.length) return J({ error: "price and a photo are required" }, 400);
      const r = await db.prepare(
        "INSERT INTO posts (device_id,store_id,pid,name,price,pct,caption,imgs,created_at,author_name,author_icon,author_img) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(b.device_id, b.store_id, String(b.pid || "").slice(0, 40), name, price, pct,
        String(b.caption || "").slice(0, 500), JSON.stringify(imgs), Date.now(),
        String(b.author_name || "").slice(0, 40), String(b.author_icon || "").slice(0, 8), cleanImgs([b.author_img])[0] || "").run();
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
      return J(stores.map((s) => {
        const mine = prods.filter((p) => p.store_id === s.id);
        return {
          id: s.id, name: s.name, tag: s.tag, icon: s.icon, category: s.category,
          img: s.img, open: s.open !== 0,
          mine: !!device && s.owner_device === device,
          prods: mine.map((p) => [p.name, p.price]),
          items: mine.map((p) => ({
            id: p.id, name: p.name, price: p.price, pct: p.pct || 0, stock: p.stock || 0, attrs: readAttrs(p.attrs),
            variants: readJ(p.variants, []), cimg: readJ(p.cimg, {}), specs: readJ(p.specs, {}), category: p.category || "", description: p.description || "", moq: p.moq || 0,
            imgs: (p.img_ids || "").split(",").filter(Boolean).map((i) => "/api/images/" + i),
          })),
        };
      }));
    }

    if (path === "/api/stores" && m === "POST") {
      const b = await body();
      if (!b.device_id || !b.name) return J({ error: "name and device_id required" }, 400);
      const ex = await db.prepare("SELECT id FROM stores WHERE owner_device = ?").bind(b.device_id).first();
      if (ex) return J({ ok: true, id: ex.id, existing: true });
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
      const id = path.split("/").pop();
      const b = await body();
      const img = b.img_id ? "/api/images/" + Number(b.img_id) : null;
      await db.prepare(
        "UPDATE stores SET name=COALESCE(?,name), icon=COALESCE(?,icon), img=COALESCE(?,img), open=COALESCE(?,open) WHERE id=? AND owner_device=?"
      ).bind(
        b.name ? String(b.name).slice(0, 40) : null,
        b.icon ? String(b.icon).slice(0, 8) : null,
        img,
        b.open === undefined ? null : (b.open ? 1 : 0),
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
        parseInt(b.pct, 10) || 0, t.stock, ids, JSON.stringify(attrs),
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
      const b = await body();
      if (!b.device_id || typeof b.data !== "string" || !b.data.startsWith("data:image/"))
        return J({ error: "bad image" }, 400);
      if (b.data.length > 400000) return J({ error: "image too large" }, 413);
      const c = await db.prepare("SELECT COUNT(*) AS n FROM images WHERE owner_device = ?").bind(b.device_id).first();
      if (c && c.n >= 100) return J({ error: "image limit reached" }, 429);
      const r = await db.prepare("INSERT INTO images (owner_device,data) VALUES (?,?)").bind(b.device_id, b.data).run();
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
          comm = Math.round((base * (po.pct || 0)) / 100);
          qty = q || 1;
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

    return env.ASSETS.fetch(request);
  },
};
