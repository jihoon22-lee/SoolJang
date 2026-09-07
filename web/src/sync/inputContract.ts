/** 온라인 스키마와 같은 숫자 경계. 빈 값(null)과 0을 분리한다. */
import Decimal from "decimal.js";
export type NumericField =
  | "quantity"
  | "volume_ml"
  | "abv"
  | "price"
  | "personal_rating"
  | "poured_ml"
  | "tasting_rating";
export function validNumericInput(field: NumericField, value: unknown): boolean {
  if (value === null || value === "") return !["quantity", "volume_ml"].includes(field);
  if (typeof value !== "number" && typeof value !== "string") return false;
  try {
    const number = new Decimal(value);
    if (!number.isFinite()) return false;
    switch (field) {
      case "quantity":
        return number.isInteger() && number.greaterThan(0) && number.lessThanOrEqualTo(1000);
      case "volume_ml":
        return number.isInteger() && number.greaterThan(0) && number.lessThanOrEqualTo(100000);
      case "poured_ml":
        return number.isInteger() && number.greaterThan(0);
      case "abv":
        return number.greaterThanOrEqualTo(0) && number.lessThanOrEqualTo(100);
      case "price":
        return number.greaterThanOrEqualTo(0);
      case "personal_rating":
        return number.greaterThan(0) && number.lessThanOrEqualTo(6);
      case "tasting_rating":
        return (
          number.greaterThanOrEqualTo(0) &&
          number.lessThanOrEqualTo(6) &&
          number.times(2).isInteger()
        );
    }
  } catch {
    return false;
  }
}
