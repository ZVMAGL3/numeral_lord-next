import { describe, expect, it } from "vitest";
import { paginate } from "./list-pagination.js";

describe("paginate", () => {
  const entries = Array.from({ length: 25 }, (_, index) => index + 1);

  it("returns the requested slice and page metadata", () => {
    expect(paginate(entries, 2, 10)).toEqual({
      items: entries.slice(10, 20), currentPage: 2, pageCount: 3, totalItems: 25, pageSize: 10
    });
  });

  it("clamps an out-of-range page when a list shrinks", () => {
    expect(paginate(entries.slice(0, 11), 9, 10)).toMatchObject({ items: [11], currentPage: 2, pageCount: 2 });
  });

  it("returns a stable empty page and normalizes invalid sizes", () => {
    expect(paginate([], 0, 0)).toMatchObject({ items: [], currentPage: 1, pageCount: 1, totalItems: 0, pageSize: 1 });
  });
});
