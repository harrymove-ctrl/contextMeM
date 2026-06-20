/**
 * Bun preload: stub Cloudflare Workers virtual modules (`cloudflare:workers`,
 * `cloudflare:email`) so the worker module (which transitively imports `agents`)
 * can be loaded under plain Bun for the Harbor wiring smoke test. These symbols
 * are never exercised by storeNamespaceImport / readArtifact — they only need to
 * resolve at import-link time. Test-only; not shipped to the Worker.
 */
import { plugin } from "bun";

plugin({
  name: "cf-virtual-stubs",
  setup(build) {
    build.module("cloudflare:workers", () => ({
      loader: "object",
      exports: {
        DurableObject: class DurableObject {},
        WorkflowEntrypoint: class WorkflowEntrypoint {},
        RpcTarget: class RpcTarget {},
        WorkerEntrypoint: class WorkerEntrypoint {},
        exports: {},
        env: {},
      },
    }));
    build.module("cloudflare:email", () => ({
      loader: "object",
      exports: { EmailMessage: class EmailMessage {} },
    }));
    build.module("cloudflare:sockets", () => ({
      loader: "object",
      exports: { connect: () => { throw new Error("cloudflare:sockets stub"); } },
    }));
  },
});
