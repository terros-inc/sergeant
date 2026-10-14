import { expect, test } from "vitest";
import { fakeApi, sgt } from "./fake-api.ts";

test("stops prints each rubric rule's replies and how often they followed the recommendation", async () => {
  const rules = [
    { rule: "2", call: "extend", asked: 5, unanswered: 1, extend: 3, stop: 0, other: 1, followed: 3 },
    { rule: "3", call: "ask", asked: 2, unanswered: 0, extend: 1, stop: 1, other: 0, followed: 0 },
  ];
  const { api } = await fakeApi({ "GET /v1/stops": { json: { rules, stops: [] } } });
  const { code, out } = await sgt(api, "stops");
  expect(code).toBe(0);
  expect(out).toContain("rule 2  extend  5 asked  1 unanswered  extend 3  stop 0  other 1  followed 3/4 (75%)");
  expect(out).toContain("rule 3  ask     2 asked  0 unanswered  extend 1  stop 1  other 0  followed -");
});
