export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/ping") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/stores") {
      const stores = (await env.DB.prepare("SELECT * FROM stores").all()).results;
      const prods = (await env.DB.prepare("SELECT * FROM products ORDER BY id").all()).results;
      const data = stores.map((s) => ({
        ...s,
        prods: prods.filter((p) => p.store_id === s.id).map((p) => [p.name, p.price]),
      }));
      return Response.json(data);
    }

    return env.ASSETS.fetch(request);
  },
};
