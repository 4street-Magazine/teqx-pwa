export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/ping") {
      return Response.json({ ok: true });
    }

    if (path === "/api/stores") {
      const stores = (await env.DB.prepare("SELECT * FROM stores").all()).results;
      const prods = (await env.DB.prepare("SELECT * FROM products ORDER BY id").all()).results;
      const data = stores.map((s) => ({
        ...s,
        prods: prods.filter((p) => p.store_id === s.id).map((p) => [p.name, p.price]),
      }));
      return Response.json(data);
    }

    if (path === "/api/orders" && request.method === "GET") {
      const device = url.searchParams.get("device");
      if (!device) return Response.json([]);
      const rows = (
        await env.DB.prepare("SELECT * FROM orders WHERE device_id = ? ORDER BY created_at DESC")
          .bind(device)
          .all()
      ).results;
      return Response.json(rows);
    }

    if (path === "/api/orders" && request.method === "POST") {
      const o = await request.json();
      if (!o.id || !o.device_id) {
        return Response.json({ error: "missing id or device_id" }, { status: 400 });
      }
      await env.DB.prepare(
        "INSERT OR IGNORE INTO orders (id, device_id, store_id, item, price, fee, status, station) VALUES (?,?,?,?,?,?,?,?)"
      )
        .bind(o.id, o.device_id, o.store_id || null, o.item || "", o.price || 0, o.fee || 0, o.status || "Secured", o.station || null)
        .run();
      return Response.json({ ok: true });
    }

    if (path.startsWith("/api/orders/") && request.method === "PATCH") {
      const id = path.split("/").pop();
      const o = await request.json();
      await env.DB.prepare(
        "UPDATE orders SET status = COALESCE(?, status), station = COALESCE(?, station) WHERE id = ? AND device_id = ?"
      )
        .bind(o.status || null, o.station || null, id, o.device_id)
        .run();
      return Response.json({ ok: true });
    }

    return env.ASSETS.fetch(request);
  },
};
