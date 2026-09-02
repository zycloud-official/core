import { describe, it, expect, vi, beforeEach } from "vitest";

// Each test gets a fresh caprover module so the token cache is reset.
// We also stub fetch before each import so the module's top-level constants
// (BASE, PASSWORD) are read with the correct env values from vitest.config.js.

function mockLoginResponse(token = "captain-token") {
  return { ok: true, text: async () => JSON.stringify({ data: { token } }) };
}

function mockApiResponse(data) {
  return { ok: true, text: async () => JSON.stringify({ data }) };
}

function mockErrorResponse(status = 500, body = {}) {
  return { ok: false, status, text: async () => JSON.stringify(body) };
}

let caprover;
let fetchMock;

beforeEach(async () => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  caprover = await import("../src/caprover.js");
});

describe("getAppDefinition", () => {
  it("returns null when app list is empty", async () => {
    fetchMock
      .mockResolvedValueOnce(mockLoginResponse())
      .mockResolvedValueOnce(mockApiResponse({ appDefinitions: [] }));

    expect(await caprover.getAppDefinition("myapp")).toBeNull();
  });

  it("returns the full app object when found", async () => {
    const appDef = { appName: "myapp", hasDefaultSubDomainSsl: false };
    fetchMock
      .mockResolvedValueOnce(mockLoginResponse())
      .mockResolvedValueOnce(
        mockApiResponse({ appDefinitions: [appDef, { appName: "other" }] })
      );

    const result = await caprover.getAppDefinition("myapp");
    expect(result).toEqual(appDef);
  });

  it("returns the ssl status on the definition", async () => {
    const appDef = { appName: "myapp", hasDefaultSubDomainSsl: true };
    fetchMock
      .mockResolvedValueOnce(mockLoginResponse())
      .mockResolvedValueOnce(mockApiResponse({ appDefinitions: [appDef] }));

    const result = await caprover.getAppDefinition("myapp");
    expect(result?.hasDefaultSubDomainSsl).toBe(true);
  });
});

describe("token caching", () => {
  it("logs in only once for multiple API calls within 50 minutes", async () => {
    fetchMock.mockResolvedValue(
      mockApiResponse({ token: "cached-token", appDefinitions: [] })
    );
    // Override first call to be a real login response
    fetchMock
      .mockResolvedValueOnce(mockLoginResponse("cached-token"))
      .mockResolvedValue(mockApiResponse({ appDefinitions: [] }));

    await caprover.getAppDefinition("app1");
    await caprover.getAppDefinition("app2");

    const loginCalls = fetchMock.mock.calls.filter((c) =>
      c[0].includes("/api/v2/login")
    );
    expect(loginCalls).toHaveLength(1);
  });

  it("re-authenticates after the token expires (50 min)", async () => {
    vi.useFakeTimers();

    fetchMock
      .mockResolvedValueOnce(mockLoginResponse("token-1"))
      .mockResolvedValueOnce(mockApiResponse({ appDefinitions: [] }))
      .mockResolvedValueOnce(mockLoginResponse("token-2"))
      .mockResolvedValueOnce(mockApiResponse({ appDefinitions: [] }));

    await caprover.getAppDefinition("app1");
    vi.advanceTimersByTime(51 * 60 * 1000); // advance 51 minutes
    await caprover.getAppDefinition("app2");

    const loginCalls = fetchMock.mock.calls.filter((c) =>
      c[0].includes("/api/v2/login")
    );
    expect(loginCalls).toHaveLength(2);

    vi.useRealTimers();
  });
});

describe("uploadTarball", () => {
  it("sends a multipart POST with the correct headers", async () => {
    fetchMock
      .mockResolvedValueOnce(mockLoginResponse())
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    await caprover.uploadTarball("myapp", Buffer.from("fake-tarball"));

    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toContain("/user/apps/appData/myapp");
    expect(url).toContain("detached=1");
    expect(opts.method).toBe("POST");
    expect(opts.headers["x-captain-auth"]).toBe("captain-token");
    expect(opts.body).toBeInstanceOf(FormData);
  });
});

describe("createApp", () => {
  it("POSTs to appDefinitions with the correct app name", async () => {
    fetchMock
      .mockResolvedValueOnce(mockLoginResponse())
      .mockResolvedValueOnce({ ok: true, text: async () => "{}" });

    await caprover.createApp("alice-myrepo");

    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toContain("/user/apps/appDefinitions/register");
    expect(JSON.parse(opts.body).appName).toBe("alice-myrepo");
  });
});

describe("enableSsl", () => {
  it("only enables the base-domain SSL cert, nothing else", async () => {
    fetchMock
      .mockResolvedValueOnce(mockLoginResponse())
      .mockResolvedValueOnce({ ok: true, text: async () => "{}" });

    await caprover.enableSsl("alice-myrepo");

    expect(fetchMock).toHaveBeenCalledTimes(2); // login + this call only
    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toContain("/user/apps/appDefinitions/enablebasedomainssl");
    expect(JSON.parse(opts.body).appName).toBe("alice-myrepo");
  });
});

describe("updateAppDefinition", () => {
  it("sends the containerHttpPort and envVars in the update body", async () => {
    fetchMock
      .mockResolvedValueOnce(mockLoginResponse())
      .mockResolvedValueOnce({ ok: true, text: async () => "{}" });

    await caprover.updateAppDefinition("alice-myrepo", {
      containerHttpPort: 3000,
      envVars: [{ key: "NODE_ENV", value: "production" }],
    });

    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toContain("/user/apps/appDefinitions/update");
    const body = JSON.parse(opts.body);
    expect(body.appName).toBe("alice-myrepo");
    expect(body.containerHttpPort).toBe(3000);
    expect(body.envVars).toEqual([{ key: "NODE_ENV", value: "production" }]);
    expect(body.forceSsl).toBe(true);
  });

  it("defaults envVars to an empty array", async () => {
    fetchMock
      .mockResolvedValueOnce(mockLoginResponse())
      .mockResolvedValueOnce({ ok: true, text: async () => "{}" });

    await caprover.updateAppDefinition("alice-myrepo", { containerHttpPort: 80 });

    const [, opts] = fetchMock.mock.calls[1];
    expect(JSON.parse(opts.body).envVars).toEqual([]);
  });
});

describe("transient CapRover errors", () => {
  it("retries a 429 with backoff and succeeds", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(mockLoginResponse())
      .mockResolvedValueOnce(mockErrorResponse(429, { description: "busy" }))
      .mockResolvedValueOnce(mockApiResponse({ appDefinitions: [] }));

    const promise = caprover.getAppDefinition("myapp");
    await vi.advanceTimersByTimeAsync(3000);
    expect(await promise).toBeNull();

    vi.useRealTimers();
  });

  it("throws with the response body after exhausting retries", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(mockLoginResponse())
      .mockResolvedValue(mockErrorResponse(429, { description: "still busy" }));

    const promise = caprover.getAppDefinition("myapp");
    const assertion = expect(promise).rejects.toThrow(/still busy/);
    await vi.advanceTimersByTimeAsync(3000 + 6000);
    await assertion;

    vi.useRealTimers();
  });

  it("does not retry a non-retryable status", async () => {
    fetchMock
      .mockResolvedValueOnce(mockLoginResponse())
      .mockResolvedValueOnce(mockErrorResponse(401, { description: "bad token" }));

    await expect(caprover.getAppDefinition("myapp")).rejects.toThrow(/bad token/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // login + the single failed call
  });

  it("throws a descriptive error when the response shape is unexpected", async () => {
    fetchMock
      .mockResolvedValueOnce(mockLoginResponse())
      .mockResolvedValueOnce(mockApiResponse(undefined));

    await expect(caprover.getAppDefinition("myapp")).rejects.toThrow(/unexpected appDefinitions/);
  });
});
