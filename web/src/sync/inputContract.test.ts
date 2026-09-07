import { expect, it } from "vitest";
import { type NumericField, validNumericInput } from "@/sync/inputContract";
import fixture from "../../../tests/fixtures/sync_input_contract.json";

it.each(fixture)("온라인 스키마와 같은 $field=$value 경계", ({ field, value, valid }) => {
  expect(validNumericInput(field as NumericField, value)).toBe(valid);
});
