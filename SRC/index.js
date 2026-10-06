const J = (d, s = 200) => Response.json(d, { status: s });

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
            id: p.id, name: p.name, price: p.price, pct: p.pct || 0, stock: p.stock || 0,
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
      const ids = (b.img_ids || []).map(Number).filter(Boolean).slice(0, 5).join(",");
      const r = await db.prepare(
        "INSERT INTO products (store_id,name,price,pct,stock,img_ids) VALUES (?,?,?,?,?,?)"
      ).bind(
        b.store_id, String(b.name).slice(0, 80), price,
        parseInt(b.pct, 10) || 0, parseInt(b.stock, 10) || 0, ids
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
      await db.prepare(
        "INSERT OR IGNORE INTO orders (id, device_id, store_id, item, price, fee, status, station) VALUES (?,?,?,?,?,?,?,?)"
      ).bind(o.id, o.device_id, o.store_id || null, o.item || "", o.price || 0, o.fee || 0, o.status || "Secured", o.station || null).run();
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
