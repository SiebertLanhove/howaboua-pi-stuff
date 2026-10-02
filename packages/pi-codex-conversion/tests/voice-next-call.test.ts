import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { WebSocket } from "ws";
import { DEFAULT_CODEX_CONVERSION_CONFIG, REALTIME_V3_VOICES } from "../src/adapter/activation/config-contract.ts";
import { buildRealtimeCallRequest } from "../src/voice/conversation/call-setup.ts";
import { handleLanVoiceHttpRequest, type LanVoiceHttpHandlers } from "../src/voice/lan/http-handler.ts";
import { startCodexLanVoiceServer } from "../src/voice/lan/server.ts";

async function select(body: unknown, options: { remote?: string; active?: boolean; idle?: boolean; raw?: string } = {}) {
	let selected: unknown = "unchanged", status = 0, result: unknown;
	const req = Readable.from([options.raw ?? JSON.stringify(body)]) as IncomingMessage;
	Object.assign(req, { method: "POST", url: "/api/next-call-voice", headers: { "content-type": "application/json" }, socket: { remoteAddress: options.remote ?? "127.0.0.1" } });
	const res = {
		writeHead(value: number) { status = value; },
		end(value: string) { result = JSON.parse(value); },
	} as ServerResponse;
	await handleLanVoiceHttpRequest(req, res, {
		ownerSessionId: "owner", ownerIsActive: () => options.active !== false,
		closing: false,
		selectNextVoice: (voice) => { if (options.idle === false) return false; selected = voice; return true; },
	} as LanVoiceHttpHandlers);
	return { status, selected, result };
}

test("all supported names are admitted, with an explicit next-call receipt", async () => {
	for (const voice of REALTIME_V3_VOICES) assert.deepEqual(await select({ ownerSessionId: "owner", voice }), {
		status: 200, selected: voice, result: { ok: true, voice, appliesTo: "next_call" },
	});
});

test("null clears the pending override", async () => {
	assert.equal((await select({ ownerSessionId: "owner", voice: null })).selected, undefined);
});

test("unknown, absent and non-string voices do not change the pending override", async () => {
	for (const voice of ["alloy", "Maple", " maple ", "", undefined, {}, [], 1, true]) {
		const result = await select({ ownerSessionId: "owner", voice });
		assert.equal(result.status, 400);
		assert.equal(result.selected, "unchanged");
	}
});

test("remote callers are rejected before malformed body parsing", async () => {
	const result = await select({}, { remote: "192.0.2.1", raw: "{" });
	assert.equal(result.status, 403);
	assert.equal(result.selected, "unchanged");
});

test("stale and incorrect owners are rejected", async () => {
	for (const body of [{ voice: "maple" }, { ownerSessionId: "other", voice: "maple" }]) assert.equal((await select(body)).status, 409);
	assert.equal((await select({ ownerSessionId: "owner", voice: "maple" }, { active: false })).status, 409);
});

test("active or starting calls cannot accept a voice change or reset", async () => {
	for (const voice of ["maple", null]) {
		const result = await select({ ownerSessionId: "owner", voice }, { idle: false });
		assert.equal(result.status, 409);
		assert.equal(result.selected, "unchanged");
	}
});

test("malformed loopback bodies are rejected", async () => {
	assert.equal((await select({}, { raw: "{" })).status, 400);
});

test("server consumes one voice snapshot into the startup payload without mutating config", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-next-call-voice-"));
	const config = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
	const before = structuredClone(config);
	const payloads: ReturnType<typeof buildRealtimeCallRequest>[] = [];
	let finishStart: () => void = () => {};
	let began: () => void = () => {};
	const server = await startCodexLanVoiceServer({
		ctx: { isIdle: () => true, sessionManager: { getSessionId: () => "owner" } } as never,
		getConfig: () => config,
		voice: {
			onInputMuteChange: () => () => {},
			async startRealtimeWithPeerPlan(_ctx: unknown, snapshot: typeof config) {
				payloads.push(buildRealtimeCallRequest("sdp", snapshot, "instructions"));
				const pending = new Promise<void>((resolve) => { finishStart = resolve; });
				began();
				await pending;
				return false; // No provider or audio required for the payload test.
			},
		} as never,
		resolveAuth: async () => ({}) as never, sendUserMessage: () => {},
		ownerSessionId: "owner", port: 0, certificateAgentDir: dir,
	});
	const sockets: WebSocket[] = [];
	try {
		const url = new URL(server.urls[0]!);
		url.hostname = "127.0.0.1";
		const post = (voice: string | null) => new Promise<number>((resolve, reject) => {
			const req = request(new URL("/api/next-call-voice", url), { method: "POST", rejectUnauthorized: false, headers: { "content-type": "application/json" } }, (res) => {
				res.resume(); res.on("end", () => resolve(res.statusCode!));
			});
			req.on("error", reject);
			req.end(JSON.stringify({ ownerSessionId: "owner", voice }));
		});
		assert.equal(await post("maple"), 200);
		for (const [index, expectedVoice] of ["maple", "cove"].entries()) {
			const started = new Promise<void>((resolve) => { began = resolve; });
			const audio = new URL(`/api/audio?client=test-${index}`, url);
			audio.protocol = "wss:";
			const socket = new WebSocket(audio, { rejectUnauthorized: false });
			sockets.push(socket);
			await once(socket, "open");
			const errored = new Promise<void>((resolve) => { socket.on("message", (raw) => { if (JSON.parse(String(raw)).type === "error") resolve(); }); });
			socket.send(JSON.stringify({ type: "start", mode: "conversation" }));
			await started;
			assert.equal(payloads[index]!.session.audio.output.voice, expectedVoice);
			assert.equal(await post("ember"), 409);
			assert.equal(await post(null), 409);
			finishStart();
			await errored;
			socket.close();
			await once(socket, "close");
		}
		assert.deepEqual(config, before);
	} finally {
		finishStart();
		for (const socket of sockets) socket.terminate();
		await server.close();
		await rm(dir, { recursive: true, force: true });
	}
});
