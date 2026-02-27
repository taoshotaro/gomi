import { describe, expect, test } from "bun:test";
import { parseCollectionDaysForTest } from "../convert/run.js";

describe("convert collection day parsing", () => {
  test("parses weekly japanese day expressions", () => {
    expect(parseCollectionDaysForTest("火・金")).toEqual({
      type: "weekly",
      days: ["tuesday", "friday"],
    });
  });

  test("parses monthly japanese day expressions", () => {
    expect(parseCollectionDaysForTest("第２木・第４木")).toEqual({
      type: "monthly",
      pattern: [
        { week: 2, day: "thursday" },
        { week: 4, day: "thursday" },
      ],
    });
  });
});
