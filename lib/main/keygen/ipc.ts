import * as v from "valibot";
import { asKeygenError, licenseErr } from "../../shared/keygen-error.ts";
import { KEYGEN_CHANNELS, type IpcResult, type KeygenChannelName } from "../../shared/keygen-types.ts";
import type { LicensingService } from "./service.ts";

/**
 * IPC surface. Every channel:
 * 1. rejects senders that are not the trusted application window's main frame,
 * 2. validates arguments against a valibot schema (nothing from the renderer
 *    reaches the licensing service unchecked),
 * 3. returns an envelope so KeygenError code/detail survive structured clone.
 */

export type IpcMainLike = {
	handle(
		channel: string,
		listener: (event: unknown, ...args: unknown[]) => Promise<IpcResult<unknown>>,
	): void;
};

const emptyArgs = v.tuple([]);

const validateKeyArgs = v.tuple([
	v.object({
		key: v.string(),
		entitlements: v.optional(v.array(v.string())),
		cacheValidResponse: v.optional(v.boolean()),
	}),
]);

const checkoutArgs = v.tuple([
	v.object({
		key: v.string(),
		entitlements: v.optional(v.array(v.string())),
		ttlSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
		ttlForever: v.optional(v.boolean()),
	}),
]);

type ChannelDef = {
	schema: v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>;
	run: (service: LicensingService, ...args: unknown[]) => unknown;
};

const channelDefs: Record<KeygenChannelName, ChannelDef> = {
	[KEYGEN_CHANNELS.getLicense]: { schema: emptyArgs, run: (s) => s.getLicense() },
	[KEYGEN_CHANNELS.getLicenseKey]: { schema: emptyArgs, run: (s) => s.getLicenseKey() },
	[KEYGEN_CHANNELS.validateKey]: {
		schema: validateKeyArgs,
		run: (s, options) => s.validateKey(options as Parameters<LicensingService["validateKey"]>[0]),
	},
	[KEYGEN_CHANNELS.validateCheckoutKey]: {
		schema: checkoutArgs,
		run: (s, options) =>
			s.validateCheckoutKey(options as Parameters<LicensingService["validateCheckoutKey"]>[0]),
	},
	[KEYGEN_CHANNELS.resetLicense]: { schema: emptyArgs, run: (s) => s.resetLicense() },
	[KEYGEN_CHANNELS.resetLicenseKey]: { schema: emptyArgs, run: (s) => s.resetLicenseKey() },
};

export function registerKeygenIpc(
	ipc: IpcMainLike,
	getService: () => LicensingService | null,
	isTrustedSender: (event: unknown) => boolean,
): void {
	for (const channel of Object.values(KEYGEN_CHANNELS)) {
		const def = channelDefs[channel];
		ipc.handle(channel, async (event, ...args) => {
			try {
				if (!isTrustedSender(event)) {
					throw licenseErr("UNTRUSTED_SENDER", "Request rejected: untrusted IPC sender");
				}
				const service = getService();
				if (service === null) {
					throw licenseErr("LICENSING_DISABLED", "Licensing is not configured in this build");
				}
				const parsed = v.parse(def.schema, args) as [unknown];
				const data = await def.run(service, parsed[0]);
				return { ok: true, data: data ?? null } as IpcResult<unknown>;
			} catch (err) {
				return { ok: false, error: asKeygenError(err).toSummary() };
			}
		});
	}
}

/** Real sender policy for the Electron app, kept out of the pure module. */
export function makeWindowTrustChecker(getTrustedWebContentsIds: () => number[]) {
	return (event: unknown): boolean => {
		const e = event as {
			sender?: { id?: number; mainFrame?: unknown };
			senderFrame?: unknown;
		};
		if (!e?.sender || typeof e.sender.id !== "number") return false;
		if (!getTrustedWebContentsIds().includes(e.sender.id)) return false;
		// main frame only: iframes in the window get no licensing access
		return e.senderFrame !== undefined && e.senderFrame === e.sender.mainFrame;
	};
}
