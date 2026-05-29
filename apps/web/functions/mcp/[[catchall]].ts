const WORKER_ORIGIN = "https://contextmem-hosted-namespace-mcp.petlofi.workers.dev";

export const onRequest: PagesFunction = async (context) => {
  const incoming = new URL(context.request.url);
  const target = new URL(`${WORKER_ORIGIN}${incoming.pathname}${incoming.search}`);
  const init: RequestInit = {
    method: context.request.method,
    headers: context.request.headers,
    body: ["GET", "HEAD"].includes(context.request.method) ? undefined : context.request.body,
    redirect: "manual"
  };
  const response = await fetch(target.toString(), init);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
};
