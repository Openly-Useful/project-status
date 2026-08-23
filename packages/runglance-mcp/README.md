# RunGlance MCP

<!-- mcp-name: org.openlyuseful/runglance -->

`@openly-useful/runglance-mcp` is the standalone, read-only MCP companion for RunGlance. Its official MCP Registry identity is `org.openlyuseful/runglance`.

The package exposes bounded local views of RunGlance status, active and finished work, usage truth classes, explicit lock state, and verified run receipts. It does not write lifecycle events, run verification commands, refresh the HUD, calculate project readiness, use model calls, or contact a network service.

This package deliberately builds from the canonical implementation in `../mcp/src/runglance-index.ts`. The release contains one bundled `dist/index.js`; no runtime source is copied into a second maintenance tree.

```sh
npm run typecheck
npm run build
npm test
node dist/index.js --help
```

The shared pinned TypeScript/esbuild toolchain under `../mcp` must be present in a source checkout. The published bundle has no runtime dependency installation step.

Nothing in this package authorizes npm publication or MCP Registry submission. External publication remains gated on formation of the planned publisher, explicit publisher authorization, namespace verification, and public policy verification.
