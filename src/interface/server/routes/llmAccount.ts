import { Router } from "express";
import { z } from "zod";
import type { ConnectedLlmAccount } from "../../../engine/llm/account.js";
import { saveAccount, clearAccount } from "../../../engine/llm/account.js";
import type { LlmProviderHolder } from "../../../engine/drift/effectList/providerHolder.js";
import type { ResolvedLlmProvider } from "../resolveLlmProvider.js";
import type { LlmAccountState } from "../llmAccountState.js";
import { localOnly } from "../middleware/localOnly.js";
import { requireAdminHeader } from "../middleware/requireAdminHeader.js";
import { validateBody } from "../middleware/validation.js";

const ConnectSchema = z.object({
	provider: z.enum(["anthropic", "gemini"]),
	apiKey: z.string().min(1),
});

// Minimal, cheap calls used to confirm a submitted key actually works before it's
// persisted or swapped in. Without this, a bad key would fail silently later — per-PR
// effect-extraction failures are swallowed and the pipeline continues (see
// buildBundles()'s extractionFailures), so a typo'd key would look like "nothing happens"
// instead of a clear error on the connect screen. Both complete() and embed() are checked
// since a key can be scoped/restricted to allow one but not the other (e.g. a Gemini key
// permitted to call generateContent but not embedContent) — checking only complete()
// would let such a key pass here and only fail later, deep inside real bundle clustering.
// Anthropic's embed() is a hardcoded no-op returning [] (see anthropicProvider.ts), so
// this costs nothing extra for that provider.
async function verifyProviderWorks(resolved: ResolvedLlmProvider): Promise<void> {
	await Promise.all([
		resolved.provider.complete([{ role: "user", content: "ping" }], { maxTokens: 1 }),
		resolved.provider.embed("ping"),
	]);
}

export function llmAccountRouter(
	llmAccountState: LlmAccountState,
	accountPath: string,
	llmProviderHolder: LlmProviderHolder,
	buildProvider: (account: ConnectedLlmAccount) => ResolvedLlmProvider,
	resolveFallback: () => ResolvedLlmProvider,
): Router {
	const router = Router();

	// Serializes connect attempts: without this, two concurrent POST /connect requests
	// (a double-click, or a client retry racing the original) could interleave their
	// holder swap / state assignment / file write, leaving the in-memory provider and the
	// persisted account describing two different keys until the next restart.
	let connectInFlight: Promise<void> = Promise.resolve();

	router.get("/status", (_req, res) => {
		const account = llmAccountState.current;
		if (account === undefined) {
			res.json({ connected: false });
			return;
		}
		res.json({ connected: true, provider: account.provider, connectedAt: account.connectedAt });
	});

	router.post("/connect", localOnly, requireAdminHeader, validateBody(ConnectSchema), async (req, res, next) => {
		const previous = connectInFlight;
		let release!: () => void;
		connectInFlight = new Promise((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			const { provider, apiKey } = req.body as z.infer<typeof ConnectSchema>;
			const account: ConnectedLlmAccount = { provider, apiKey, connectedAt: new Date().toISOString() };
			const candidate = buildProvider(account);

			try {
				await verifyProviderWorks(candidate);
			} catch (err) {
				res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
				return;
			}

			// Persist before swapping in the new provider: if saveAccount() throws (disk
			// full, permissions), nothing in memory has changed yet, so the error response
			// below matches reality instead of the pipeline silently running an unpersisted
			// key that a later restart would revert without warning.
			await saveAccount(accountPath, account);
			llmProviderHolder.setProvider(candidate.provider);
			llmAccountState.current = account;

			res.json({ connected: true, provider: account.provider, connectedAt: account.connectedAt });
		} catch (err) {
			next(err);
		} finally {
			release();
		}
	});

	router.post("/disconnect", localOnly, requireAdminHeader, async (_req, res, next) => {
		try {
			// Resolve the fallback before mutating any state: if it throws (e.g. a stale
			// LLM_PROVIDER env var with no matching key set), nothing has changed yet, so
			// the holder/state/disk stay consistent instead of the account being cleared
			// while the holder is left silently serving the just-revoked provider.
			const fallback = resolveFallback();
			llmAccountState.current = undefined;
			await clearAccount(accountPath);
			llmProviderHolder.setProvider(fallback.provider);
			res.json({ connected: false });
		} catch (err) {
			next(err);
		}
	});

	return router;
}
