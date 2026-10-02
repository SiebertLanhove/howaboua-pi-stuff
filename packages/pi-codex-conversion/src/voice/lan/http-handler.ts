import type { IncomingMessage, ServerResponse } from "node:http";
import { REALTIME_V3_VOICES, type RealtimeV3Voice } from "../../adapter/activation/config-contract.ts";
import type { LanVoiceBrowserClients } from "./browser-clients.ts";
import type { LanVoiceActivity } from "./activity.ts";
import { getLanVoiceAppAsset } from "./app-assets.ts";
import { LanVoiceDraftError, type LanVoiceDraft } from "./draft.ts";

const MAX_REQUEST_BYTES = 300 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export interface LanVoiceHttpHandlers {
	activity: LanVoiceActivity;
	clients: LanVoiceBrowserClients;
	draft: LanVoiceDraft;
	renderManifest(): string;
	renderPage(): string;
	inputMuted(): boolean;
	ownerIsActive(): boolean;
	ownerSessionId: string;
	selectNextVoice(voice: RealtimeV3Voice | undefined): boolean;
	readonly closing: boolean;
}

export async function handleLanVoiceHttpRequest(
	request: IncomingMessage,
	response: ServerResponse,
	handlers: LanVoiceHttpHandlers,
): Promise<void> {
	let path = "/";
	try {
		const url = new URL(request.url ?? "/", "https://lan-voice.local");
		path = url.pathname;
		if (request.method === "GET" && path === "/") {
			sendText(response, "text/html; charset=utf-8", handlers.renderPage(), true);
			return;
		}
		if (request.method === "GET" && path === "/manifest.webmanifest") {
			sendText(response, "application/manifest+json; charset=utf-8", handlers.renderManifest());
			return;
		}
		const appAsset = request.method === "GET" ? getLanVoiceAppAsset(path) : undefined;
		if (appAsset) {
			sendBinary(response, appAsset.contentType, appAsset.body);
			return;
		}
		if (!handlers.ownerIsActive() || handlers.closing) {
			sendJson(response, 409, { error: "The Pi session that started this voice server is no longer active" });
			return;
		}
		if (request.method === "GET" && path === "/api/events") {
			const clientId = boundedString(url.searchParams.get("client"), 128);
			if (!clientId) throw new LanVoiceRequestError(400, "A browser client ID is required");
			response.writeHead(200, {
				"cache-control": "no-store",
				connection: "keep-alive",
				"content-type": "text/event-stream; charset=utf-8",
				"x-accel-buffering": "no",
			});
			response.write("event: ready\ndata: {}\n\n");
			handlers.clients.connectEvents(clientId, response);
			handlers.clients.sendControl(clientId, handlers.draft.snapshot());
			handlers.clients.sendControl(clientId, handlers.activity.snapshot());
			handlers.clients.sendControl(clientId, { type: "mute", muted: handlers.inputMuted() });
			return;
		}
		if (request.method !== "POST") {
			sendJson(response, 404, { error: "Not found" });
			return;
		}
		if (path === "/api/next-call-voice" && !LOOPBACK_HOSTS.has(String(request.socket.remoteAddress || "").toLowerCase()))
			throw new LanVoiceRequestError(403, "Call voice selection is loopback-only");
		assertJsonPost(request);
		const body = await readJson(request);
		if (!handlers.ownerIsActive() || handlers.closing) {
			sendJson(response, 409, { error: "The Pi session that started this voice server is no longer active" });
			return;
		}
		if (path === "/api/next-call-voice") {
			if (body["ownerSessionId"] !== handlers.ownerSessionId)
				throw new LanVoiceRequestError(409, "Call voice owner does not match the voice server owner");
			const voice = body["voice"];
			if (voice !== null && !REALTIME_V3_VOICES.includes(voice as RealtimeV3Voice))
				throw new LanVoiceRequestError(400, "Invalid realtime voice");
			if (!handlers.selectNextVoice(voice === null ? undefined : voice as RealtimeV3Voice))
				throw new LanVoiceRequestError(409, "Voice is fixed for an active or starting call");
			sendJson(response, 200, { ok: true, voice, appliesTo: "next_call" });
			return;
		}
		const clientId = requiredClientId(body);
		if (path === "/api/stop") {
			handlers.clients.release(clientId, undefined, body["terminateConversation"] === true);
			sendJson(response, 200, { ok: true });
			return;
		}
		if (path === "/api/draft") {
			const revision = handlers.draft.update(clientId, body["text"], body["revision"]);
			sendJson(response, 200, { ok: true, revision });
			return;
		}
		if (path === "/api/send") {
			handlers.draft.send(clientId, body["text"], body["revision"]);
			sendJson(response, 200, { ok: true });
			return;
		}
		sendJson(response, 404, { error: "Not found" });
	} catch (error) {
		const status = error instanceof LanVoiceRequestError ? error.status : error instanceof LanVoiceDraftError ? 400 : 500;
		if (!response.headersSent) sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
		else response.end();
	}
}

export function boundedString(value: unknown, maxBytes: number): string | undefined {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maxBytes ? value : undefined;
}

export function isLanVoiceOriginAllowed(request: IncomingMessage): boolean {
	const { origin, host } = request.headers;
	// Browsers send Origin; non-browser clients retain trusted-LAN access.
	return origin === undefined || (host !== undefined && origin === `https://${host}`);
}

class LanVoiceRequestError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.byteLength;
		if (bytes > MAX_REQUEST_BYTES) throw new LanVoiceRequestError(413, "LAN voice request is too large");
		chunks.push(buffer);
	}
	try {
		const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
		return value as Record<string, unknown>;
	} catch {
		throw new LanVoiceRequestError(400, "LAN voice request must be a JSON object");
	}
}

function requiredClientId(body: Record<string, unknown>): string {
	const clientId = boundedString(body["clientId"], 128);
	if (!clientId) throw new LanVoiceRequestError(400, "A browser client ID is required");
	return clientId;
}

function sendText(response: ServerResponse, contentType: string, body: string, html = false): void {
	response.writeHead(200, {
		"cache-control": "no-store",
		"content-type": contentType,
		"x-content-type-options": "nosniff",
		...(html ? {
			"content-security-policy": "default-src 'self'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; connect-src 'self' wss:; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
			"permissions-policy": "microphone=(self), camera=()",
		} : {}),
	});
	response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, {
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
		"x-content-type-options": "nosniff",
	});
	response.end(JSON.stringify(value));
}

function sendBinary(response: ServerResponse, contentType: string, body: Buffer): void {
	response.writeHead(200, {
		"cache-control": "public, max-age=86400",
		"content-length": body.byteLength,
		"content-type": contentType,
		"x-content-type-options": "nosniff",
	});
	response.end(body);
}

function assertJsonPost(request: IncomingMessage): void {
	const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
	if (contentType !== "application/json")
		throw new LanVoiceRequestError(415, "GipPity requests must use application/json");
	if (!isLanVoiceOriginAllowed(request))
		throw new LanVoiceRequestError(403, "Cross-origin GipPity requests are not allowed");
}
