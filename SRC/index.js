export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ping") {
      return Response.json({ ok: true });
    }
    return env.ASSETS.fetch(request);
  },
};
