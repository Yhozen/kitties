import { expect, test } from "@playwright/test";

test("chat streams a durable turn and feedback changes kitty memory once", async ({
  page,
  request,
  baseURL,
}) => {
  const tag = crypto.randomUUID().slice(0, 8);
  const kittyResponse = await request.post("/v1/kitties", {
    headers: { Origin: baseURL! },
    data: { name: `Chat ${tag}`, soul: "Be helpful", providerId: "scripted" },
  });
  expect(kittyResponse.ok()).toBeTruthy();
  const kitty = await kittyResponse.json();
  const chatResponse = await request.post("/v1/chats", {
    headers: { Origin: baseURL! },
    data: { title: `Thread ${tag}`, members: [kitty.id] },
  });
  const chat = await chatResponse.json();
  await page.goto("/");
  await page.getByRole("button", { name: chat.title, exact: true }).click();
  await page.getByRole("textbox", { name: "Mensaje", exact: true }).fill(`remember ${tag}`);
  await page.getByRole("button", { name: "Enviar ↑" }).click();
  await expect(page.locator(".next-answer")).toContainText(`Hola, remember ${tag}`);
  await expect(page.getByRole("button", { name: "Me ayudó", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Me ayudó", exact: true }).click();
  await page.getByRole("button", { name: "Me ayudó", exact: true }).click();
  await expect
    .poll(
      async () => (await (await request.get(`/v1/kitties/${kitty.id}/memory`)).json()).profile.up,
    )
    .toBe(1);
  const detail = await (await request.get(`/v1/chats/${chat.id}`)).json();
  expect(detail.messages).toHaveLength(1);
  const message = detail.messages[0];
  const duplicate = await request.post(`/v1/chats/${chat.id}/messages`, {
    headers: { Origin: baseURL! },
    data: message.payload,
  });
  expect(duplicate.status()).toBe(202);
  expect((await duplicate.json()).duplicate).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: chat.title, exact: true }).click();
  await expect(page.locator(".next-turn")).toHaveCount(1);
  await expect(page.locator(".next-answer")).toContainText(`Hola, remember ${tag}`);
});

test("owner data stays private and cross-origin writes are rejected", async ({
  request,
  baseURL,
}) => {
  const id = crypto.randomUUID();
  const saved = await request.put(`/v1/vault/${id}`, {
    headers: { Origin: baseURL! },
    data: { name: "Private account", value: `secret-${id}` },
  });
  expect(saved.ok()).toBeTruthy();
  const listing = await request.get("/v1/vault");
  const values = await listing.text();
  expect(values).toContain("Private account");
  expect(values).not.toContain(`secret-${id}`);
  const denied = await request.put(`/v1/vault/${id}`, {
    headers: { Origin: "https://evil.example.com" },
    data: { name: "Changed", value: "bad" },
  });
  expect(denied.status()).toBe(403);
  const connection = await request.put(`/v1/connections/${id}`, {
    headers: { Origin: baseURL! },
    data: {
      name: "Scoped service",
      kind: "mcp",
      url: "https://example.com/mcp",
      token: `bearer-${id}`,
      allowReads: false,
    },
  });
  expect(connection.ok()).toBeTruthy();
  expect(await connection.text()).not.toContain(`bearer-${id}`);
  expect(await (await request.get("/v1/connections")).text()).not.toContain(`bearer-${id}`);
  await request.delete(`/v1/vault/${id}`, { headers: { Origin: baseURL! } });
  await request.delete(`/v1/connections/${id}`, { headers: { Origin: baseURL! } });
});
