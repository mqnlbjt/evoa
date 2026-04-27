import { describe, expect, it } from "vitest";
import { discoverOpenAICompatibleModels } from "../src/models/discovery.js";

describe("discoverOpenAICompatibleModels", () => {
	it("calls /v1/models when baseURL already ends with /v1", async () => {
		let capturedUrl = "";
		const models = await discoverOpenAICompatibleModels({
			providerId: "local",
			baseURL: "http://localhost:8317/v1",
			fetchFn: async (input) => {
				capturedUrl = String(input);
				return modelsResponse([{ id: "gpt-5.4-mini", object: "model", created: 123, owned_by: "local" }]);
			},
		});

		expect(capturedUrl).toBe("http://localhost:8317/v1/models");
		expect(models).toEqual([
			expect.objectContaining({
				id: "gpt-5.4-mini",
				providerId: "local",
				format: "openai-responses",
				baseURL: "http://localhost:8317/v1",
			}),
		]);
		expect(models[0]?.metadata).toMatchObject({ created: 123, ownedBy: "local" });
	});

	it("appends /v1/models when baseURL has no version path", async () => {
		let capturedUrl = "";
		await discoverOpenAICompatibleModels({
			providerId: "local",
			baseURL: "http://localhost:8317",
			fetchFn: async (input) => {
				capturedUrl = String(input);
				return modelsResponse([{ id: "gpt-5.4-mini" }]);
			},
		});

		expect(capturedUrl).toBe("http://localhost:8317/v1/models");
	});

	it("does not append duplicate models path", async () => {
		let capturedUrl = "";
		const models = await discoverOpenAICompatibleModels({
			providerId: "local",
			baseURL: "http://localhost:8317/v1/models",
			fetchFn: async (input) => {
				capturedUrl = String(input);
				return modelsResponse([{ id: "gpt-5.4-mini" }]);
			},
		});

		expect(capturedUrl).toBe("http://localhost:8317/v1/models");
		expect(models[0]?.baseURL).toBe("http://localhost:8317/v1");
	});

	it("sends api key and custom headers", async () => {
		let capturedInit: RequestInit | undefined;
		await discoverOpenAICompatibleModels({
			providerId: "local",
			baseURL: "http://localhost:8317/v1/",
			apiKey: "12345678",
			headers: { "x-provider": "local" },
			fetchFn: async (_input, init) => {
				capturedInit = init;
				return modelsResponse([{ id: "gpt-5.4-mini" }]);
			},
		});

		expect(capturedInit?.headers).toMatchObject({
			accept: "application/json",
			authorization: "Bearer 12345678",
			"x-provider": "local",
		});
	});

	it("rejects malformed responses without a data array", async () => {
		await expect(
			discoverOpenAICompatibleModels({
				providerId: "local",
				baseURL: "http://localhost:8317/v1",
				fetchFn: async () => new Response(JSON.stringify({ object: "list" }), { status: 200 }),
			}),
		).rejects.toThrow("data array");
	});

	it("rejects model entries without string ids", async () => {
		await expect(
			discoverOpenAICompatibleModels({
				providerId: "local",
				baseURL: "http://localhost:8317/v1",
				fetchFn: async () => modelsResponse([{ object: "model" }]),
			}),
		).rejects.toThrow("string id");
	});

	it("surfaces provider error messages", async () => {
		await expect(
			discoverOpenAICompatibleModels({
				providerId: "local",
				baseURL: "http://localhost:8317/v1",
				fetchFn: async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
			}),
		).rejects.toThrow("bad key");
	});
});

function modelsResponse(data: unknown[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}
