import { describe, expect, it } from "vitest";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { ConnectCredentialParamsSchema } from "@vibestudio/service-schemas/credentials";
import {
  listProviderConnectPresets,
  modelIsConnectable,
  toCredentialConnectRequest as toSharedCredentialConnectRequest,
  toPanelConnectRequest,
} from "@vibestudio/shared/providerConnect";

import { toCredentialConnectRequest } from "./providerConnect";

describe("provider connect presets", () => {
  it("builds a schema-valid OpenAI Codex external-browser credential request", () => {
    const request = toCredentialConnectRequest("openai-codex", { browser: "external" });

    expect(request).toMatchObject({
      flow: { type: "oauth2-auth-code-pkce", persistRefreshToken: true },
      credential: {
        label: "ChatGPT Codex model credential",
        audience: [{ url: "https://chatgpt.com/backend-api", match: "path-prefix" }],
        metadata: {
          modelProviderId: "openai-codex",
          accountIdentityJwtClaimRoot: "https://api.openai.com/auth",
          accountIdentityJwtClaimField: "chatgpt_account_id",
        },
      },
      redirect: {
        type: "client-loopback",
        host: "localhost",
        port: 1455,
        callbackPath: "/auth/callback",
      },
      browser: "external",
    });
    expect(() => ConnectCredentialParamsSchema.parse(request)).not.toThrow();
  });

  it("uses the in-process loopback redirect for internal OAuth", () => {
    const request = toCredentialConnectRequest("openai-codex", { browser: "internal" });

    expect(request?.redirect).toMatchObject({
      type: "loopback",
      host: "localhost",
      port: 1455,
      callbackPath: "/auth/callback",
    });
    expect(request?.browser).toBe("internal");
  });

  it("defaults panel OAuth to the system browser while preserving an explicit workspace browser", () => {
    expect(toPanelConnectRequest("openai-codex")).toMatchObject({
      browser: "external",
      redirect: { type: "client-loopback" },
    });
    expect(toPanelConnectRequest("openai-codex", { browser: "internal" })).toMatchObject({
      browser: "internal",
      redirect: { type: "loopback" },
    });
  });

  it("exports the presets from the shared package path", () => {
    expect(toSharedCredentialConnectRequest("openai")?.credential.label).toBe("OpenAI API key");
  });

  it("keeps every provider preset schema-valid", () => {
    for (const preset of listProviderConnectPresets()) {
      const request = toCredentialConnectRequest(preset.providerId, { browser: "external" });
      expect(
        ConnectCredentialParamsSchema.safeParse(request),
        `${preset.providerId} connect request`
      ).toMatchObject({ success: true });
    }
  });

  it("binds every built-in model base URL to its provider credential audience", () => {
    for (const preset of listProviderConnectPresets()) {
      const models = getBuiltinModels(preset.providerId as never) as Array<{
        id: string;
        baseUrl: string;
      }>;
      expect(models.length, `${preset.providerId} has no built-in models`).toBeGreaterThan(0);
      for (const model of models) {
        expect(
          modelIsConnectable(preset.providerId, model.baseUrl),
          `${preset.providerId}:${model.id} base URL ${model.baseUrl}`
        ).toBe(true);
      }
    }
  });
});
