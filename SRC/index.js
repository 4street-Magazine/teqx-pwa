const J = (d, s = 200) => Response.json(d, { status: s });

const cleanAttrs = (a) =>
  (Array.isArray(a) ? a : [])
    .map((x) => ({
      k: String((x && x.k) || "").trim().slice(0, 20),
      v: (Array.isArray(x && x.v) ? x.v : []).map((y) => String(y).trim().slice(0, 20)).filter(Boolean).slice(0, 12),
    }))
    .filter((x) => x.k && x.v.length)
    .slice(0, 6);

const FLW = "https://api.flutterwave.com/v3";

const normPhone = (p) => {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("0")) d = "254" + d.slice(1);
  else if (/^[17]\d{8}$/.test(d)) d = "254" + d;
  return /^254[17]\d{8}$/.test(d) ? d : null;
};

const flw = (env, path, init = {}) =>
  fetch(FLW + path, {
    ...init,
    headers: { Authorization: "Bearer " + env.FLW_SECRET_KEY, "Content-Type": "application/json" },
  }).then((r) => r.json());

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

    // ---------- PAYMENTS (Flutterwave M-Pesa) ----------
    if (path === "/api/pay" && m === "POST") {
      if (!env.FLW_SECRET_KEY) return J({ error: "Payments are not set up yet" }, 503);
      const b = await body();
      const phone = normPhone(b.phone);
      const amount = parseInt(b.amount, 10);
      if (!b.device_id || !phone) return J({ error: "Enter a valid M-Pesa number" }, 400);
      if (!(amount >= 10 && amount <= 250000)) return J({ error: "Invalid amount" }, 400);
      const tx_ref = "TQP-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      let r;
      try {
        r = await flw(env, "/charges?type=mpesa", {
          method: "POST",
          body: JSON.stringify({
            phone_number: phone, amount, currency: "KES",
            email: "buyer+" + phone + "@teqx.app", fullname: "TeQx Customer", tx_ref,
          }),
        });
      } catch (e) {
        return J({ error: "Could not reach the payment provider" }, 502);
      }
      if (!r || r.status !== "success" || !r.data) return J({ error: (r && r.message) || "Payment could not be started" }, 400);
      await db.prepare(
        "INSERT INTO payments (tx_ref, flw_id, device_id, phone, amount, status) VALUES (?,?,?,?,?,'pending')"
      ).bind(tx_ref, String(r.data.id), b.device_id, phone, amount).run();
      return J({ ok: true, tx_ref });
    }

    if (path === "/api/pay/status" && m === "GET") {
      const tx = url.searchParams.get("tx_ref") || "";
      const device = url.searchParams.get("device") || "";
      const p = await db.prepare("SELECT * FROM payments WHERE tx_ref = ? AND device_id = ?").bind(tx, device).first();
      if (!p) return J({ status: "unknown" }, 404);
      if (p.status === "pending" && env.FLW_SECRET_KEY) {
        try {
          const v = await flw(env, "/transactions/" + p.flw_id + "/verify");
          const d = v && v.data;
          if (d && d.tx_ref === p.tx_ref) {
            if (d.status === "successful" && d.currency === "KES" && Number(d.amount) >= p.amount) {
              await db.prepare("UPDATE payments SET status = 'successful' WHERE tx_ref = ?").bind(tx).run();
              return J({ status: "successful" });
            }
            if (d.status === "failed") {
              await db.prepare("UPDATE payments SET status = 'failed' WHERE tx_ref = ?").bind(tx).run();
              return J({ status: "failed" });
            }
          }
        } catch (e) {}
      }
      return J({ status: p.status });
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
