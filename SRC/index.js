const J = (d, s = 200) => Response.json(d, { status: s });

const cleanAttrs = (a) =>
  (Array.isArray(a) ? a : [])
    .map((x) => ({
      k: String((x && x.k) || "").trim().slice(0, 20),
      v: (Array.isArray(x && x.v) ? x.v : []).map((y) => String(y).trim().slice(0, 20)).filter(Boolean).slice(0, 12),
    }))
    .filter((x) => x.k && x.v.length)
    .slice(0, 6);

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

    // ---------- STORES ----------
    if (path === "/api/stores" && m === "GET") {
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
      const b = await body();
      const st = await db.prepare("SELECT owner_device FROM stores WHERE id = ?").bind(b.store_id || "").first();
      if (!st || !b.device_id || st.owner_device !== b.device_id) return J({ error: "not your shop" }, 403);
      const price = parseInt(b.price, 10);
      if (!b.name || !(price > 0)) return J({ error: "name and price required" }, 400);
      const attrs = cleanAttrs(b.attrs);
      if (!attrs.length) return J({ error: "at least one attribute required" }, 400);
      const ids = (b.img_ids || []).map(Number).filter(Boolean).slice(0, 5).join(",");
      const r = await db.prepare(
        "INSERT INTO products (store_id,name,price,pct,stock,img_ids,attrs) VALUES (?,?,?,?,?,?,?)"
      ).bind(
        b.store_id, String(b.name).slice(0, 80), price,
        parseInt(b.pct, 10) || 0, parseInt(b.stock, 10) || 0, ids, JSON.stringify(attrs)
      ).run();
      return J({ ok: true, id: r.meta.last_row_id });
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
      const device = url.searchParams.get("device");
      if (!device) return J([]);
      const rows = (await db.prepare("SELECT * FROM orders WHERE device_id = ? ORDER BY created_at DESC").bind(device).all()).results;
      return J(rows);
    }

    if (path === "/api/orders" && m === "POST") {
      const o = await body();
      if (!o.id || !o.device_id) return J({ error: "missing id or device_id" }, 400);
      let paid = 0;
      if (o.tx_ref) {
        const u = await db.prepare(
          "UPDATE payments SET order_id = ? WHERE tx_ref = ? AND device_id = ? AND status = 'successful' AND order_id IS NULL AND amount >= ?"
        ).bind(o.id, o.tx_ref, o.device_id, (o.price || 0) + (o.fee || 0)).run();
        if (!u.meta.changes) return J({ error: "payment not valid" }, 402);
        paid = 1;
      }
      await db.prepare(
        "INSERT OR IGNORE INTO orders (id, device_id, store_id, item, price, fee, status, station, tx_ref, paid) VALUES (?,?,?,?,?,?,?,?,?,?)"
      ).bind(o.id, o.device_id, o.store_id || null, o.item || "", o.price || 0, o.fee || 0, o.status || "Secured", o.station || null, o.tx_ref || null, paid).run();
      return J({ ok: true });
    }

    if (path.startsWith("/api/orders/") && m === "PATCH") {
      const id = path.split("/").pop();
      const o = await body();
      await db.prepare(
        "UPDATE orders SET status = COALESCE(?, status), station = COALESCE(?, station) WHERE id = ? AND device_id = ?"
      ).bind(o.status || null, o.station || null, id, o.device_id).run();
      return J({ ok: true });
    }

    return env.ASSETS.fetch(request);
  },
};
                                                                      
